/**
 * users.controller.ts
 * GET /users — usuarios conectados (lee del StateStore en memoria). Contrato heredado del monolito.
 * GET /users/community — miembros de la comunidad (usuarios aprobados), conectados y
 *   desconectados, para la lista de la Sala general. Solo datos públicos: nombre, avatar,
 *   si está en línea y cuándo se lo vio por última vez. Solo la pueden pedir usuarios aprobados
 *   y administradores.
 */
import { Controller, ForbiddenException, Get, Req } from '@nestjs/common';
import { StateStore, publicUserData } from './state.store';
import { FirebaseService } from '../firebase/firebase.service';

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

@Controller('users')
export class UsersController {
  constructor(private readonly state: StateStore, private readonly firebase: FirebaseService) {}

  @Get()
  list() {
    return Array.from(this.state.connectedUsers.values())
      .filter((u) => u.sockets.size > 0)
      .map((u) => ({ ...publicUserData(u.userData), socketCount: u.sockets.size }));
  }

  @Get('community')
  async community(@Req() req: any) {
    const snap = await this.firebase.firestore.collection('users').where('state', '==', 'approved').get();
    const role = req?.user?.role;
    const isStaff = role === 'admin' || role === 'superadmin';
    if (!isStaff && !snap.docs.some((d) => d.id === req.user.uid)) {
      throw new ForbiddenException({ success: false, message: 'Solo para usuarios habilitados' });
    }

    const members = snap.docs.map((d) => {
      const u = d.data() || {};
      const live = this.state.connectedUsers.get(d.id);
      const online = !!live && live.sockets.size > 0;
      const username = (typeof u.username === 'string' && u.username.trim())
        || (live?.userData?.username as string) || 'Usuario';
      return {
        id: d.id,
        username,
        avatarUrl: u.avatarUrl || u.avatarUri || null,
        online,
        // Última señal conocida (para "últ. vez hace 2 h"). Si está en línea, es ahora.
        lastSeen: online ? Date.now() : Math.max(num(u.lastSeen), num(u.lastActive), num(u.lastLogin)) || null,
      };
    });
    // En línea primero; después, los vistos más recientemente; a igualdad, por nombre.
    members.sort((a, b) =>
      Number(b.online) - Number(a.online)
      || num(b.lastSeen) - num(a.lastSeen)
      || a.username.localeCompare(b.username));

    return {
      success: true,
      serverTime: Date.now(),
      total: members.length,
      onlineCount: members.filter((m) => m.online).length,
      members,
    };
  }
}
