/**
 * verification.controller.ts
 * Endpoints del delivery (protegidos por el AuthGuard global). El uid sale del TOKEN
 * (req.user.uid), nunca del body → un usuario solo puede verificarse a sí mismo.
 */
import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { VerificationService } from './verification.service';
import { VerificationSubmission } from './verification.types';

@Controller('verification')
export class VerificationController {
  constructor(private readonly service: VerificationService) {}

  @Get('me')
  me(@Req() req: any) {
    return this.service.getMyState(req.user.uid, req.user.email);
  }

  @Post()
  @HttpCode(200)
  submit(@Req() req: any, @Body() body: VerificationSubmission) {
    return this.service.submit(req.user.uid, req.user.email, body);
  }

  @Post('change-titular')
  @HttpCode(200)
  changeTitular(@Req() req: any, @Body() body: any) {
    return this.service.changeTitular(req.user.uid, body);
  }

  @Post('photo')
  @HttpCode(200)
  uploadPhoto(@Req() req: any, @Body() body: { type: string; imageData: string }) {
    return this.service.uploadPhoto(req.user.uid, body?.type, body?.imageData);
  }
}
