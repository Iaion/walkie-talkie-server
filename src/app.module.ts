/**
 * app.module.ts
 * Módulo raíz. Ensambla los módulos de la app y registra el AuthGuard como guard GLOBAL
 * (todo endpoint requiere token salvo los marcados @Public).
 * A medida que avanza el estrangulamiento (Fase 2), se irán importando aquí los módulos
 * migrados del monolito: users, verification, alerts, location, realtime, notifications,
 * vehicles, chat, admin.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { FirebaseModule } from './firebase/firebase.module';
import { HealthController } from './health/health.controller';
import { AuthGuard } from './common/auth.guard';
import { VehiclesModule } from './vehicles/vehicles.module';
import { FcmModule } from './fcm/fcm.module';
import { RealtimeModule } from './realtime/realtime.module';
import { VerificationModule } from './verification/verification.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), FirebaseModule, VehiclesModule, FcmModule, RealtimeModule, VerificationModule],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
