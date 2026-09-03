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
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggingInterceptor } from './common/logging.interceptor';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { FirebaseModule } from './firebase/firebase.module';
import { AuditModule } from './common/audit.module';
import { HealthController } from './health/health.controller';
import { AuthGuard } from './common/auth.guard';
import { VehiclesModule } from './vehicles/vehicles.module';
import { FcmModule } from './fcm/fcm.module';
import { RealtimeModule } from './realtime/realtime.module';
import { VerificationModule } from './verification/verification.module';
import { AdminModule } from './admin/admin.module';
import { UsersModule } from './users/users.module';

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
    AuditModule,
    VehiclesModule,
    FcmModule,
    RealtimeModule,
    VerificationModule,
    AdminModule,
    UsersModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Auditoría operativa: cada pedido REST queda logueado (quién, qué, resultado, duración).
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
export class AppModule {}
