/**
 * fcm.controller.ts
 * Rutas REST de gestión de tokens FCM (protegidas por el AuthGuard global).
 * @HttpCode(200) en los POST para igualar el contrato del monolito (Nest da 201).
 */
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { FcmService } from './fcm.service';

@Controller('fcm')
export class FcmController {
  constructor(private readonly service: FcmService) {}

  @Post('cleanup-tokens')
  @HttpCode(200)
  cleanup(@Body() body: Record<string, any>) {
    return this.service.cleanupTokens(body);
  }

  @Get('user-tokens/:userId')
  userTokens(@Param('userId') userId: string) {
    return this.service.getUserTokens(userId);
  }

  @Post('refresh-token')
  @HttpCode(200)
  refresh(@Body() body: Record<string, any>) {
    return this.service.refresh(body);
  }
}
