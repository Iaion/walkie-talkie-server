/**
 * users.module.ts
 * Perfil de usuario vía API (PLAN_MEJORAS C2) — el reemplazo server-mediated de las
 * escrituras directas a users/{uid} que hacía el prototipo Android.
 */
import { Module } from '@nestjs/common';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';

@Module({
  controllers: [ProfileController],
  providers: [ProfileService],
})
export class UsersModule {}
