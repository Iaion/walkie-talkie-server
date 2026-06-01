/**
 * realtime.gateway.ts
 * Gateway Socket.IO de NestJS. Comparte el puerto HTTP (8080) con la app.
 * - Auth en el handshake (portado del io.use de Fase 1): sin ID token válido, no hay conexión.
 * - Eventos migrados del monolito (se van agregando por grupos). Empezamos con user-connected.
 * El valor retornado por cada @SubscribeMessage se envía como ACK al cliente (emitWithAck).
 */
import { Injectable } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
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

@WebSocketGateway({
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
})
@Injectable()
export class RealtimeGateway implements OnGatewayInit {
  @WebSocketServer() server: Server;

  constructor(
    private readonly state: StateStore,
    private readonly firebase: FirebaseService,
    private readonly notifications: NotificationsService,
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
    } catch {
      // no romper la conexión si falla la sync con Firestore
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
      } catch {
        // historial best-effort
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
    const { userId, username, text } = data;
    const roomId = data.roomId || (socket as any).currentRoom || 'general';

    if (!userId || !username || !text) return { success: false, message: '❌ Datos de mensaje inválidos' };
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
  async updateLocation(@MessageBody() data: Record<string, any> = {}) {
    try {
      const { userId, lat, lng, timestamp } = data;
      if (!userId || typeof lat !== 'number' || typeof lng !== 'number') {
        return { success: false, message: 'Datos inválidos' };
      }
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
    try {
      const { roomId, userId, lat, lng, timestamp, accuracy } = data;
      if (!roomId || !userId || typeof lat !== 'number' || typeof lng !== 'number') {
        return { success: false, message: 'Datos de ubicación inválidos' };
      }
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
      } catch {
        // persistencia best-effort
      }
      return { success: true };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

  @SubscribeMessage('update_helper_location')
  async updateHelperLocation(@ConnectedSocket() socket: Socket, @MessageBody() data: Record<string, any> = {}) {
    try {
      const { roomId, helperId, emergencyUserId, lat, lng, timestamp, accuracy } = data;
      if (!roomId || !helperId || typeof lat !== 'number' || typeof lng !== 'number') {
        return { success: false, message: 'Datos de ubicación inválidos' };
      }
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
      } catch {
        // best-effort
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
        } catch {
          // best-effort
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
          } catch {
            // best-effort
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
      if (emergencyUserId) {
        this.server.to(emergencyUserId).emit('helper_driving_update', { helperId, isDriving, timestamp: Date.now() });
      }
      socket.to(roomId).emit('helper_driving_update', { helperId, isDriving, timestamp: Date.now() });
    } catch {
      // fire-and-forget
    }
  }
}
