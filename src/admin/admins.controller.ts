/**
 * admins.controller.ts
 * Endpoints de gestión de administradores. SOLO superadmin (el RolesGuard rechaza
 * a los admin comunes: la ruta pide el rol mayor).
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AdminsService } from './admins.service';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';

@Controller('admin/admins')
@UseGuards(RolesGuard)
@Roles('superadmin')
export class AdminsController {
  constructor(private readonly service: AdminsService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Post()
  @HttpCode(200)
  grant(@Req() req: any, @Body() body: any) {
    return this.service.grant(req.user.uid, body?.email);
  }

  @Delete(':uid')
  revoke(@Req() req: any, @Param('uid') uid: string) {
    return this.service.revoke(req.user.uid, uid);
  }
}
