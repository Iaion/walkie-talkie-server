/**
 * rooms.controller.ts
 * GET /rooms y GET /rooms/:roomId — leen las salas del StateStore en memoria.
 * Mismo contrato que el monolito (404 "Sala no encontrada" si no existe).
 */
import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { StateStore } from './state.store';

@Controller('rooms')
export class RoomsController {
  constructor(private readonly state: StateStore) {}

  @Get()
  list() {
    const rooms = Array.from(this.state.chatRooms.values()).map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      description: r.description,
      userCount: r.users.size,
      messageCount: r.messageCount,
      createdAt: r.createdAt,
    }));
    return { success: true, rooms, total: rooms.length };
  }

  @Get(':roomId')
  get(@Param('roomId') roomId: string) {
    const room = this.state.chatRooms.get(roomId);
    if (!room) throw new NotFoundException({ success: false, message: 'Sala no encontrada' });
    const users = Array.from(room.users)
      .map((uid) => {
        const u = this.state.connectedUsers.get(uid);
        return u ? { id: u.userData.id, username: u.userData.username, avatarUri: u.userData.avatarUri } : null;
      })
      .filter(Boolean);
    return { success: true, room: { ...room, userCount: room.users.size, users } };
  }
}
