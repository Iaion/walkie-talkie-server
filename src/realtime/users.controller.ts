/**
 * users.controller.ts
 * GET /users — lista de usuarios conectados (lee del StateStore en memoria, no de Firestore).
 * Mismo contrato que el monolito.
 */
import { Controller, Get } from '@nestjs/common';
import { StateStore, publicUserData } from './state.store';

@Controller('users')
export class UsersController {
  constructor(private readonly state: StateStore) {}

  @Get()
  list() {
    return Array.from(this.state.connectedUsers.values())
      .filter((u) => u.sockets.size > 0)
      .map((u) => ({ ...publicUserData(u.userData), socketCount: u.sockets.size }));
  }
}
