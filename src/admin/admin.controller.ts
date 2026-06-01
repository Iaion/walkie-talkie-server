/**
 * admin.controller.ts
 * Endpoints de administración (cola de verificaciones). Protegidos por el AuthGuard global
 * (token) + RolesGuard (rol admin). El actorUid sale del token.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';

@Controller('admin')
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminController {
  constructor(private readonly service: AdminService) {}

  @Get('verifications')
  list(@Query('status') status?: string) {
    return this.service.listVerifications(status || 'pending_review');
  }

  @Post('verifications/:uid/approve')
  @HttpCode(200)
  approve(@Req() req: any, @Param('uid') uid: string) {
    return this.service.approve(req.user.uid, uid);
  }

  @Post('verifications/:uid/reject')
  @HttpCode(200)
  reject(@Req() req: any, @Param('uid') uid: string, @Body() body: any) {
    return this.service.reject(req.user.uid, uid, body?.reason);
  }
}
