/**
 * realtime.gateway.ts
 * Gateway Socket.IO de NestJS. Comparte el puerto HTTP (8080) con la app.
 * - Auth en el handshake (portado del io.use de Fase 1): sin ID token válido, no hay conexión.
 * - Eventos migrados del monolito (se van agregando por grupos). Empezamos con user-connected.
 * El valor retornado por cada @SubscribeMessage se envía como ACK al cliente (emitWithAck).
 */

import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import * as admin from 'firebase-admin';
import { v4 as uuidv4 } from 'uuid';
import { FirebaseService } from '../firebase/firebase.service';
import { NotificationsService } from '../notifications/notifications.service';
import { StateStore, publicUserData } from './state.store';
import { EmergencyService } from './emergency.service';
import { EmergencyRecoveryService } from './emergency-recovery.service';
import { EmergencyPushService } from './emergency-push.service';
// size-exception: gateway legacy; recuperación y envío nuevos se extraen a servicios separados.
import { isDataUrl, isHttpUrl } from '../common/image-utils';
import { omit } from '../common/omit';
import { corsOrigins } from '../common/cors';
import { SocketThrottle, RATE_LIMITED_ACK } from '../common/socket-throttle';
import { isValidLat, isValidLng, isBoundedString, MAX_TEXT_MESSAGE } from '../common/validate';
import { StorageService } from '../common/storage.service';
import { AuditService } from '../common/audit.service';
import { UseInterceptors } from '@nestjs/common';
import { LoggingInterceptor } from '../common/logging.interceptor';

@WebSocketGateway({
  cors: { origin: corsOrigins(), methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  // El default de socket.io es 1 MB por mensaje: un audio de ~45 s en base64 lo superaba y
  // el servidor CORTABA la conexión de quien lo mandaba (en plena emergencia). 8 MB cubre
  // con margen los 2 minutos que permite la app.
  maxHttpBufferSize: 8 * 1024 * 1024,
})
@Injectable()
// El interceptor global (APP_INTERCEPTOR) NO alcanza a los gateways: acá va explícito
// para que cada evento de socket quede logueado (auditoría de punta a punta).
@UseInterceptors(LoggingInterceptor)
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy, OnApplicationBootstrap {
  @WebSocketServer() server: Server;

  private readonly logger = new Logger(RealtimeGateway.name);

  /** Revisión periódica de emergencias abandonadas (ver EmergencyService.IDLE_TTL_MS). */
  private sweepTimer: NodeJS.Timeout | null = null;

  /**
   * Las operaciones "best-effort" (persistencia secundaria que no debe romper el flujo de
   * vida del evento) ahora se LOGUEAN (D2): antes fallaban en silencio y nadie se enteraba
   * de cuotas/permisos/red rotos. El flujo del evento sigue sin romperse.
   */
  private bestEffort(op: string, e: unknown): void {
    this.logger.warn(`best-effort falló [${op}]: ${(e as Error)?.message ?? e}`);
  }

  /**
   * Flag de apagado: durante un shutdown ordenado los sockets se desconectan en masa,
   * pero eso NO significa que las víctimas "se fueron" — sin este flag, un simple deploy
   * limpiaría todas las emergencias activas (que la Fase E justamente quiere preservar).
   */
  private shuttingDown = false;

  /** Cierre ordenado (D3): al apagar la app se cierran las conexiones Socket.IO. */
  onModuleDestroy(): void {
    this.shuttingDown = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    try {
      this.server?.close();
    } catch (e) {
      this.bestEffort('shutdown.server.close', e);
    }
  }

  constructor(
    private readonly state: StateStore,
    private readonly firebase: FirebaseService,
    private readonly notifications: NotificationsService,
    private readonly emergency: EmergencyService,
    private readonly throttle: SocketThrottle,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly recovery: EmergencyRecoveryService,
    private readonly emergencyPush: EmergencyPushService,
  ) {}

  afterInit(server: Server): void {
    // Auth en el handshake (equivalente al io.use del monolito, Fase 1).
    server.use(async (socket: Socket, next: (err?: Error) => void) => {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('No autenticado: falta token'));
      try {
        (socket as any).user = await this.firebase.auth.verifyIdToken(token);
        return next();
      } catch {
        return next(new Error('Token inválido'));
      }
    });

  }

  /**
   * E2: rehidratar emergencias activas desde Firestore ANTES de aceptar tráfico (corre
   * después de todos los onModuleInit — Firebase ya está inicializado — y antes del listen).
   * Antes, un restart del server durante un robo hacía "desaparecer" la emergencia.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.rehydrateEmergencies();
    await this.emergency.loadRecent();
    this.sweepTimer = setInterval(() => { void this.sweepExpired(); }, this.emergency.SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  /**
   * Todo socket autenticado entra a la sala con su propio uid. Los avisos dirigidos a una
   * persona (`server.to(uid)`: confirmación/rechazo de ayuda, limpieza, ubicaciones) dependen
   * de esto; antes nadie entraba a esa sala y esos avisos no le llegaban a nadie.
   */
  handleConnection(socket: Socket): void {
    const uid = (socket as any).user?.uid;
    if (uid) socket.join(String(uid));
  }

  /** Cierra las emergencias cuya víctima no da señales hace más del tiempo máximo. */
  private async sweepExpired(): Promise<void> {
    if (this.shuttingDown) return;
    for (const userId of this.emergency.expiredOwners()) {
      try {
        await this.emergency.runExclusive(userId, async () => {
          if (!this.emergency.expiredOwners().includes(userId)) return;
          this.logger.warn(`Emergencia de ${userId} vencida por inactividad`);
          await this.endEmergency(userId, 'expired');
        });
      } catch (e) {
        this.bestEffort('sweepExpired', e);
      }
    }
  }

  /**
   * Reconstruye el estado de emergencias activas (alerts, helpers, salas) desde el espejo
   * en Firestore (colección `emergencies`, isActive=true). El StateStore sigue siendo la
   * verdad en runtime (single-instance, documentado en ARQUITECTURA.md); Firestore es el
   * respaldo para sobrevivir restarts. El lock global ya vivía en Firestore.
   */
  private async rehydrateEmergencies(): Promise<void> {
    try {
      const snap = await this.firebase.firestore.collection('emergencies').where('isActive', '==', true).get();
      let count = 0;
      for (const doc of snap.docs) {
        const data = doc.data() || {};
        const userId = doc.id;
        const emergencyRoomId = data.emergencyRoomId || `emergencia_${userId}`;
        // Tras un reinicio la víctima tiene al menos 10 minutos para volver a dar señales
        // antes de que la emergencia pueda vencer por inactividad.
        const graceFloor = Date.now() - this.emergency.IDLE_TTL_MS + 10 * 60 * 1000;
        const lastActivityAt = Math.max(
          Number(data.lastActivityAt) || 0, Number(data.lastLocationUpdate) || 0, Number(data.timestamp) || 0, graceFloor,
        );
        const alertData = omit(data, 'helpers', 'declined', 'isActive');
        this.state.emergencyAlerts.set(userId, {
          ...alertData, userId, lastActivityAt,
          emergencyId: data.emergencyId || `${userId}_${data.timestamp || data.createdAt || 0}`,
          helperNames: data.helperNames && typeof data.helperNames === 'object' ? data.helperNames : {},
        });
        this.state.emergencyHelpers.set(userId, new Set<string>(Array.isArray(data.helpers) ? data.helpers : []));
        this.state.emergencyDeclined.set(userId, new Set<string>(Array.isArray(data.declined) ? data.declined : []));
        this.state.emergencyUserRoom.set(userId, emergencyRoomId);
        if (!this.state.chatRooms.has(emergencyRoomId)) {
          this.state.chatRooms.set(emergencyRoomId, {
            id: emergencyRoomId,
            name: `Emergencia ${data.userName || userId}`,
            type: 'emergency',
            description: `Sala de emergencia para ${data.userName || userId}`,
            users: new Set<string>([userId]),
            createdAt: typeof data.createdAt === 'number' ? data.createdAt : Date.now(),
            messageCount: 0,
          });
        }
        count++;
      }
      if (count > 0) {
        this.logger.warn(`⛑️ Rehidratadas ${count} emergencia(s) ACTIVA(s) desde Firestore (restart con emergencia en curso)`);
      }
    } catch (e) {
      this.bestEffort('rehydrate.emergencies', e);
    }
  }

  /**
   * Autorización por-usuario en sockets: el id "propio" del evento (id/userId/helperId) debe
   * coincidir con el uid del token del handshake. Cierra el spoofing de identidad heredado del
   * prototipo (el server confiaba en el userId del payload). El admin queda exento.
   * Se invoca SOLO después de validar que el campo está presente (para preservar los acks de
   * "datos inválidos" cuando el id falta).
   */
  private notSelf(socket: Socket, claimedId: string | undefined): boolean {
    const uid = (socket as any).user?.uid;
    const isAdmin = (socket as any).user?.role === 'admin';
    if (isAdmin) return false;
    return !claimedId || claimedId !== uid;
  }
  private readonly FORBIDDEN_ACK = { success: false, message: 'No autorizado: el identificador no coincide con tu sesión' };

  /** Emite la lista de usuarios de una sala (equivalente a utils.updateRoomUserList). */
  private updateRoomUserList(roomId: string): void {
    const room = this.state.chatRooms.get(roomId);
    if (!room) return;
    const usersInRoom = this.usersInRoom(room);
    this.server.to(roomId).emit('room_users_updated', {
      roomId,
      users: usersInRoom,
      userCount: usersInRoom.length,
    });
  }

  /** ¿Alguno de los sockets del usuario está en la sala? (equivalente a utils.isUserPresentInRoom). */
  private isUserPresentInRoom(userId: string, roomId: string): boolean {
    const entry = this.state.connectedUsers.get(userId);
    if (!entry) return false;
    const room = this.server.sockets.adapter.rooms.get(roomId);
    if (!room) return false;
    for (const sid of entry.sockets) {
      if (room.has(sid)) return true;
    }
    return false;
  }

  /** Usuarios con al menos una conexión viva (payload del evento connected_users). */
  private onlineUsers(): Record<string, any>[] {
    return Array.from(this.state.connectedUsers.values())
      .filter((u) => u.sockets.size > 0)
      .map((u) => ({ ...publicUserData(u.userData), socketCount: u.sockets.size, currentRoom: u.userData.currentRoom || 'general' }));
  }

  /**
   * A quiénes hay que avisarles por push de un mensaje en la sala si no lo están viendo.
   * En una sala de emergencia son su dueño y sus ayudantes, ESTÉN O NO conectados (la lista
   * `room.users` solo tiene a los conectados, y justamente el que tiene el teléfono bloqueado
   * es el que necesita el push).
   */
  private roomParticipants(roomId: string): string[] {
    if (String(roomId).startsWith('emergencia_')) {
      const owner = String(roomId).replace('emergencia_', '');
      return [...new Set([owner, ...(this.state.emergencyHelpers.get(owner) || [])])];
    }
    return Array.from(this.state.chatRooms.get(roomId)?.users || []);
  }

  /** Miembros de una sala que están conectados ahora, con sus datos públicos. */
  private usersInRoom(room: { users: Set<string> }): Record<string, any>[] {
    return Array.from(room.users)
      .map((uid) => this.state.connectedUsers.get(uid))
      .filter((u): u is NonNullable<typeof u> => !!u && u.sockets.size > 0)
      .map((u) => publicUserData(u.userData));
  }

  /** uids con state=approved: los únicos que reciben datos de emergencias ajenas. */
  private async approvedUserIds(): Promise<Set<string>> {
    try {
      const snap = await this.firebase.firestore.collection('users').where('state', '==', 'approved').get();
      this.lastApproved = new Set<string>(snap.docs.map((d) => d.id));
      return this.lastApproved;
    } catch (e) {
      // Si Firestore falla justo cuando alguien pide ayuda, se avisa a los últimos aprobados
      // conocidos: es preferible a que el SOS no salga.
      if (this.lastApproved) {
        this.logger.error(`No se pudo leer aprobados (${(e as Error).message}); uso la última lista conocida`);
        return this.lastApproved;
      }
      throw e;
    }
  }
  private lastApproved: Set<string> | null = null;

  /** Emite a cada socket de un usuario aprobado, salvo a los de `exceptUserId`. */
  private emitToApproved(approved: Set<string>, exceptUserId: string | null, event: string, payload: unknown) {
    let sent = 0;
    let sinIdentidad = 0;
    let noAprobados = 0;
    for (const [sid, s] of this.server.sockets.sockets) {
      const target = (s as any).userId || (s as any).user?.uid;
      if (!target) { sinIdentidad++; continue; }
      if (target === exceptUserId) continue;
      if (!approved.has(target)) { noAprobados++; continue; }
      this.server.to(sid).emit(event, payload);
      sent++;
    }
    return { sent, sinIdentidad, noAprobados };
  }

  /** Avisa a los aprobados que cambió quién atiende una emergencia (lista de la pantalla principal). */
  private async broadcastEmergencyUpdate(ownerId: string): Promise<void> {
    const alert = this.state.emergencyAlerts.get(ownerId);
    if (!alert) return;
    try {
      const helpersInfo = this.emergency.helpersInfo(ownerId);
      const payload = {
        userId: ownerId, emergencyId: alert.emergencyId, helpers: helpersInfo, helpersInfo,
        helpersCount: helpersInfo.length, timestamp: Date.now(),
      };
      // El dueño lo recibe siempre (aunque no esté aprobado), y una sola vez.
      this.server.to(ownerId).emit('emergency_updated', payload);
      this.emitToApproved(await this.approvedUserIds(), ownerId, 'emergency_updated', payload);
    } catch (e) {
      this.bestEffort('emergency_updated', e);
    }
  }

  /** Mete al socket en las salas de emergencia que le corresponden: la propia y las que ayuda. */
  private rejoinEmergencyRooms(socket: Socket, userId: string): void {
    for (const owner of this.state.emergencyAlerts.keys()) {
      if (owner !== userId && !this.state.emergencyHelpers.get(owner)?.has(userId)) continue;
      const roomId = this.state.emergencyUserRoom.get(owner) || `emergencia_${owner}`;
      const room = this.state.chatRooms.get(roomId);
      if (!room) continue;
      socket.join(roomId);
      room.users.add(userId);
      this.updateRoomUserList(roomId);
    }
  }

  /**
   * ¿Puede este usuario entrar a la sala? Las públicas son abiertas; una sala de emergencia es
   * para su dueño, sus ayudantes y los usuarios aprobados.
   */
  private async canAccessRoom(userId: string, roomId: string): Promise<boolean> {
    if (!String(roomId).startsWith('emergencia_')) return true;
    const owner = String(roomId).replace('emergencia_', '');
    if (owner === userId || this.state.emergencyHelpers.get(owner)?.has(userId)) return true;
    try {
      return await this.recovery.isApproved(userId);
    } catch (e) {
      this.bestEffort('canAccessRoom', e);
      return false;
    }
  }

  /**
   * Para escribir en una sala de emergencia hay que ser miembro. Si el socket todavía no entró
   * (reconexión, cliente viejo) y tiene derecho, se lo mete en el momento; si no, se rechaza.
   * Las salas públicas no cambian. Además cuenta como señal de vida de la víctima.
   */
  private async ensureEmergencyRoomMember(socket: Socket, userId: string, roomId: string): Promise<boolean> {
    if (!String(roomId).startsWith('emergencia_')) return true;
    if (roomId === `emergencia_${userId}`) this.emergency.touch(userId);
    if (socket.rooms.has(roomId)) return true;
    if (!(await this.canAccessRoom(userId, roomId))) return false;
    socket.join(roomId);
    this.state.chatRooms.get(roomId)?.users.add(userId);
    this.updateRoomUserList(roomId);
    return true;
  }

  @SubscribeMessage('sync_emergencies')
  async syncEmergencies(@ConnectedSocket() socket: Socket) {
    if (!this.throttle.allow(socket.id, 'sync_emergencies')) return RATE_LIMITED_ACK;
    const uid = (socket as any).user.uid;
    this.emergency.touch(uid);
    return this.recovery.snapshot(uid);
  }

  @SubscribeMessage('user-connected')
  async userConnected(@ConnectedSocket() socket: Socket, @MessageBody() user: Record<string, any> = {}) {
    if (!user || !user.id) {
      return { success: false, message: '⚠️ Datos de usuario inválidos (id requerido)' };
    }
    const userId = String(user.id).trim();
    if (!userId) return { success: false, message: '⚠️ userId vacío' };
    if (this.notSelf(socket, userId)) return this.FORBIDDEN_ACK;

   const safeUsername =
  (typeof user.username === 'string' && user.username.trim()) ||
  (typeof user.email === 'string' && user.email.split('@')[0].trim()) ||
  'Usuario';

    (socket as any).userId = userId;
    (socket as any).username = safeUsername;
    // App nueva: las salas de emergencia son aditivas (se puede estar en varias a la vez).
    (socket as any).multiRoom = user.multiRoom === true;

    const defaultRoom = 'general';
    socket.join(defaultRoom);
    (socket as any).currentRoom = defaultRoom;
    const generalRoom = this.state.chatRooms.get(defaultRoom);
    if (generalRoom) generalRoom.users.add(userId);

    const now = Date.now();
    const incomingLoc =
      typeof user.lat === 'number' && typeof user.lng === 'number'
        ? { lat: user.lat, lng: user.lng, ts: now }
        : undefined;

    const existing = this.state.connectedUsers.get(userId);
    if (existing) {
      existing.sockets.add(socket.id);
      existing.userData = {
        ...existing.userData,
        ...user,
        id: userId,
        username: safeUsername,
        isOnline: true,
        currentRoom: defaultRoom,
        lastKnownLocation: incomingLoc || existing.userData.lastKnownLocation,
      };
    } else {
      this.state.connectedUsers.set(userId, {
        userData: {
          ...user,
          id: userId,
          username: safeUsername,
          isOnline: true,
          currentRoom: defaultRoom,
          lastKnownLocation: incomingLoc,
        },
        sockets: new Set([socket.id]),
      });
    }

    try {
      const userRef = this.firebase.firestore.collection('users').doc(userId);
      const patch: Record<string, any> = {
        uid: userId,
        isOnline: true,
        lastLogin: now,
        currentRoom: defaultRoom,
        socketIds: admin.firestore.FieldValue.arrayUnion(socket.id),
        lastSeen: now,
        lastActive: now,
      };
      if (safeUsername && safeUsername.trim()) patch.username = safeUsername.trim();
      if (typeof user.email === 'string' && user.email.trim()) patch.email = user.email.trim();
      if (typeof user.fullName === 'string' && user.fullName.trim()) patch.fullName = user.fullName.trim();
      await userRef.set(patch, { merge: true });
    } catch (e) {
      // no romper la conexión si falla la sync con Firestore
      this.bestEffort('user-connected.syncFirestore', e);
    }

    this.emergency.touch(userId);
    this.rejoinEmergencyRooms(socket, userId);

    this.server.emit('connected_users', this.onlineUsers());

    socket.emit(
      'available_rooms',
      Array.from(this.state.chatRooms.values()).map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        description: r.description,
        userCount: r.users.size,
        messageCount: r.messageCount,
      })),
    );

    socket.emit('join_success', { room: defaultRoom, message: `Bienvenido al chat general, ${safeUsername}!` });
    socket.to(defaultRoom).emit('user_joined_room', {
      userId,
      username: safeUsername,
      roomId: defaultRoom,
      message: `${safeUsername} se unió a la sala`,
      timestamp: now,
    });

    this.updateRoomUserList(defaultRoom);

    return { success: true, userId, username: safeUsername };
  }

  @SubscribeMessage('join_room')
  async joinRoom(@ConnectedSocket() socket: Socket, @MessageBody() data: Record<string, any> = {}) {
    try {
      const { roomId } = data;
      const userId = data.userId || (socket as any).userId;
      if (!roomId || !userId) return { success: false, message: 'roomId y userId son requeridos' };
      if (data.userId && this.notSelf(socket, data.userId)) return this.FORBIDDEN_ACK;

      const targetRoom = this.state.chatRooms.get(roomId);
      if (!targetRoom) return { success: false, message: `Sala ${roomId} no encontrada` };
      if (!(await this.canAccessRoom(userId, roomId))) {
        return { success: false, code: 'ROOM_FORBIDDEN', message: 'No autorizado para esta sala' };
      }

      // App nueva (multiRoom): las salas de emergencia son aditivas. Entrar a una no saca de
      // ninguna otra, y pasar a una sala pública no saca de las de emergencia. Así se puede
      // ayudar en varios SOS a la vez y pedir ayuda mientras se ayuda. Sin el flag (beta4) se
      // conserva el comportamiento de "una sola sala actual".
      const isEmergencyRoom = (id?: string) => !!id && String(id).startsWith('emergencia_');
      const multi = (socket as any).multiRoom === true;
      const currentRoom = (socket as any).currentRoom;
      const keepPrevious = multi && (isEmergencyRoom(roomId) || isEmergencyRoom(currentRoom));
      const tracksCurrent = !(multi && isEmergencyRoom(roomId));
      if (currentRoom && currentRoom !== roomId && !keepPrevious) {
        const previousRoom = this.state.chatRooms.get(currentRoom);
        if (previousRoom) previousRoom.users.delete(userId);
        socket.leave(currentRoom);
        socket.to(currentRoom).emit('user_left_room', {
          userId, username: (socket as any).username, roomId: currentRoom,
          message: `${(socket as any).username} salió de la sala`, timestamp: Date.now(),
        });
        this.updateRoomUserList(currentRoom);
      }

      socket.join(roomId);
      targetRoom.users.add(userId);
      const entry = this.state.connectedUsers.get(userId);
      if (tracksCurrent) {
        (socket as any).currentRoom = roomId;
        if (entry) entry.userData.currentRoom = roomId;
      }

      await this.firebase.firestore.collection('users').doc(userId).set(
        {
          ...(tracksCurrent && { currentRoom: roomId }),
          lastActive: Date.now(), uid: userId, username: (socket as any).username || null,
        },
        { merge: true },
      );

      try {
        const snap = await this.firebase.firestore
          .collection('messages').where('roomId', '==', roomId)
          .orderBy('timestamp', 'desc').limit(50).get();
        const messages = snap.docs.map((d) => ({ id: d.id, ...d.data() })).reverse();
        socket.emit('room_messages', { roomId, messages });
      } catch (e) {
        // historial best-effort
        this.bestEffort('join_room.historial', e);
      }

      socket.to(roomId).emit('user_joined_room', {
        userId, username: (socket as any).username, roomId,
        message: `${(socket as any).username} se unió a la sala`, timestamp: Date.now(),
      });
      this.updateRoomUserList(roomId);

      return { success: true, roomId, message: `Unido a sala ${roomId}` };
    } catch {
      return { success: false, message: 'Error interno en join_room' };
    }
  }

  @SubscribeMessage('leave_room')
  async leaveRoom(@ConnectedSocket() socket: Socket, @MessageBody() data: Record<string, any> = {}) {
    try {
      const { roomId } = data;
      const userId = data.userId || (socket as any).userId;
      if (!roomId) return { success: false, message: '❌ Sala no especificada' };
      if (data.userId && this.notSelf(socket, data.userId)) return this.FORBIDDEN_ACK;

      const room = this.state.chatRooms.get(roomId);
      if (!room) return { success: false, message: 'Sala no encontrada' };

      socket.leave(roomId);
      room.users.delete(userId);
      if ((socket as any).currentRoom === roomId) (socket as any).currentRoom = null;
      const entry = this.state.connectedUsers.get(userId);
      if (entry) entry.userData.currentRoom = null;

      await this.firebase.firestore.collection('users').doc(userId).set(
        { currentRoom: null, lastActive: Date.now(), uid: userId, username: (socket as any).username || null },
        { merge: true },
      );

      socket.to(roomId).emit('user_left_room', {
        userId, username: (socket as any).username, roomId,
        message: `${(socket as any).username} salió de la sala`, timestamp: Date.now(),
      });
      this.updateRoomUserList(roomId);

      return { success: true, message: `Salido de ${roomId}` };
    } catch {
      return { success: false, message: 'Error al salir de la sala' };
    }
  }

  @SubscribeMessage('send_message')
  async sendMessage(@ConnectedSocket() socket: Socket, @MessageBody() data: Record<string, any> = {}) {
    if (!this.throttle.allow(socket.id, 'send_message')) return RATE_LIMITED_ACK;
    const { userId, username, text } = data;
    const roomId = data.roomId || (socket as any).currentRoom || 'general';

    if (!userId || !username || !text) return { success: false, message: '❌ Datos de mensaje inválidos' };
    // D1: mismo ack para texto desmedido (anti payloads gigantes)
    if (!isBoundedString(text, MAX_TEXT_MESSAGE)) return { success: false, message: '❌ Datos de mensaje inválidos' };
    if (this.notSelf(socket, userId)) return this.FORBIDDEN_ACK;
    // Vale si el socket tiene una sala "actual" (regla heredada) o si ya es miembro de la sala
    // destino. Lo segundo importa con multiRoom: quien salió de la sala general y está en una
    // sala de emergencia no tiene sala "actual", y antes su mensaje se rechazaba.
    const inSomeRoom = !!(socket as any).currentRoom || socket.rooms.has(roomId);
    if (!inSomeRoom || !this.state.chatRooms.has(roomId)) {
      return { success: false, message: '❌ No estás en una sala válida' };
    }
    if (!(await this.ensureEmergencyRoomMember(socket, userId, roomId))) {
      return { success: false, message: '❌ No estás en una sala válida' };
    }

    // clientId: id que genera la app para su burbuja "enviando". Vuelve en el eco para que la
    // app empareje el mensaje confirmado con el suyo sin adivinar por contenido (ni duplicar
    // al reenviar tras un corte).
    const clientId = typeof data.clientId === 'string' && data.clientId.trim() ? data.clientId.trim().slice(0, 64) : null;
    const message = { id: uuidv4(), userId, username, roomId, text, type: 'text', timestamp: Date.now(), ...(clientId && { clientId }) };

    try {
      await this.firebase.firestore.collection('messages').add(message);
      const room = this.state.chatRooms.get(roomId);
      if (room) room.messageCount++;

      this.server.to(roomId).emit('new_message', message);
      socket.emit('message_sent', message);

      let usersToNotify: string[] = [];
      if (roomId === 'general') {
        const offline = await this.firebase.firestore.collection('users').where('isOnline', '==', false).get();
        usersToNotify = offline.docs.map((d) => d.id);
      } else {
        usersToNotify = this.roomParticipants(roomId);
      }

      for (const targetUserId of usersToNotify) {
        if (targetUserId === userId) continue;
        if (!this.isUserPresentInRoom(targetUserId, roomId)) {
          await this.notifications.sendPushNotification(targetUserId, '💬 Nuevo mensaje', `${username}: ${text}`, {
            type: 'chat_message', roomId, userId, username, text, timestamp: Date.now().toString(),
          });
        }
      }

      return { success: true, id: message.id };
    } catch {
      return { success: false, message: 'Error guardando mensaje' };
    }
  }

  @SubscribeMessage('get_users')
  getUsers(@MessageBody() data: Record<string, any> = {}) {
    const { roomId } = data;
    const room = this.state.chatRooms.get(roomId);
    if (!room) return { success: false, message: 'Sala no encontrada' };
    return { success: true, roomId, users: this.usersInRoom(room), userCount: this.usersInRoom(room).length };
  }

  // ============================================================
  // 📍 UBICACIÓN EN TIEMPO REAL
  // ============================================================

  @SubscribeMessage('update_location')
  async updateLocation(@ConnectedSocket() socket: Socket, @MessageBody() data: Record<string, any> = {}) {
    if (!this.throttle.allow(socket.id, 'update_location')) return RATE_LIMITED_ACK;
    try {
      const { userId, lat, lng, timestamp } = data;
      if (!userId || !isValidLat(lat) || !isValidLng(lng)) {
        return { success: false, message: 'Datos inválidos' };
      }
      if (this.notSelf(socket, userId)) return this.FORBIDDEN_ACK;
      const entry = this.state.connectedUsers.get(userId);
      if (!entry) return { success: false, message: 'Usuario no conectado' };
      const loc = { lat, lng, ts: typeof timestamp === 'number' ? timestamp : Date.now() };
      entry.userData.lastKnownLocation = loc;
      await this.firebase.firestore.collection('users').doc(userId).update({
        lastKnownLocation: loc, lastLocationUpdatedAt: Date.now(),
      });
      return { success: true };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

  @SubscribeMessage('update_emergency_location')
  async updateEmergencyLocation(@ConnectedSocket() socket: Socket, @MessageBody() data: Record<string, any> = {}) {
    if (!this.throttle.allow(socket.id, 'update_emergency_location')) return RATE_LIMITED_ACK;
    try {
      const { roomId, userId, lat, lng, timestamp, accuracy } = data;
      if (!roomId || !userId || !isValidLat(lat) || !isValidLng(lng)) {
        return { success: false, message: 'Datos de ubicación inválidos' };
      }
      if (this.notSelf(socket, userId)) return this.FORBIDDEN_ACK;
      if (userId !== String(roomId).replace('emergencia_', '')) {
        return { success: false, message: 'Solo la víctima puede actualizar ubicación de emergencia' };
      }
      const entry = this.state.connectedUsers.get(userId);
      if (entry) entry.userData.lastKnownLocation = { lat, lng, ts: timestamp || Date.now(), roomId, type: 'victim' };
      this.emergency.touch(userId);
      const emergencyData = this.state.emergencyAlerts.get(userId);
      if (emergencyData) {
        emergencyData.latitude = lat; emergencyData.longitude = lng; emergencyData.lastLocationUpdate = timestamp || Date.now();
      }
      socket.to(roomId).emit('emergency_location_updated', {
        roomId, userId, lat, lng, timestamp: timestamp || Date.now(), type: 'victim', accuracy: accuracy || null,
      });
      try {
        await this.firebase.firestore.collection('emergencies').doc(userId).collection('locations').add({
          userId, lat, lng, timestamp: timestamp || Date.now(), type: 'victim', roomId, accuracy: accuracy || null,
        });
        await this.firebase.firestore.collection('emergencies').doc(userId).update({
          latitude: lat, longitude: lng, lastLocationUpdate: timestamp || Date.now(),
        });
      } catch (e) {
        // persistencia best-effort
        this.bestEffort('update_emergency_location.persistencia', e);
      }
      return { success: true };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

  @SubscribeMessage('update_helper_location')
  async updateHelperLocation(@ConnectedSocket() socket: Socket, @MessageBody() data: Record<string, any> = {}) {
    if (!this.throttle.allow(socket.id, 'update_helper_location')) return RATE_LIMITED_ACK;
    try {
      const { roomId, helperId, emergencyUserId, lat, lng, timestamp, accuracy } = data;
      if (!roomId || !helperId || !isValidLat(lat) || !isValidLng(lng)) {
        return { success: false, message: 'Datos de ubicación inválidos' };
      }
      if (this.notSelf(socket, helperId)) return this.FORBIDDEN_ACK;
      if (!String(roomId).startsWith('emergencia_')) {
        return { success: false, message: 'Solo para salas de emergencia' };
      }
      const victimId = emergencyUserId || String(roomId).replace('emergencia_', '');
      // Sin emergencia activa no hay a quién informarle: el cliente debe dejar de rastrear.
      if (!this.state.emergencyAlerts.has(victimId)) {
        return { success: false, code: 'EMERGENCY_NOT_ACTIVE', message: 'La emergencia ya no está activa' };
      }
      const entry = this.state.connectedUsers.get(helperId);
      if (entry) entry.userData.lastKnownLocation = { lat, lng, ts: timestamp || Date.now(), roomId, type: 'helper', helpingVictimId: victimId };
      const helpers = this.state.emergencyHelpers.get(victimId);
      if (helpers && !helpers.has(helperId)) {
        // Autocuración: si se perdió el help_confirm pero el ayudante sigue mandando posición,
        // se lo suma. Nunca a quien dijo "No puedo" ni a un usuario sin aprobar.
        if (this.state.emergencyDeclined.get(victimId)?.has(helperId)) {
          return { success: false, code: 'NOT_A_HELPER', message: 'No estás ayudando en esta emergencia' };
        }
        if (!(await this.recovery.isApproved(helperId))) {
          return { success: false, code: 'USER_NOT_APPROVED', message: 'Usuario no habilitado para participar en emergencias' };
        }
        helpers.add(helperId);
        void this.broadcastEmergencyUpdate(victimId);
      }

      const payload = { roomId, helperId, victimId, lat, lng, timestamp: timestamp || Date.now(), type: 'helper', accuracy: accuracy || null };
      // Una sola emisión a la unión sala + víctima: quien esté en ambas no la recibe dos veces.
      socket.to(roomId).to(victimId).emit('helper_location_updated', payload);

      try {
        await this.firebase.firestore.collection('emergencies').doc(victimId).collection('helper_locations').add({
          helperId, lat, lng, timestamp: timestamp || Date.now(), roomId, accuracy: accuracy || null,
        });
        await this.firebase.firestore.collection('emergencies').doc(victimId).collection('active_helpers').doc(helperId).set({
          helperId, lastLocation: { lat, lng }, lastLocationUpdate: timestamp || Date.now(), isActive: true,
        }, { merge: true });
      } catch (e) {
        this.bestEffort('update_helper_location.persistencia', e);
      }
      return { success: true };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

  @SubscribeMessage('request_victim_location')
  async requestVictimLocation(@ConnectedSocket() socket: Socket, @MessageBody() data: Record<string, any> = {}) {
    try {
      const { roomId, helperId, emergencyUserId } = data;
      if (!roomId || !helperId || !emergencyUserId) return { success: false, message: 'Datos incompletos' };
      // La ubicación de una víctima solo se entrega a quien la pide para sí y tiene acceso a esa emergencia.
      if (this.notSelf(socket, helperId)) return this.FORBIDDEN_ACK;
      if (!(await this.canAccessRoom(helperId, `emergencia_${emergencyUserId}`))) return this.FORBIDDEN_ACK;

      const victimEntry = this.state.connectedUsers.get(emergencyUserId);
      const emergencyData = this.state.emergencyAlerts.get(emergencyUserId);

      if (victimEntry?.userData?.lastKnownLocation) {
        const l = victimEntry.userData.lastKnownLocation;
        this.server.to(helperId).emit('victim_location_response', { userId: emergencyUserId, lat: l.lat, lng: l.lng, timestamp: l.ts || Date.now(), roomId, type: 'victim' });
      } else if (emergencyData?.latitude && emergencyData?.longitude) {
        this.server.to(helperId).emit('victim_location_response', { userId: emergencyUserId, lat: emergencyData.latitude, lng: emergencyData.longitude, timestamp: emergencyData.lastLocationUpdate || emergencyData.timestamp || Date.now(), roomId, type: 'victim', fromEmergencyData: true });
      } else {
        try {
          const snap = await this.firebase.firestore.collection('emergencies').doc(emergencyUserId).collection('locations').orderBy('timestamp', 'desc').limit(1).get();
          if (!snap.empty) {
            const lastLoc = snap.docs[0].data();
            this.server.to(helperId).emit('victim_location_response', { userId: emergencyUserId, lat: lastLoc.lat, lng: lastLoc.lng, timestamp: lastLoc.timestamp, roomId, type: 'victim', fromFirestore: true });
          } else {
            this.server.to(helperId).emit('victim_location_response', { userId: emergencyUserId, error: 'No hay ubicación disponible', timestamp: Date.now() });
          }
        } catch (e) {
          this.bestEffort('request_victim_location', e);
        }
      }
      return { success: true };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

  @SubscribeMessage('helpers_location_request')
  async helpersLocationRequest(@ConnectedSocket() socket: Socket, @MessageBody() data: Record<string, any> = {}) {
    try {
      const { roomId, emergencyUserId } = data;
      if (!roomId || !emergencyUserId) return { success: false, message: 'Datos incompletos' };

      const helpers = this.state.emergencyHelpers.get(emergencyUserId) || new Set<string>();
      const helpersLocations: any[] = [];
      for (const helperId of helpers) {
        const helperEntry = this.state.connectedUsers.get(helperId);
        if (helperEntry?.userData?.lastKnownLocation) {
          const loc = helperEntry.userData.lastKnownLocation;
          helpersLocations.push({ userId: helperId, userName: helperEntry.userData.username || 'Ayudante', lat: loc.lat, lng: loc.lng, timestamp: loc.ts || Date.now(), type: 'helper' });
        } else {
          try {
            const snap = await this.firebase.firestore.collection('emergencies').doc(emergencyUserId).collection('helper_locations').where('helperId', '==', helperId).orderBy('timestamp', 'desc').limit(1).get();
            if (!snap.empty) {
              const loc = snap.docs[0].data();
              helpersLocations.push({ userId: helperId, userName: 'Ayudante', lat: loc.lat, lng: loc.lng, timestamp: loc.timestamp, type: 'helper', fromFirestore: true });
            }
          } catch (e) {
            this.bestEffort('helpers_location_request', e);
          }
        }
      }
      this.server.to(emergencyUserId).to(socket.id).emit('helpers_locations_update', { roomId, helpers: helpersLocations, timestamp: Date.now() });
      return { success: true, count: helpersLocations.length };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

  @SubscribeMessage('helper_driving_status')
  helperDrivingStatus(@ConnectedSocket() socket: Socket, @MessageBody() data: Record<string, any> = {}): void {
    try {
      const { roomId, helperId, isDriving, emergencyUserId } = data;
      if (!roomId || !helperId) return;
      if (this.notSelf(socket, helperId)) return;
      const target = emergencyUserId ? socket.to(roomId).to(emergencyUserId) : socket.to(roomId);
      target.emit('helper_driving_update', { helperId, isDriving, timestamp: Date.now() });
    } catch (e) {
      // fire-and-forget (este evento no tiene ack)
      this.bestEffort('helper_driving_status', e);
    }
  }

  // ============================================================
  // 🚨 NÚCLEO DE PÁNICO
  // Un SOS activo por usuario; todos los que hagan falta a la vez. Las operaciones sobre la
  // emergencia de un mismo usuario corren en serie (EmergencyService.runExclusive).
  // ============================================================

  /** Deja constancia de un SOS que el servidor no aceptó (antes se perdían sin rastro). */
  private auditRejectedAlert(socket: Socket, code: string, claimedUserId?: unknown): void {
    void this.audit.record({
      actorUid: (socket as any).user?.uid || 'desconocido',
      action: 'emergency_alert_rejected',
      details: { code, claimedUserId: claimedUserId ? String(claimedUserId).slice(0, 128) : null, socketId: socket.id },
    });
  }

  private async lookupAvatar(userId: string): Promise<string | null> {
    try {
      const doc = await this.firebase.firestore.collection('users').doc(userId).get();
      const ud = doc.exists ? doc.data() || {} : {};
      return ud.avatarUrl || ud.avatarUri || null;
    } catch (e) {
      this.bestEffort('emergency.avatar', e);
      return null;
    }
  }

  private async lookupPrimaryVehicle(userId: string): Promise<Record<string, any> | null> {
    try {
      const vs = await this.firebase.firestore
        .collection('vehicles')
        .where('userId', '==', userId)
        .where('isPrimary', '==', true)
        .where('isActive', '==', true)
        .limit(1)
        .get();
      if (vs.empty) return null;
      const v = vs.docs[0].data() || {};
      const t = v.type || v.tipo || null;
      const vehicle = {
        id: vs.docs[0].id,
        type: t,
        name: v.name || v.nombre || null,
        brand: v.brand || v.marca || null,
        model: v.model || v.modelo || null,
        year: v.year || null,
        color: v.color || null,
        description: v.description || v.descripcion || null,
        licensePlate: v.licensePlate || v.patente || null,
        photoUri: v.photoUri || v.fotoVehiculoUri || null,
        ...(t === 'CAR' && { doors: v.doors }),
        ...(t === 'MOTORCYCLE' && { cylinderCapacity: v.cylinderCapacity, mileage: v.mileage }),
        ...(t === 'BICYCLE' && {
          frameSerialNumber: v.frameSerialNumber, hasElectricMotor: v.hasElectricMotor, frameSize: v.frameSize,
        }),
      };
      // Sin `undefined`: Firestore los rechaza y la emergencia quedaría sin persistir.
      return JSON.parse(JSON.stringify(vehicle));
    } catch (e) {
      this.bestEffort('emergency.vehicle', e);
      return null;
    }
  }

  @SubscribeMessage('emergency_alert')
  async emergencyAlert(@ConnectedSocket() socket: Socket, @MessageBody() data: Record<string, any> = {}) {
    if (!this.throttle.allow(socket.id, 'emergency_alert')) {
      return { ...RATE_LIMITED_ACK, code: 'RATE_LIMITED' };
    }
    const { userId, userName, latitude, longitude } = data;
    if (!userId || !userName) {
      this.auditRejectedAlert(socket, 'INVALID_DATA', userId);
      return { success: false, code: 'INVALID_DATA', message: 'Datos de usuario inválidos' };
    }
    if (this.notSelf(socket, userId)) {
      this.auditRejectedAlert(socket, 'FORBIDDEN', userId);
      return { success: false, code: 'FORBIDDEN', message: 'No autorizado: solo podés disparar tu propia emergencia' };
    }
    if (!isValidLat(latitude) || !isValidLng(longitude)) {
      this.auditRejectedAlert(socket, 'INVALID_LOCATION', userId);
      return { success: false, code: 'INVALID_LOCATION', message: 'Ubicación inválida' };
    }
    try {
      return await this.emergency.runExclusive(String(userId), () => this.openEmergency(socket, data));
    } catch (e) {
      this.bestEffort('emergency_alert', e);
      this.auditRejectedAlert(socket, 'SERVER_ERROR', userId);
      return { success: false, code: 'SERVER_ERROR', message: 'Error procesando alerta de emergencia' };
    }
  }

  /** Crea, recupera o reemplaza la emergencia del usuario. Siempre dentro de runExclusive(userId). */
  private async openEmergency(socket: Socket, data: Record<string, any>) {
    const { userId, userName, latitude, longitude, emergencyType = 'general' } = data;
    const emergencyRoomId = `emergencia_${userId}`;
    const requestId = typeof data.requestId === 'string' && data.requestId.trim()
      ? data.requestId.trim().slice(0, 64)
      : null;
    const multi = (socket as any).multiRoom === true;

    // Reintento del mismo toque (o cliente viejo, que no manda requestId): se devuelve la
    // emergencia en curso. Un reintento por mala señal nunca cancela ni duplica el pedido.
    const existing = this.state.emergencyAlerts.get(userId);
    if (existing && (!requestId || existing.requestId === requestId)) {
      this.server.in(userId).socketsJoin(emergencyRoomId);
      this.emergency.touch(userId);
      return {
        success: true, emergencyRoomId, recovered: true,
        timestamp: existing.timestamp, emergencyId: existing.emergencyId,
      };
    }

    if (!this.emergency.allowNew(userId)) {
      this.auditRejectedAlert(socket, 'RATE_LIMITED', userId);
      return { ...RATE_LIMITED_ACK, code: 'RATE_LIMITED' };
    }

    // Todo lo que puede fallar o tardar se resuelve ANTES de tocar el estado: si algo falla
    // acá, no queda una emergencia a medias que nadie recibió.
    const [avatarUrl, vehicleData, approved] = await Promise.all([
      this.lookupAvatar(userId), this.lookupPrimaryVehicle(userId), this.approvedUserIds(),
    ]);

    const now = Date.now();
    const replaced = !!existing;
    if (existing) {
      // El usuario volvió a apretar SOS: el pedido anterior queda archivado como reemplazado.
      // Se conservan la sala, el chat y los ayudantes que ya venían en camino.
      this.emergency.archive(existing, 'replaced', this.emergency.helpersInfo(userId));
    }

    const emergencyData: Record<string, any> = {
      userId, userName, avatarUrl, latitude, longitude,
      timestamp: now, // misma identidad temporal en Socket, FCM y recuperación
      emergencyId: uuidv4(), requestId, lastActivityAt: now,
      socketId: socket.id, emergencyType, status: 'active',
      emergencyRoomId, roomId: emergencyRoomId, vehicleInfo: vehicleData,
      helperNames: existing?.helperNames || {},
      ...(replaced && { replaced: true, previousEmergencyId: existing.emergencyId || null }),
    };
    this.state.emergencyAlerts.set(userId, emergencyData);
    if (!this.state.emergencyHelpers.has(userId)) this.state.emergencyHelpers.set(userId, new Set());
    this.state.emergencyDeclined.set(userId, new Set()); // un SOS nuevo vuelve a preguntarle a todos
    this.state.emergencyUserRoom.set(userId, emergencyRoomId);

    let room = this.state.chatRooms.get(emergencyRoomId);
    if (!room) {
      room = {
        id: emergencyRoomId, name: `Emergencia ${userName}`, type: 'emergency',
        description: `Sala de emergencia para ${userName}`,
        users: new Set<string>(), createdAt: now, messageCount: 0,
      };
      this.state.chatRooms.set(emergencyRoomId, room);
    }
    room.users.add(userId);
    // Todos los dispositivos del usuario entran a su sala.
    this.server.in(userId).socketsJoin(emergencyRoomId);
    socket.join(emergencyRoomId);
    if (!multi) (socket as any).currentRoom = emergencyRoomId;

    // Lo urgente primero: el aviso por socket sale antes que la persistencia.
    const publicAlert = { ...this.recovery.view(userId, emergencyData), emergencyRoomId };
    this.server.to(userId).emit('emergency_room_created', {
      emergencyUserId: userId, emergencyRoomId, emergencyId: emergencyData.emergencyId,
    });
    if (!replaced) {
      this.emitToApproved(approved, userId, 'new_room_created', {
        id: room.id, name: room.name, type: room.type, description: room.description,
        userCount: room.users.size, messageCount: room.messageCount, createdAt: room.createdAt,
      });
    }
    const delivery = this.emitToApproved(approved, userId, 'emergency_alert', publicAlert);

    // Push FCM a todos los aprobados: tener socket no garantiza que el teléfono lo muestre.
    const recipients = [...approved].filter((uid) => uid !== userId);
    void this.emergencyPush.deliver(emergencyData, recipients).catch((e) => this.bestEffort('emergency.push', e));

    try {
      await this.firebase.firestore.collection('emergencies').doc(userId).set({
        ...emergencyData,
        isActive: true, createdAt: now,
        helpers: [...(this.state.emergencyHelpers.get(userId) || [])], declined: [],
      });
      await this.firebase.firestore.collection('users').doc(userId).update({
        hasActiveEmergency: true, emergencyRoomId, lastEmergencyStarted: now,
      });
    } catch (e) {
      this.bestEffort('emergency.persistencia', e);
    }

    void this.audit.record({
      actorUid: userId,
      action: 'emergency_alert',
      details: {
        roomId: emergencyRoomId, emergencyId: emergencyData.emergencyId, replaced,
        sockets: delivery.sent, push: 0, pushScheduled: recipients.length,
        conectados: this.server.sockets.sockets.size,
        sinIdentidad: delivery.sinIdentidad, noAprobados: delivery.noAprobados,
      },
    });

    return {
      success: true,
      message: 'Alerta de emergencia enviada correctamente',
      vehicle: vehicleData,
      avatarUrl,
      socketNotifications: delivery.sent,
      pushNotifications: 0, // el resultado real queda en emergency_push_result
      pushScheduled: recipients.length,
      emergencyRoomId,
      emergencyId: emergencyData.emergencyId,
      timestamp: now,
      replaced,
      staleReplaced: false,
    };
  }

  /** Validaciones comunes de "puedo ayudar" / "no puedo". Devuelve el ack de error o los datos del ayudante. */
  private async checkHelper(socket: Socket, data: Record<string, any>, action: string) {
    const { emergencyUserId, helperId } = data;
    if (!emergencyUserId || !helperId) return { error: { success: false, message: 'Datos incompletos' } };
    if (this.notSelf(socket, helperId)) return { error: this.FORBIDDEN_ACK };

    const helperDoc = await this.firebase.firestore.collection('users').doc(helperId).get();
    if (!helperDoc.exists) {
      return { error: { success: false, code: 'USER_NOT_FOUND', message: 'Usuario ayudante no encontrado' } };
    }
    const helperData = helperDoc.data() || {};
    if (helperData.state !== 'approved') {
      this.logger.warn(`⛔ ${action} bloqueado. Usuario ${helperId} tiene state=${helperData.state}`);
      return { error: { success: false, code: 'USER_NOT_APPROVED', message: 'Usuario no habilitado para participar en emergencias' } };
    }
    return { helperData };
  }

  // ============================================================
  // 🤝 CONFIRMAR AYUDA (también sirve para arrepentirse de un "No puedo")
  // ============================================================

  @SubscribeMessage('help_confirm')
  async helpConfirm(@ConnectedSocket() socket: Socket, @MessageBody() data: Record<string, any> = {}) {
    try {
      const checked = await this.checkHelper(socket, data, 'help_confirm');
      if (checked.error) return checked.error;
      const { emergencyUserId, helperId, helperName, latitude, longitude, timestamp } = data;
      if (helperId === emergencyUserId) {
        return { success: false, code: 'INVALID_DATA', message: 'No podés confirmarte ayuda a vos mismo' };
      }

      // En serie con crear/reemplazar/resolver de esa emergencia: si la cancelación llegó
      // primero, el ayudante recibe "ya no está activa" en vez de quedar colgado.
      return await this.emergency.runExclusive(String(emergencyUserId), async () => {
        const alert = this.state.emergencyAlerts.get(emergencyUserId);
        if (!alert) {
          return { success: false, code: 'EMERGENCY_NOT_ACTIVE', message: 'La emergencia ya no está activa' };
        }
        const roomId = this.state.emergencyUserRoom.get(emergencyUserId) || `emergencia_${emergencyUserId}`;
        const name = (typeof helperName === 'string' && helperName.trim())
          || checked.helperData?.username || 'Ayudante';

        let helpers = this.state.emergencyHelpers.get(emergencyUserId);
        if (!helpers) {
          helpers = new Set<string>();
          this.state.emergencyHelpers.set(emergencyUserId, helpers);
        }
        helpers.add(helperId);
        this.state.emergencyDeclined.get(emergencyUserId)?.delete(helperId);
        alert.helperNames = { ...(alert.helperNames || {}), [helperId]: String(name).slice(0, 80) };

        // Todos los dispositivos del ayudante entran a la sala de esa emergencia.
        this.server.in(helperId).socketsJoin(roomId);
        const room = this.state.chatRooms.get(roomId);
        if (room) {
          room.users.add(helperId);
          this.updateRoomUserList(roomId);
        }

        void this.audit.record({ actorUid: helperId, action: 'help_confirm', targetUid: emergencyUserId });

        // Espejo en Firestore: sobrevive a un reinicio del servidor.
        this.firebase.firestore.collection('emergencies').doc(emergencyUserId).update({
          helpers: admin.firestore.FieldValue.arrayUnion(helperId),
          declined: admin.firestore.FieldValue.arrayRemove(helperId),
          helperNames: alert.helperNames,
        }).catch((e) => this.bestEffort('help_confirm.espejo', e));

        this.server.to(emergencyUserId).emit('help_confirmed', {
          emergencyUserId, emergencyId: alert.emergencyId, helperId, helperName: name,
          latitude, longitude, timestamp: timestamp || Date.now(),
        });
        this.server.to(helperId).emit('help_confirmed_notification', {
          emergencyUserId, emergencyId: alert.emergencyId, helperId, helperName: name, timestamp: Date.now(),
        });
        void this.broadcastEmergencyUpdate(emergencyUserId);
        void this.emergencyPush.notifyHelpConfirmed(emergencyUserId, { id: helperId, name: String(name) }, alert.emergencyId)
          .catch((e) => this.bestEffort('help_confirm.push', e));

        return { success: true, emergencyRoomId: roomId, emergencyId: alert.emergencyId, helpersCount: helpers.size };
      });
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

  // ============================================================
  // ❌ "NO PUEDO" (se puede revertir con help_confirm mientras la emergencia siga activa)
  // ============================================================

  @SubscribeMessage('help_reject')
  async helpReject(@ConnectedSocket() socket: Socket, @MessageBody() data: Record<string, any> = {}) {
    try {
      const checked = await this.checkHelper(socket, data, 'help_reject');
      if (checked.error) return checked.error;
      const { emergencyUserId, helperId } = data;

      await this.emergency.runExclusive(String(emergencyUserId), async () => {
        const alert = this.state.emergencyAlerts.get(emergencyUserId);
        if (!alert) return;
        const roomId = this.state.emergencyUserRoom.get(emergencyUserId) || `emergencia_${emergencyUserId}`;
        this.state.emergencyHelpers.get(emergencyUserId)?.delete(helperId);
        let declined = this.state.emergencyDeclined.get(emergencyUserId);
        if (!declined) {
          declined = new Set<string>();
          this.state.emergencyDeclined.set(emergencyUserId, declined);
        }
        declined.add(helperId);
        if (alert.helperNames) alert.helperNames = omit(alert.helperNames, helperId);

        this.server.in(helperId).socketsLeave(roomId);
        const room = this.state.chatRooms.get(roomId);
        if (room && room.users.delete(helperId)) this.updateRoomUserList(roomId);

        this.firebase.firestore.collection('emergencies').doc(emergencyUserId).update({
          helpers: admin.firestore.FieldValue.arrayRemove(helperId),
          declined: admin.firestore.FieldValue.arrayUnion(helperId),
          helperNames: alert.helperNames || {},
        }).catch((e) => this.bestEffort('help_reject.espejo', e));

        void this.broadcastEmergencyUpdate(emergencyUserId);
      });

      void this.audit.record({ actorUid: helperId, action: 'help_reject', targetUid: emergencyUserId });
      this.server.to(helperId).emit('help_rejected', { emergencyUserId, helperId, timestamp: Date.now() });
      return { success: true };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

  // ============================================================
  // ✅ FIN DE UNA EMERGENCIA (resuelta por su dueño o vencida por inactividad)
  // ============================================================

  /** Termina la emergencia de `userId`. Debe llamarse dentro de runExclusive(userId). */
  private async endEmergency(userId: string, reason: string, fallbackName?: string) {
    const emergencyRoomId = this.state.emergencyUserRoom.get(userId) || `emergencia_${userId}`;
    const alert = this.state.emergencyAlerts.get(userId);
    const username = alert?.userName || fallbackName || 'Usuario';
    const now = Date.now();
    const ended = alert ? this.emergency.archive(alert, reason, this.emergency.helpersInfo(userId)) : null;

    // Los sockets del dueño salen primero de la sala (comportamiento heredado).
    const userEntry = this.state.connectedUsers.get(userId);
    if (userEntry) {
      userEntry.sockets.forEach((sid) => {
        const s = this.server.sockets.sockets.get(sid);
        if (s) {
          if (s.rooms?.has(emergencyRoomId)) s.leave(emergencyRoomId);
          if ((s as any).currentRoom === emergencyRoomId) (s as any).currentRoom = 'general';
        }
      });
    }

    void this.audit.record({
      actorUid: userId,
      action: reason === 'expired' ? 'emergency_expired' : 'emergency_resolve',
      details: { roomId: emergencyRoomId, reason, emergencyId: ended?.emergencyId || null, wasActive: !!alert },
    });
    this.server.emit('emergency_cancelled', {
      userId, userName: username, username, roomId: emergencyRoomId, reason, timestamp: now, isActive: false,
      emergencyId: ended?.emergencyId || null, endedAt: now, helpersInfo: ended?.helpersInfo || [],
    });
    this.server.to(emergencyRoomId).emit('emergency_resolved', {
      roomId: emergencyRoomId, userId, message: 'Emergencia resuelta', reason, timestamp: now,
      emergencyId: ended?.emergencyId || null,
    });
    if (ended) {
      // Los teléfonos con la app cerrada también tienen que enterarse de que terminó.
      void this.approvedUserIds()
        .then((approved) => this.emergencyPush.notifyEnded(ended, [...approved].filter((uid) => uid !== userId)))
        .catch((e) => this.bestEffort('endEmergency.push', e));
    }

    const socketsInRoom = this.server.sockets.adapter.rooms.get(emergencyRoomId);
    if (socketsInRoom) {
      for (const sid of Array.from(socketsInRoom)) {
        const s = this.server.sockets.sockets.get(sid);
        if (s) {
          s.leave(emergencyRoomId);
          if ((s as any).currentRoom === emergencyRoomId) (s as any).currentRoom = 'general';
        }
      }
    }

    this.state.chatRooms.delete(emergencyRoomId);
    this.state.emergencyUserRoom.delete(userId);
    this.state.emergencyAlerts.delete(userId);
    this.state.emergencyHelpers.delete(userId);
    this.state.emergencyDeclined.delete(userId);

    if (alert) {
      try {
        await this.firebase.firestore.collection('emergencies').doc(userId).update({
          status: 'resolved', isActive: false, resolvedAt: now, endedAt: now, roomId: emergencyRoomId, endReason: reason,
        });
      } catch (e) { this.bestEffort('endEmergency.espejo', e); }
    }
    try {
      await this.firebase.firestore.collection('users').doc(userId).update({
        hasActiveEmergency: false, emergencyRoomId: null, lastEmergencyEnded: now,
      });
    } catch (e) { this.bestEffort('endEmergency.usuario', e); }

    // Solo se borra el chat de ESTA sala: resolver un SOS no toca los mensajes de otro.
    try { await this.deleteRoomMessages(emergencyRoomId); } catch (e) { this.bestEffort('endEmergency.chat', e); }

    this.server.to(userId).emit('emergency_fully_cleaned', { userId, roomId: emergencyRoomId, reason, timestamp: Date.now() });
    this.server.emit('user_status_changed', { userId, username, hasActiveEmergency: false, emergencyCleared: true, timestamp: Date.now() });
    this.server.emit('connected_users', this.onlineUsers());

    return { emergencyRoomId, wasActive: !!alert };
  }

  @SubscribeMessage('emergency_resolve')
  async emergencyResolve(@ConnectedSocket() socket: Socket, @MessageBody() data: Record<string, any> = {}) {
    try {
      const { userId } = data;
      if (!userId) return { success: false, message: 'userId requerido' };
      if (this.notSelf(socket, userId)) return this.FORBIDDEN_ACK;
      // 'replaced' y 'expired' son motivos internos del servidor: un cliente no puede declararlos.
      const asked = typeof data.reason === 'string' && data.reason.trim() ? data.reason.trim().slice(0, 60) : 'resolved_by_user';
      const reason = asked === 'replaced' || asked === 'expired' ? 'resolved_by_user' : asked;

      const result = await this.emergency.runExclusive(String(userId), () =>
        this.endEmergency(userId, reason, (socket as any).username));
      return {
        success: true, message: 'Emergencia resuelta correctamente',
        emergencyRoomId: result.emergencyRoomId, chatHistoryDeleted: true, wasActive: result.wasActive,
      };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

  // ============================================================
  // 👤 PERFIL · 🔑 FCM TOKEN · 🎧 AUDIO · 🔌 DESCONEXIÓN
  // ============================================================

  @SubscribeMessage('get_profile')
  async getProfile(@MessageBody() data: Record<string, any> = {}) {
    try {
      const userId = data.userId;
      if (!userId) return { success: false, message: 'userId requerido' };
      const snap = await this.firebase.firestore.collection('users').doc(userId).get();
      if (!snap.exists) return { success: false, message: 'Perfil no encontrado' };
      const user = snap.data() || {};
      let finalUsername = user.username;
      if (!finalUsername || finalUsername === 'null' || String(finalUsername).trim() === '') {
        if (user.fullName && user.fullName.trim() !== '') finalUsername = user.fullName.trim();
        else if (user.email && user.email.trim() !== '') finalUsername = user.email.split('@')[0].trim();
        else finalUsername = 'Usuario';
      }
      return { success: true, ...user, username: finalUsername };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

  @SubscribeMessage('update_profile')
  async updateProfile(@ConnectedSocket() socket: Socket, @MessageBody() data: Record<string, any> = {}) {
    try {
      const { userId, fullName = '', username = '', email = '', phone = '', avatarUri = '' } = data;
      if (!userId) return { success: false, message: 'userId requerido' };
      if (this.notSelf(socket, userId)) return this.FORBIDDEN_ACK;

      const prevSnap = await this.firebase.firestore.collection('users').doc(userId).get();
      const prevData = prevSnap.exists ? (prevSnap.data() || {}) : {};

      let finalUsername = username;
      if (!finalUsername || finalUsername.trim() === '' || finalUsername === 'null') {
        finalUsername = prevData?.username;
        if (!finalUsername || String(finalUsername).trim() === '' || finalUsername === 'null') {
          if (fullName && fullName.trim() !== '') finalUsername = fullName.trim();
          else if (email && email.trim() !== '') finalUsername = email.split('@')[0].trim();
          else finalUsername = 'Usuario';
        }
      }

      let finalAvatar = prevData?.avatarUri || '';
      if (typeof avatarUri === 'string' && avatarUri.trim() !== '') {
        if (isDataUrl(avatarUri)) finalAvatar = await this.uploadAvatar(userId, avatarUri);
        else if (isHttpUrl(avatarUri)) finalAvatar = avatarUri;
      }

      const updatedUser = {
        id: userId,
        fullName: fullName.trim() || prevData?.fullName || '',
        username: finalUsername,
        email: email.trim() || prevData?.email || '',
        phone: phone.trim() || prevData?.phone || '',
        avatarUri: finalAvatar,
        status: 'Online', presence: 'Available', updatedAt: Date.now(),
      };
      await this.firebase.firestore.collection('users').doc(userId).update(updatedUser);
      const entry = this.state.connectedUsers.get(userId);
      if (entry) entry.userData = { ...entry.userData, ...updatedUser };
      this.server.emit('user_updated', updatedUser);
      return { success: true, message: 'Perfil actualizado correctamente', user: updatedUser };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

  private async uploadAvatar(userId: string, dataUrl: string): Promise<string> {
    // Upload unificado (D5): el cleanup de avatares anteriores lo hace el StorageService.
    const { url } = await this.storage.uploadDataUrl({
      dataUrl,
      pathPrefix: `avatars/${userId}`,
      makePublic: true,
      metadata: { userId },
      cacheControl: 'public, max-age=31536000',
      cleanupPrefix: `avatars/${userId}/`,
    });
    return url as string;
  }

  @SubscribeMessage('register_fcm_token')
  async registerFcmToken(@ConnectedSocket() socket: Socket, @MessageBody() data: Record<string, any> = {}) {
    try {
      const { userId, fcmToken, deviceId, platform, deviceModel, appVersion } = data;
      if (!userId || !fcmToken) return { success: false, message: 'userId y fcmToken requeridos' };
      if (this.notSelf(socket, userId)) return this.FORBIDDEN_ACK;

      const uniqueDeviceId = (typeof deviceId === 'string' && deviceId.trim().length > 0)
        ? deviceId.trim()
        : `device_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

      // Versión de la app y modelo del teléfono: la app ya los mandaba, el server los tiraba.
      // Sin esto era imposible saber quién corre un APK viejo (bug de campo del 24/9: los
      // datos del vehículo "no llegaban" en teléfonos con el parser anterior al 3/9).
      const safeVersion = typeof appVersion === 'string' && appVersion.trim() ? appVersion.trim() : null;
      const safeModel = typeof deviceModel === 'string' && deviceModel.trim() ? deviceModel.trim() : null;

      const userRef = this.firebase.firestore.collection('users').doc(userId);
      await userRef.collection('fcmTokens').doc(uniqueDeviceId).set({
        token: String(fcmToken), platform: platform || 'android', deviceModel: safeModel, appVersion: safeVersion, socketId: socket.id,
        enabled: true,
        lastActiveAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      await userRef.set({
        socketIds: admin.firestore.FieldValue.arrayUnion(socket.id),
        lastTokenRefreshAt: admin.firestore.FieldValue.serverTimestamp(),
        ...(safeVersion && { appVersion: safeVersion, appVersionAt: Date.now() }),
        ...(safeModel && { appDevice: safeModel }),
      }, { merge: true });

      return { success: true, message: 'Token registrado', deviceId: uniqueDeviceId };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

  @SubscribeMessage('audio_message')
  async audioMessage(@ConnectedSocket() socket: Socket, @MessageBody() data: Record<string, any> = {}) {
    if (!this.throttle.allow(socket.id, 'audio_message')) return RATE_LIMITED_ACK;
    try {
      const { userId, username } = data;
      const roomId = data.roomId || (socket as any).currentRoom || 'general';
      if (!userId || !username) return { success: false, message: '❌ userId/username inválidos' };
      if (this.notSelf(socket, userId)) return this.FORBIDDEN_ACK;
      if (!this.state.chatRooms.has(roomId)) return { success: false, message: '❌ No estás en una sala válida' };
      if (!(await this.ensureEmergencyRoomMember(socket, userId, roomId))) {
        return { success: false, message: '❌ No estás en una sala válida' };
      }

      let finalAudioUrl: string | null = data.audioUrl || null;
      if (finalAudioUrl && /^https?:\/\//i.test(finalAudioUrl)) {
        // audioUrl directo (PTT robusto)
      } else if (typeof data.audioDataUrl === 'string' && data.audioDataUrl.startsWith('data:audio/')) {
        finalAudioUrl = await this.saveAudio(data.audioDataUrl, userId, roomId, data.ext);
      } else if (typeof data.audioData === 'string' && data.audioData.length > 0) {
        const mime = (typeof data.mime === 'string' && data.mime.startsWith('audio/')) ? data.mime : 'audio/mpeg';
        finalAudioUrl = await this.saveAudio(`data:${mime};base64,${data.audioData}`, userId, roomId, data.ext);
      }
      if (!finalAudioUrl) return { success: false, message: '❌ No se pudo obtener URL de audio' };

      const message: Record<string, any> = {
        id: uuidv4(), userId, username, roomId, type: 'audio', audioUrl: finalAudioUrl, content: '[Audio]',
        durationMs: typeof data.durationMs === 'number' ? data.durationMs : undefined, timestamp: Date.now(),
        ...(typeof data.clientId === 'string' && data.clientId.trim() && { clientId: data.clientId.trim().slice(0, 64) }),
      };
      await this.firebase.firestore.collection('messages').add(message);
      const room = this.state.chatRooms.get(roomId);
      if (room) room.messageCount++;

      this.server.to(roomId).emit('audio_message', message);
      socket.emit('message_sent', { id: message.id, ...message });

      const roomUsers = this.roomParticipants(roomId);
      for (const targetUserId of roomUsers) {
        if (targetUserId === userId) continue;
        if (!this.isUserPresentInRoom(targetUserId, roomId)) {
          await this.notifications.sendPushNotification(targetUserId, '🎧 Mensaje de audio', `${username} envió un audio`, {
            type: 'audio_message', roomId, userId, username, timestamp: Date.now().toString(),
          });
        }
      }
      return { success: true, id: message.id, audioUrl: finalAudioUrl };
    } catch {
      return { success: false, message: 'Error guardando mensaje de audio' };
    }
  }

  /** Borra todos los mensajes de una sala (limpieza de historial al resolver una emergencia). */
  private async deleteRoomMessages(roomId: string): Promise<void> {
    const snap = await this.firebase.firestore.collection('messages').where('roomId', '==', roomId).get();
    if (snap.empty) return;
    // Un batch de Firestore admite 500 operaciones: se borra de a tandas.
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = this.firebase.firestore.batch();
      snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }

  private async saveAudio(audioDataUrl: string, userId: string, roomId: string, ext?: string): Promise<string> {
    // El MIME de audio se detecta acá (getMimeFromDataUrl es solo-imagen); upload unificado (D5).
    const mimeMatch = audioDataUrl.match(/^data:(audio\/[a-zA-Z0-9.+-]+);base64,/);
    const mime = mimeMatch ? mimeMatch[1] : 'audio/mpeg';
    const finalExt = ext || mime.split('/')[1] || 'mp3';
    const { url } = await this.storage.uploadDataUrl({
      dataUrl: audioDataUrl,
      mime,
      pathPrefix: `audios/${roomId}`,
      fileName: `${userId}_${Date.now()}_${uuidv4()}.${finalExt}`,
      makePublic: true,
    });
    return url as string;
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    this.throttle.forget(socket.id);
    const userId = (socket as any).userId;
    if (!userId) return;

    const entry = this.state.connectedUsers.get(userId);
    let isLastConnection = true;
    if (entry) {
      entry.sockets.delete(socket.id);
      isLastConnection = entry.sockets.size === 0;
    }

    // Sin conexiones vivas el usuario deja de figurar "en línea" en las salas (antes quedaba
    // listado para siempre). Su lugar en las salas de emergencia se recupera solo al reconectar.
    if (isLastConnection && !this.shuttingDown) {
      if (entry) entry.userData.isOnline = false;
      for (const room of this.state.chatRooms.values()) {
        if (room.users.delete(userId)) this.updateRoomUserList(room.id);
      }
      this.server.emit('connected_users', this.onlineUsers());
    }

    // Desconectarse NO resuelve una emergencia: se conserva hasta cancelación explícita.
    try {
      const updateData: Record<string, any> = {
        socketIds: admin.firestore.FieldValue.arrayRemove(socket.id),
        lastSeen: Date.now(),
      };
      if (isLastConnection) {
        updateData.isOnline = false;
        updateData.currentRoom = 'general';
      }
      await this.firebase.firestore.collection('users').doc(userId).update(updateData);
    } catch (e) {
      // el doc puede no existir; best-effort
      this.bestEffort('disconnect.markOffline', e);
    }
  }
}
