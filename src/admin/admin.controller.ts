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
  list(@Query('status') status?: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.service.listVerifications(
      status || 'pending_review',
      limit ? Number(limit) : undefined,
      offset ? Number(offset) : undefined,
    );
  }

  @Get('verifications/:uid/photos')
  photos(@Param('uid') uid: string) {
    return this.service.getVerificationPhotos(uid);
  }

  /** Directorio de usuarios (todos los registrados, con estado y rol). */
  @Get('users')
  users() {
    return this.service.listUsers();
  }

  // Grandfathering de usuarios previos al sistema de verificación.
  @Get('grandfather/preview')
  grandfatherPreview(@Req() req: any) {
    return this.service.grandfather(req.user.uid, false);
  }

  @Post('grandfather')
  @HttpCode(200)
  grandfatherApply(@Req() req: any) {
    return this.service.grandfather(req.user.uid, true);
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
