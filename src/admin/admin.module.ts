/**
 * admin.module.ts
 * Administración (Fase 3): review de verificaciones. Reusa el VerificationRepository
 * y NotificationsService.
 */
import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { VerificationModule } from '../verification/verification.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [VerificationModule, NotificationsModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
