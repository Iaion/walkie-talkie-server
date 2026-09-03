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
import { StateStore } from './state.store';
import { EmergencyService } from './emergency.service';
import { isDataUrl, isHttpUrl } from '../common/image-utils';
import { corsOrigins } from '../common/cors';
import { SocketThrottle, RATE_LIMITED_ACK } from '../common/socket-throttle';
import { isValidLat, isValidLng, isBoundedString, MAX_TEXT_MESSAGE } from '../common/validate';
import { StorageService } from '../common/storage.service';
import { AuditService } from '../common/audit.service';

@WebSocketGateway({
  cors: { origin: corsOrigins(), methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
})
@Injectable()
export class RealtimeGateway implements OnGatewayInit, OnGatewayDisconnect, OnModuleDestroy, OnApplicationBootstrap {
  @WebSocketServer() server: Server;

  private readonly logger = new Logger(RealtimeGateway.name);

  // Anti-loop de resoluciones (equivalente a global.resolveInProgress del monolito).
  private readonly resolveInProgress = new Set<string>();

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
        this.state.emergencyAlerts.set(userId, { ...data, userId });
        this.state.emergencyHelpers.set(userId, new Set<string>(Array.isArray(data.helpers) ? data.helpers : []));
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
    const usersInRoom = Array.from(room.users)
      .map((uid) => this.state.connectedUsers.get(uid)?.userData)
      .filter(Boolean);
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
      (typeof user.fullName === 'string' && user.fullName.trim()) ||
      (typeof user.email === 'string' && user.email.split('@')[0].trim()) ||
      'Usuario';

    (socket as any).userId = userId;
    (socket as any).username = safeUsername;

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

    this.server.emit(
      'connected_users',
      Array.from(this.state.connectedUsers.values()).map((u) => ({ ...u.userData, socketCount: u.sockets.size })),
    );

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

      const currentRoom = (socket as any).currentRoom;
      if (currentRoom && currentRoom !== roomId) {
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
      (socket as any).currentRoom = roomId;
      targetRoom.users.add(userId);
      const entry = this.state.connectedUsers.get(userId);
      if (entry) entry.userData.currentRoom = roomId;

      await this.firebase.firestore.collection('users').doc(userId).set(
        { currentRoom: roomId, lastActive: Date.now(), uid: userId, username: (socket as any).username || null },
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
    if (!(socket as any).currentRoom || !this.state.chatRooms.has(roomId)) {
      return { success: false, message: '❌ No estás en una sala válida' };
    }

    const message = { id: uuidv4(), userId, username, roomId, text, type: 'text', timestamp: Date.now() };

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
        usersToNotify = room ? Array.from(room.users) : [];
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
    const usersInRoom = Array.from(room.users)
      .map((uid) => this.state.connectedUsers.get(uid)?.userData)
      .filter(Boolean);
    return { success: true, roomId, users: usersInRoom };
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
      const entry = this.state.connectedUsers.get(helperId);
      if (entry) entry.userData.lastKnownLocation = { lat, lng, ts: timestamp || Date.now(), roomId, type: 'helper', helpingVictimId: victimId };
      const helpers = this.state.emergencyHelpers.get(victimId);
      if (helpers && !helpers.has(helperId)) helpers.add(helperId);

      const payload = { roomId, helperId, victimId, lat, lng, timestamp: timestamp || Date.now(), type: 'helper', accuracy: accuracy || null };
      socket.to(roomId).emit('helper_location_updated', payload);
      this.server.to(victimId).emit('helper_location_updated', payload);

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
  async requestVictimLocation(@MessageBody() data: Record<string, any> = {}) {
    try {
      const { roomId, helperId, emergencyUserId } = data;
      if (!roomId || !helperId || !emergencyUserId) return { success: false, message: 'Datos incompletos' };

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
      this.server.to(emergencyUserId).emit('helpers_locations_update', { roomId, helpers: helpersLocations, timestamp: Date.now() });
      this.server.to(socket.id).emit('helpers_locations_update', { roomId, helpers: helpersLocations, timestamp: Date.now() });
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
      if (emergencyUserId) {
        this.server.to(emergencyUserId).emit('helper_driving_update', { helperId, isDriving, timestamp: Date.now() });
      }
      socket.to(roomId).emit('helper_driving_update', { helperId, isDriving, timestamp: Date.now() });
    } catch (e) {
      // fire-and-forget (este evento no tiene ack)
      this.bestEffort('helper_driving_status', e);
    }
  }

// ============================================================
// 🚨 NÚCLEO DE PÁNICO
// ============================================================

@SubscribeMessage('emergency_alert')
async emergencyAlert(
  @ConnectedSocket() socket: Socket,
  @MessageBody() data: Record<string, any> = {}
) {
  if (!this.throttle.allow(socket.id, 'emergency_alert')) {
    return { ...RATE_LIMITED_ACK, code: 'RATE_LIMITED' };
  }

  let lockAcquired = false;
  let reqUserId: string | null = null;
  let emergencyRoomId: string | null = null;

  try {
    const {
      userId,
      userName,
      latitude,
      longitude,
      timestamp,
      emergencyType = 'general'
    } = data;

    reqUserId = userId || null;

    if (!userId || !userName) {
      return {
        success: false,
        code: 'INVALID_DATA',
        message: 'Datos de usuario inválidos'
      };
    }

    if (this.notSelf(socket, userId)) {
      return {
        success: false,
        code: 'FORBIDDEN',
        message: 'No autorizado: solo podés disparar tu propia emergencia'
      };
    }

    if (!isValidLat(latitude) || !isValidLng(longitude)) {
      return {
        success: false,
        code: 'INVALID_LOCATION',
        message: 'Ubicación inválida'
      };
    }

    emergencyRoomId = `emergencia_${userId}`;

    const lockResult = await this.emergency.acquireLock(
      userId,
      emergencyRoomId,
      emergencyType
    );

    if (!lockResult.allowed) {
      return {
        success: false,
        code: 'EMERGENCY_ALREADY_ACTIVE',
        message:
          '⚠️ Esta es una versión de prueba. Actualmente manejamos una emergencia a la vez, y ya hay una en curso. Volvé a intentarlo más tarde.',
        activeEmergency: lockResult.activeEmergency,
      };
    }

    lockAcquired = true;

    socket.join(emergencyRoomId);
    (socket as any).currentRoom = emergencyRoomId;

    // ============================================================
    // 👤 Avatar del usuario que dispara la emergencia
    // ============================================================

    let avatarUrl: string | null = null;

    try {
      const userDoc = await this.firebase.firestore
        .collection('users')
        .doc(userId)
        .get();

      if (userDoc.exists) {
        const ud = userDoc.data() || {};
        avatarUrl = ud.avatarUrl || ud.avatarUri || null;
      }
    } catch (e) {
      this.bestEffort('persistencia', e);
    }

    // ============================================================
    // 🚗 Vehículo principal activo
    // ============================================================

    let vehicleData: Record<string, any> | null = null;

    try {
      const vs = await this.firebase.firestore
        .collection('vehicles')
        .where('userId', '==', userId)
        .where('isPrimary', '==', true)
        .where('isActive', '==', true)
        .limit(1)
        .get();

      if (!vs.empty) {
        const v = vs.docs[0].data() || {};
        const t = v.type || v.tipo || null;

        vehicleData = {
          id: vs.docs[0].id,
          type: t,

          name: v.name || v.nombre || null,
          brand: v.brand || v.marca || null,
          model: v.model || v.modelo || null,

          year: v.year || null,
          color: v.color || null,

          licensePlate:
            v.licensePlate ||
            v.patente ||
            null,

          photoUri:
            v.photoUri ||
            v.fotoVehiculoUri ||
            null,

          ...(t === 'CAR' && {
            doors: v.doors
          }),

          ...(t === 'MOTORCYCLE' && {
            cylinderCapacity: v.cylinderCapacity,
            mileage: v.mileage
          }),

          ...(t === 'BICYCLE' && {
            frameSerialNumber: v.frameSerialNumber,
            hasElectricMotor: v.hasElectricMotor,
            frameSize: v.frameSize
          }),
        };
      }
    } catch (e) {
      this.bestEffort('persistencia', e);
    }

    // ============================================================
    // 🚨 Datos de emergencia
    // ============================================================

    const emergencyData: Record<string, any> = {
      userId,
      userName,
      avatarUrl,
      latitude,
      longitude,

      timestamp:
        typeof timestamp === 'number'
          ? timestamp
          : Date.now(),

      socketId: socket.id,

      emergencyType,
      status: 'active',

      emergencyRoomId,
      roomId: emergencyRoomId,

      vehicleInfo: vehicleData,
    };

    this.state.emergencyAlerts.set(
      userId,
      emergencyData
    );

    if (!this.state.emergencyHelpers.has(userId)) {
      this.state.emergencyHelpers.set(
        userId,
        new Set()
      );
    }

    // ============================================================
    // 🔥 Persistir emergencia
    // ============================================================

    try {
      await this.firebase.firestore
        .collection('emergencies')
        .doc(userId)
        .set(
          {
            ...emergencyData,
            isActive: true,
            createdAt: Date.now()
          },
          { merge: true }
        );

      await this.firebase.firestore
        .collection('users')
        .doc(userId)
        .update({
          hasActiveEmergency: true,
          emergencyRoomId,
          lastEmergencyStarted: Date.now()
        });

    } catch (e) {
      this.bestEffort('persistencia', e);
    }

    // ============================================================
    // 💬 Crear sala de emergencia
    // ============================================================

    const emergencyRoom = {
      id: emergencyRoomId,
      name: `Emergencia ${userName}`,
      type: 'emergency',

      description:
        `Sala de emergencia para ${userName}`,

      users: new Set<string>([userId]),

      createdAt: Date.now(),
      messageCount: 0,
    } as any;

    this.state.chatRooms.set(
      emergencyRoomId,
      emergencyRoom
    );

    this.state.emergencyUserRoom.set(
      userId,
      emergencyRoomId
    );

    // ============================================================
    // ✅ Obtener SOLO usuarios dados de alta
    // ============================================================

    const approvedUsersSnap =
      await this.firebase.firestore
        .collection('users')
        .where('state', '==', 'approved')
        .get();

    const approvedUserIds = new Set<string>(
      approvedUsersSnap.docs.map(
        (doc) => doc.id
      )
    );

    // ============================================================
    // 🚨 Avisar al dueño que su sala fue creada
    // ============================================================

    socket.emit(
      'emergency_room_created',
      {
        emergencyUserId: userId,
        emergencyRoomId
      }
    );

    // ============================================================
    // 🔒 CAMBIO 1:
    // new_room_created SOLO a usuarios aprobados
    // ============================================================

    for (
      const [sid, s]
      of this.server.sockets.sockets
    ) {
      if (sid === socket.id) {
        continue;
      }

      const targetUserId =
        (s as any).userId;

      if (!targetUserId) {
        continue;
      }

      // No mandar a otros sockets
      // del dueño de la emergencia
      if (targetUserId === userId) {
        continue;
      }

      // 🚫 Usuario pendiente / rechazado
      if (
        !approvedUserIds.has(targetUserId)
      ) {
        console.log(
          `⛔ new_room_created bloqueado para usuario no aprobado: ${targetUserId}`
        );

        continue;
      }

      // ✅ Usuario aprobado
      this.server
        .to(sid)
        .emit(
          'new_room_created',
          {
            id: emergencyRoom.id,

            name:
              emergencyRoom.name,

            type:
              emergencyRoom.type,

            description:
              emergencyRoom.description,

            userCount:
              emergencyRoom.users.size,

            messageCount:
              emergencyRoom.messageCount,

            createdAt:
              emergencyRoom.createdAt,
          }
        );
    }

    // ============================================================
    // 🔒 CAMBIO 2:
    // emergency_alert SOLO a usuarios aprobados
    // ============================================================

    let socketNotifications = 0;

    const notifiedUsers =
      new Set<string>();

    for (
      const [sid, s]
      of this.server.sockets.sockets
    ) {
      // No mandar al socket que creó la emergencia
      if (sid === socket.id) {
        continue;
      }

      const targetUserId =
        (s as any).userId;

      if (!targetUserId) {
        continue;
      }

      // No mandar al mismo usuario
      if (targetUserId === userId) {
        continue;
      }

      // 🚫 CRÍTICO:
      // solo usuarios dados de alta
      if (
        !approvedUserIds.has(targetUserId)
      ) {
        console.log(
          `⛔ emergency_alert bloqueado para usuario no aprobado: ${targetUserId}`
        );

        continue;
      }

      // ✅ Usuario aprobado
      this.server
        .to(sid)
        .emit(
          'emergency_alert',
          {
            ...emergencyData,
            emergencyRoomId
          }
        );

      socketNotifications++;

      notifiedUsers.add(
        targetUserId
      );
    }

    // ============================================================
    // 📲 Push FCM
    // SOLO usuarios aprobados que NO fueron notificados por socket
    // ============================================================

    let pushNotifications = 0;

    try {
      for (
        const doc
        of approvedUsersSnap.docs
      ) {
        const targetUserId =
          doc.id;

        // No notificar al creador
        if (
          targetUserId === userId
        ) {
          continue;
        }

        // Ya recibió por socket
        if (
          notifiedUsers.has(
            targetUserId
          )
        ) {
          continue;
        }

        const ok =
          await this.notifications
            .sendPushNotification(
              targetUserId,
              '🚨 EMERGENCIA',
              `${userName} necesita ayuda`,
              {
                emergency_user_id:
                  userId,

                emergency_user_name:
                  userName,

                emergency_latitude:
                  latitude,

                emergency_longitude:
                  longitude,

                emergency_avatar_url:
                  avatarUrl || '',

                emergency_room_id:
                  emergencyRoomId,
              }
            );

        if (ok) {
          pushNotifications++;
        }
      }

    } catch (e) {
      this.bestEffort(
        'persistencia',
        e
      );
    }

    // ============================================================
    // ✅ RESPUESTA
    // ============================================================

    void this.audit.record({ actorUid: userId, action: 'emergency_alert', details: { roomId: emergencyRoomId, sockets: socketNotifications, push: pushNotifications } });

    return {
      success: true,

      message:
        'Alerta de emergencia enviada correctamente',

      vehicle:
        vehicleData,

      avatarUrl,

      socketNotifications,

      pushNotifications,

      emergencyRoomId,

      staleReplaced:
        !!lockResult.staleReplaced,
    };

  } catch {

    // ============================================================
    // 🔄 Rollback si algo falla
    // ============================================================

    if (lockAcquired) {
      try {
        await this.emergency.releaseLock({
          userId:
            reqUserId,

          roomId:
            emergencyRoomId ||
            (
              reqUserId
                ? `emergencia_${reqUserId}`
                : null
            ),

          reason:
            'error_during_emergency',
        });

      } catch (e) {
        this.bestEffort(
          'emergency_alert.rollback',
          e
        );
      }
    }

    return {
      success: false,
      code: 'SERVER_ERROR',
      message:
        'Error procesando alerta de emergencia'
    };
  }
}


// ============================================================
// 🤝 CONFIRMAR AYUDA
// ============================================================

@SubscribeMessage('help_confirm')
async helpConfirm(
  @ConnectedSocket() socket: Socket,
  @MessageBody() data: Record<string, any> = {}
) {
  try {
    const {
      emergencyUserId,
      helperId,
      helperName,
      latitude,
      longitude,
      timestamp
    } = data;

    if (
      !emergencyUserId ||
      !helperId
    ) {
      return {
        success: false,
        message: 'Datos incompletos'
      };
    }

    if (
      this.notSelf(
        socket,
        helperId
      )
    ) {
      return this.FORBIDDEN_ACK;
    }

    // ============================================================
    // 🔒 CAMBIO 3:
    // El ayudante debe estar dado de alta
    // ============================================================

    const helperDoc =
      await this.firebase.firestore
        .collection('users')
        .doc(helperId)
        .get();

    if (!helperDoc.exists) {
      return {
        success: false,
        code: 'USER_NOT_FOUND',
        message:
          'Usuario ayudante no encontrado'
      };
    }

    const helperData =
      helperDoc.data() || {};

    if (
      helperData.state !==
      'approved'
    ) {
      console.log(
        `⛔ help_confirm bloqueado. Usuario ${helperId} tiene state=${helperData.state}`
      );

      return {
        success: false,
        code:
          'USER_NOT_APPROVED',

        message:
          'Usuario no habilitado para participar en emergencias'
      };
    }

    // ============================================================
    // ✅ Usuario aprobado
    // ============================================================

    const helpers =
      this.state.emergencyHelpers
        .get(emergencyUserId);

    if (helpers) {
      helpers.add(helperId);
    }

    void this.audit.record({ actorUid: helperId, action: 'help_confirm', targetUid: emergencyUserId });

    // Espejo en Firestore:
    // sobrevive a restart del servidor
    this.firebase.firestore
      .collection('emergencies')
      .doc(emergencyUserId)
      .update({
        helpers:
          admin.firestore.FieldValue
            .arrayUnion(helperId)
      })
      .catch(
        (e) =>
          this.bestEffort(
            'help_confirm.espejo',
            e
          )
      );

    this.server
      .to(emergencyUserId)
      .emit(
        'help_confirmed',
        {
          emergencyUserId,
          helperId,

          helperName:
            helperName ||
            'Ayudante',

          latitude,
          longitude,

          timestamp:
            timestamp ||
            Date.now(),
        }
      );

    this.server
      .to(helperId)
      .emit(
        'help_confirmed_notification',
        {
          emergencyUserId,
          helperId,
          helperName,

          timestamp:
            Date.now()
        }
      );

    return {
      success: true
    };

  } catch (e: any) {
    return {
      success: false,
      message: e.message
    };
  }
}


// ============================================================
// ❌ RECHAZAR AYUDA
// ============================================================

@SubscribeMessage('help_reject')
async helpReject(
  @ConnectedSocket() socket: Socket,
  @MessageBody() data: Record<string, any> = {}
) {
  try {
    const {
      emergencyUserId,
      helperId
    } = data;

    if (
      !emergencyUserId ||
      !helperId
    ) {
      return {
        success: false,
        message: 'Datos incompletos'
      };
    }

    if (
      this.notSelf(
        socket,
        helperId
      )
    ) {
      return this.FORBIDDEN_ACK;
    }

    // ============================================================
    // 🔒 Verificar que siga siendo usuario aprobado
    // ============================================================

    const helperDoc =
      await this.firebase.firestore
        .collection('users')
        .doc(helperId)
        .get();

    if (!helperDoc.exists) {
      return {
        success: false,
        code: 'USER_NOT_FOUND',
        message:
          'Usuario ayudante no encontrado'
      };
    }

    const helperData =
      helperDoc.data() || {};

    if (
      helperData.state !==
      'approved'
    ) {
      console.log(
        `⛔ help_reject bloqueado. Usuario ${helperId} tiene state=${helperData.state}`
      );

      return {
        success: false,
        code:
          'USER_NOT_APPROVED',

        message:
          'Usuario no habilitado para participar en emergencias'
      };
    }

    const helpers =
      this.state.emergencyHelpers
        .get(emergencyUserId);

    if (helpers) {
      helpers.delete(helperId);
    }

    void this.audit.record({ actorUid: helperId, action: 'help_reject', targetUid: emergencyUserId });

    this.firebase.firestore
      .collection('emergencies')
      .doc(emergencyUserId)
      .update({
        helpers:
          admin.firestore.FieldValue
            .arrayRemove(helperId)
      })
      .catch(
        (e) =>
          this.bestEffort(
            'help_reject.espejo',
            e
          )
      );

    this.server
      .to(helperId)
      .emit(
        'help_rejected',
        {
          emergencyUserId,
          helperId,
          timestamp: Date.now()
        }
      );

    return {
      success: true
    };

  } catch (e: any) {
    return {
      success: false,
      message: e.message
    };
  }
}

  @SubscribeMessage('emergency_resolve')
  async emergencyResolve(@ConnectedSocket() socket: Socket, @MessageBody() data: Record<string, any> = {}) {
    try {
      const { userId, reason = 'resolved_by_user' } = data;
      if (!userId) return { success: false, message: 'userId requerido' };
      if (this.notSelf(socket, userId)) return this.FORBIDDEN_ACK;
      if (this.resolveInProgress.has(userId)) return { success: true, message: 'Resolución ya en progreso' };
      this.resolveInProgress.add(userId);

      const emergencyRoomId = this.state.emergencyUserRoom.get(userId) || `emergencia_${userId}`;
      const emergencyData = this.state.emergencyAlerts.get(userId);
      const username = emergencyData?.userName || (socket as any).username || 'Usuario';

      // Sacar los sockets del usuario de la sala
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

      try {
        await this.emergency.releaseLock({ userId, roomId: emergencyRoomId, reason, force: true });
      } catch (e) { this.bestEffort('persistencia', e); }

      void this.audit.record({ actorUid: userId, action: 'emergency_resolve', details: { roomId: emergencyRoomId, reason } });
      this.server.emit('emergency_cancelled', { userId, userName: username, username, roomId: emergencyRoomId, reason, timestamp: Date.now(), isActive: false });
      this.server.to(emergencyRoomId).emit('emergency_resolved', { roomId: emergencyRoomId, userId, message: 'Emergencia resuelta', reason, timestamp: Date.now() });

      const socketsInRoom = this.server.sockets.adapter.rooms.get(emergencyRoomId);
      if (socketsInRoom) {
        for (const sid of Array.from(socketsInRoom)) {
          const s = this.server.sockets.sockets.get(sid);
          if (s) { s.leave(emergencyRoomId); if ((s as any).userId === userId) (s as any).currentRoom = 'general'; }
        }
      }

      this.state.chatRooms.delete(emergencyRoomId);
      this.state.emergencyUserRoom.delete(userId);
      this.state.emergencyAlerts.delete(userId);
      this.state.emergencyHelpers.delete(userId);

      try {
        await this.firebase.firestore.collection('emergencies').doc(userId).update({
          status: 'resolved', isActive: false, resolvedAt: Date.now(), endedAt: Date.now(), roomId: emergencyRoomId, endReason: reason,
        });
      } catch (e) { this.bestEffort('persistencia', e); }
      try {
        await this.firebase.firestore.collection('users').doc(userId).update({
          hasActiveEmergency: false, emergencyRoomId: null, lastEmergencyEnded: Date.now(),
        });
      } catch (e) { this.bestEffort('persistencia', e); }

      // Borrar el historial de chat de la sala de emergencia (portado del monolito; el ack
      // declaraba chatHistoryDeleted:true pero la limpieza no estaba migrada).
      try { await this.deleteRoomMessages(emergencyRoomId); } catch (e) { this.bestEffort('persistencia', e); }

      this.server.to(userId).emit('emergency_fully_cleaned', { userId, roomId: emergencyRoomId, reason, timestamp: Date.now() });
      this.server.emit('user_status_changed', { userId, username, hasActiveEmergency: false, emergencyCleared: true, timestamp: Date.now() });
      this.server.emit('connected_users', Array.from(this.state.connectedUsers.values()).map((u) => ({
        ...u.userData, socketCount: u.sockets.size, currentRoom: u.userData.currentRoom || 'general',
      })));

      setTimeout(() => this.resolveInProgress.delete(userId), 2000);
      return { success: true, message: 'Emergencia resuelta correctamente', emergencyRoomId, chatHistoryDeleted: true };
    } catch (e: any) {
      if (data?.userId) setTimeout(() => this.resolveInProgress.delete(data.userId), 2000);
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
      const { userId, fcmToken, deviceId, platform, deviceModel } = data;
      if (!userId || !fcmToken) return { success: false, message: 'userId y fcmToken requeridos' };
      if (this.notSelf(socket, userId)) return this.FORBIDDEN_ACK;

      const uniqueDeviceId = (typeof deviceId === 'string' && deviceId.trim().length > 0)
        ? deviceId.trim()
        : `device_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

      const userRef = this.firebase.firestore.collection('users').doc(userId);
      await userRef.collection('fcmTokens').doc(uniqueDeviceId).set({
        token: String(fcmToken), platform: platform || 'android', deviceModel: deviceModel || null, socketId: socket.id,
        enabled: true,
        lastActiveAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      await userRef.set({
        socketIds: admin.firestore.FieldValue.arrayUnion(socket.id),
        lastTokenRefreshAt: admin.firestore.FieldValue.serverTimestamp(),
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
      };
      await this.firebase.firestore.collection('messages').add(message);
      const room = this.state.chatRooms.get(roomId);
      if (room) room.messageCount++;

      this.server.to(roomId).emit('audio_message', message);
      socket.emit('message_sent', { id: message.id, ...message });

      const roomUsers = room ? Array.from(room.users) : [];
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
    const batch = this.firebase.firestore.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
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

    // Si tenía emergencia activa y es su última conexión: liberar lock + limpiar (seguridad/vida).
    // EXCEPTO durante el shutdown: ahí el "disconnect" es del server, no del usuario — la
    // emergencia debe sobrevivir al restart (rehidratación, Fase E).
    if (!this.shuttingDown && isLastConnection && this.state.emergencyAlerts.has(userId)) {
      const emergencyRoomId = this.state.emergencyUserRoom.get(userId) || `emergencia_${userId}`;
      try {
        await this.emergency.releaseLock({ userId, roomId: emergencyRoomId, reason: 'user_disconnected_last_socket', force: true });
      } catch (e) { this.bestEffort('persistencia', e); }
      this.state.chatRooms.delete(emergencyRoomId);
      this.state.emergencyUserRoom.delete(userId);
      this.state.emergencyAlerts.delete(userId);
      this.state.emergencyHelpers.delete(userId);
      // Espejo (E1): si la memoria la descarta, Firestore también — si no, la rehidratación
      // del próximo boot resucitaría una emergencia que el server ya dio por terminada.
      try {
        await this.firebase.firestore.collection('emergencies').doc(userId).update({
          status: 'resolved', isActive: false, endedAt: Date.now(), endReason: 'user_disconnected_last_socket',
        });
      } catch (e) { this.bestEffort('disconnect.emergencia.espejo', e); }
    }

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
