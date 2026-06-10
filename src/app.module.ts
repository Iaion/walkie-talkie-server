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
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { FirebaseModule } from './firebase/firebase.module';
import { HealthController } from './health/health.controller';
import { AuthGuard } from './common/auth.guard';
import { VehiclesModule } from './vehicles/vehicles.module';
import { FcmModule } from './fcm/fcm.module';
import { RealtimeModule } from './realtime/realtime.module';
import { VerificationModule } from './verification/verification.module';
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Rate limiting REST (PLAN_MEJORAS A2): por IP. Default generoso para no molestar uso
    // legítimo (la app emite poco REST); override por env en prod. Responde 429 al pasarse.
    ThrottlerModule.forRoot([
      {
        ttl: Number(process.env.REST_RATE_WINDOW_MS) || 60_000,
        limit: Number(process.env.REST_RATE_LIMIT) || 600,
      },
    ]),
    FirebaseModule,
    VehiclesModule,
    FcmModule,
    RealtimeModule,
    VerificationModule,
    AdminModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
