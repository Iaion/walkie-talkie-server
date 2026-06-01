/**
 * notifications.module.ts
 * Expone NotificationsService (push FCM) para que lo usen chat (send_message) y alerts.
 */
import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

@Module({
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
