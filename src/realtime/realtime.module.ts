/**
 * realtime.module.ts
 * Núcleo del realtime: el StateStore (estado en memoria compartido) y el Gateway Socket.IO.
 * Exporta StateStore para que los módulos REST que leen estado (users/rooms/emergencies)
 * lo inyecten.
 */
import { Module } from '@nestjs/common';
import { StateStore } from './state.store';
import { RealtimeGateway } from './realtime.gateway';
import { EmergencyService } from './emergency.service';
import { UsersController } from './users.controller';
import { RoomsController } from './rooms.controller';
import { EmergenciesController } from './emergencies.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [UsersController, RoomsController, EmergenciesController],
  providers: [StateStore, RealtimeGateway, EmergencyService],
  exports: [StateStore],
})
export class RealtimeModule {}
