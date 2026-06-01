/**
 * vehicles.controller.ts
 * Rutas REST de vehículos (protegidas por el AuthGuard global). Solo reciben y delegan al service.
 * Rutas literales (photo, :userId/primary) declaradas antes que las de parámetros sueltos.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { VehiclesService } from './vehicles.service';

// El monolito responde 200 en los POST (res.json()), no 201. @HttpCode(200) preserva el contrato.
@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly service: VehiclesService) {}

  @Post('photo')
  @HttpCode(200)
  uploadPhoto(@Body() body: Record<string, any>) {
    return this.service.uploadPhoto(body);
  }

  @Post(':userId/primary')
  @HttpCode(200)
  setPrimary(@Param('userId') userId: string, @Body() body: Record<string, any>) {
    return this.service.setPrimary(userId, body?.vehicleId);
  }

  @Post()
  @HttpCode(200)
  upsert(@Body() body: Record<string, any>) {
    return this.service.upsert(body);
  }

  @Get(':userId/:vehicleId')
  getOne(@Param('userId') userId: string, @Param('vehicleId') vehicleId: string) {
    return this.service.getOne(userId, vehicleId);
  }

  @Get(':userId')
  list(@Param('userId') userId: string) {
    return this.service.listByUser(userId);
  }

  @Delete(':userId/:vehicleId')
  remove(@Param('userId') userId: string, @Param('vehicleId') vehicleId: string) {
    return this.service.remove(userId, vehicleId);
  }
}
