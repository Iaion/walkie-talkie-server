/**
 * profile.controller.ts
 * GET/PUT /users/:uid/profile — perfil propio vía API (la app NO toca Firestore directo).
 * Autorización por-usuario con assertSelf (el uid sale del token; admin exento).
 * Convive con el GET /users del realtime (lista en memoria): rutas distintas.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import { ProfileService } from './profile.service';
import { assertSelf } from '../common/ownership';

@Controller('users')
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get(':uid/profile')
  get(@Param('uid') uid: string, @Req() req: any) {
    assertSelf(req, uid);
    return this.profile.getProfile(uid);
  }

  @Put(':uid/profile')
  put(@Param('uid') uid: string, @Req() req: any, @Body() body: Record<string, any> = {}) {
    assertSelf(req, uid);
    return this.profile.upsertProfile(uid, req?.user?.email, body);
  }

  @Post(':uid/avatar')
  @HttpCode(200)
  avatar(@Param('uid') uid: string, @Req() req: any, @Body() body: Record<string, any> = {}) {
    assertSelf(req, uid);
    return this.profile.uploadAvatar(uid, body.imageData);
  }
}
