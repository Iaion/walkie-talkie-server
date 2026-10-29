/** Envía FCM aunque exista un socket: emitir al socket no confirma recepción en el teléfono. */
import { Injectable } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../common/audit.service';

@Injectable()
export class EmergencyPushService {
  constructor(private readonly notifications: NotificationsService, private readonly audit: AuditService) {}

  async deliver(alert: Record<string, any>, recipients: string[]): Promise<void> {
    const vehicle = alert.vehicleInfo;
    const payload = {
      type: 'emergency', timestamp: alert.timestamp,
      emergency_user_id: alert.userId, emergency_user_name: alert.userName,
      emergency_latitude: alert.latitude, emergency_longitude: alert.longitude,
      emergency_avatar_url: alert.avatarUrl || '', emergency_room_id: alert.roomId,
      vehicle_type: vehicle?.type ?? '', vehicle_marca: vehicle?.brand ?? '',
      vehicle_modelo: vehicle?.model ?? '', vehicle_color: vehicle?.color ?? '',
      vehicle_description: vehicle?.description ?? '', vehicle_foto: vehicle?.photoUri ?? '',
      vehicle_patente: vehicle?.type === 'BICYCLE' ? '' : vehicle?.licensePlate ?? '',
      vehicle_frame_serial_number: vehicle?.type === 'BICYCLE' ? vehicle?.frameSerialNumber ?? '' : '',
    };
    let accepted = 0;
    // Concurrencia acotada. Este trabajo no retiene el ACK del botón SOS.
    for (let i = 0; i < recipients.length; i += 4) {
      const results = await Promise.allSettled(recipients.slice(i, i + 4).map(uid =>
        this.notifications.sendPushNotification(uid, '🚨 EMERGENCIA', `${alert.userName} necesita ayuda`, payload),
      ));
      accepted += results.filter(r => r.status === 'fulfilled' && r.value).length;
    }
    await this.audit.record({ actorUid: alert.userId, action: 'emergency_push_result', details: {
      roomId: alert.roomId, timestamp: alert.timestamp, recipients: recipients.length,
      acceptedByFcm: accepted, // aceptación de FCM; NO confirmación de lectura/entrega al celular
    } });
  }
}
