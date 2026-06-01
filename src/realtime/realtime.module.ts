/**
 * realtime.module.ts
 * Núcleo del realtime: el StateStore (estado en memoria compartido) y el Gateway Socket.IO.
 * Exporta StateStore para que los módulos REST que leen estado (users/rooms/emergencies)
 * lo inyecten.
 */
import { Module } from '@nestjs/common';
import { StateStore } from './state.store';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  providers: [StateStore, RealtimeGateway],
  exports: [StateStore],
})
export class RealtimeModule {}
