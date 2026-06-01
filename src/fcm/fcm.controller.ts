/**
 * fcm.controller.ts
 * Rutas REST de gestión de tokens FCM (protegidas por el AuthGuard global).
 * @HttpCode(200) en los POST para igualar el contrato del monolito (Nest da 201).
 * AUTORIZACIÓN POR-USUARIO (assertSelf): un usuario solo gestiona sus propios tokens.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { FcmService } from './fcm.service';
import { assertSelf } from '../common/ownership';

@Controller('fcm')
export class FcmController {
  constructor(private readonly service: FcmService) {}

  @Post('cleanup-tokens')
  @HttpCode(200)
  cleanup(@Req() req: any, @Body() body: Record<string, any>) {
    if (body?.userId) assertSelf(req, body.userId);
    return this.service.cleanupTokens(body);
  }

  @Get('user-tokens/:userId')
  userTokens(@Req() req: any, @Param('userId') userId: string) {
    assertSelf(req, userId);
    return this.service.getUserTokens(userId);
  }

  @Post('refresh-token')
  @HttpCode(200)
  refresh(@Req() req: any, @Body() body: Record<string, any>) {
    if (body?.userId) assertSelf(req, body.userId);
    return this.service.refresh(body);
  }
}
