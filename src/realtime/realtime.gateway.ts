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
import { FirebaseService } from '../firebase/firebase.service';
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
}
