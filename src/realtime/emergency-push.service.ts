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
      emergency_id: alert.emergencyId || '', emergency_replaced: alert.replaced ? 'true' : '',
      // En un reemplazo: id del pedido anterior, para que quien ya lo atendía no vuelva a oír la alarma.
      previous_emergency_id: alert.previousEmergencyId || '',
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
    // A quiénes NO se les pudo mandar (sin token válido o FCM rechazó todos): con nombre y
    // apellido en la auditoría, para que alguien les avise que abran la app.
    const unreachable: string[] = [];
    // Concurrencia acotada. Este trabajo no retiene el ACK del botón SOS.
    for (let i = 0; i < recipients.length; i += 4) {
      const chunk = recipients.slice(i, i + 4);
      const results = await Promise.allSettled(chunk.map(uid =>
        this.notifications.sendPushNotification(uid, '🚨 EMERGENCIA', `${alert.userName} necesita ayuda`, payload),
      ));
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled' && r.value) accepted++;
        else unreachable.push(chunk[idx]);
      });
    }
    await this.audit.record({ actorUid: alert.userId, action: 'emergency_push_result', details: {
      roomId: alert.roomId, emergencyId: alert.emergencyId || null, timestamp: alert.timestamp,
      recipients: recipients.length,
      acceptedByFcm: accepted, // aceptación de FCM; NO confirmación de lectura/entrega al celular
      unreachable: unreachable.slice(0, 100),
    } });
  }

  /**
   * La emergencia terminó: push silencioso (solo datos) para que los teléfonos con la app
   * cerrada saquen SU notificación y corten la alarma. Sin esto, quien no tiene la app abierta
   * sigue viendo como activo un pedido que ya se canceló.
   */
  async notifyEnded(ended: { userId: string; userName: string; emergencyId: string; endReason: string }, recipients: string[]): Promise<void> {
    const payload = {
      type: 'emergency_ended', timestamp: Date.now(),
      emergency_id: ended.emergencyId, emergency_user_id: ended.userId, emergency_user_name: ended.userName,
      reason: ended.endReason,
    };
    for (let i = 0; i < recipients.length; i += 4) {
      await Promise.allSettled(recipients.slice(i, i + 4).map((uid) =>
        this.notifications.sendPushNotification(uid, 'Pedido de ayuda finalizado', `El pedido de ${ended.userName} terminó`, payload),
      ));
    }
  }

  /** A quien pidió ayuda: alguien va en camino (por si tiene la app en segundo plano). */
  async notifyHelpConfirmed(victimId: string, helper: { id: string; name: string }, emergencyId: string): Promise<void> {
    await this.notifications.sendPushNotification(victimId, 'Ayuda en camino', `${helper.name} va a ayudarte`, {
      type: 'help_confirmed', timestamp: Date.now(),
      emergency_id: emergencyId || '', emergency_user_id: victimId,
      helperId: helper.id, helperName: helper.name,
    });
  }
}
