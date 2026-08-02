/**
 * vehicles.module.ts
 * Módulo de vehículos: CRUD + foto. Primer módulo migrado del monolito (Fase 2).
 */
import { Module } from '@nestjs/common';
import { VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';
import { VehiclesRepository } from './vehicles.repository';

@Module({
  controllers: [VehiclesController],
  providers: [VehiclesService, VehiclesRepository],
})
export class VehiclesModule {}
