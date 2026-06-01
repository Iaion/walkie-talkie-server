/**
 * vehicles.controller.ts
 * Rutas REST de vehículos (protegidas por el AuthGuard global). Solo reciben y delegan al service.
 * Rutas literales (photo, :userId/primary) declaradas antes que las de parámetros sueltos.
 * AUTORIZACIÓN POR-USUARIO (assertSelf): el userId (path o body) debe ser el del token; antes
 * el server confiaba en el userId del cliente y dejaba tocar datos ajenos (deuda heredada del prototipo).
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { VehiclesService } from './vehicles.service';
import { assertSelf } from '../common/ownership';

// El monolito responde 200 en los POST (res.json()), no 201. @HttpCode(200) preserva el contrato.
@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly service: VehiclesService) {}

  @Post('photo')
  @HttpCode(200)
  uploadPhoto(@Req() req: any, @Body() body: Record<string, any>) {
    if (body?.userId) assertSelf(req, body.userId);
    return this.service.uploadPhoto(body);
  }

  @Post(':userId/primary')
  @HttpCode(200)
  setPrimary(@Req() req: any, @Param('userId') userId: string, @Body() body: Record<string, any>) {
    assertSelf(req, userId);
    return this.service.setPrimary(userId, body?.vehicleId);
  }

  @Post()
  @HttpCode(200)
  upsert(@Req() req: any, @Body() body: Record<string, any>) {
    if (body?.userId) assertSelf(req, body.userId);
    return this.service.upsert(body);
  }

  @Get(':userId/:vehicleId')
  getOne(@Req() req: any, @Param('userId') userId: string, @Param('vehicleId') vehicleId: string) {
    assertSelf(req, userId);
    return this.service.getOne(userId, vehicleId);
  }

  @Get(':userId')
  list(@Req() req: any, @Param('userId') userId: string) {
    assertSelf(req, userId);
    return this.service.listByUser(userId);
  }

  @Delete(':userId/:vehicleId')
  remove(@Req() req: any, @Param('userId') userId: string, @Param('vehicleId') vehicleId: string) {
    assertSelf(req, userId);
    return this.service.remove(userId, vehicleId);
  }
}
