/**
 * fcm.module.ts
 * Módulo de gestión de tokens FCM (endpoints REST). El evento Socket.IO register_fcm_token
 * se migrará junto con el Gateway de realtime.
 */
import { Module } from '@nestjs/common';
import { FcmController } from './fcm.controller';
import { FcmService } from './fcm.service';
import { FcmRepository } from './fcm.repository';

@Module({
  controllers: [FcmController],
  providers: [FcmService, FcmRepository],
})
export class FcmModule {}
