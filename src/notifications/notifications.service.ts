/**
 * notifications.service.ts
 * Envío de push FCM (portado del monolito: getActiveFcmTokens + sendToUserDevices).
 * Lee los tokens de la subcolección users/{uid}/fcmTokens (enabled), manda multicast,
 * y deshabilita tokens inválidos. Lo usan chat (send_message) y emergency_alert.
 */

import { Injectable } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { FirebaseService } from '../firebase/firebase.service';

interface Device {
  deviceId: string;
  token: string;
}

@Injectable()
export class NotificationsService {
  constructor(private readonly firebase: FirebaseService) {}

  private get db() {
    return this.firebase.firestore;
  }

  async getActiveFcmTokens(userId: string): Promise<Device[]> {
    const snap = await this.db
      .collection('users').doc(userId)
      .collection('fcmTokens')
      .where('enabled', '==', true)
      .get();

    const devices: Device[] = [];
    snap.forEach((doc) => {
      const d = doc.data() || {};
      const token = typeof d.token === 'string' ? d.token.trim() : '';
      if (token.length > 0) devices.push({ deviceId: doc.id, token });
    });

    // dedupe manteniendo el primer deviceId
    const seen = new Set<string>();
    const uniq: Device[] = [];
    for (const d of devices) {
      if (!seen.has(d.token)) {
        seen.add(d.token);
        uniq.push(d);
      }
    }
    return uniq;
  }

  /** Alias semántico (igual que el monolito). */
  async sendPushNotification(userId: string, title: string, body: string, data: Record<string, any> = {}): Promise<boolean> {
    return this.sendToUserDevices(userId, title, body, data);
  }

  async sendToUserDevices(userId: string, title: string, body: string, data: Record<string, any> = {}): Promise<boolean> {
    // Firebase no ofrece emulador de FCM. Las pruebas locales nunca envían push a la nube.
    if (process.env.FIREBASE_AUTH_EMULATOR_HOST) return false;
    try {
      const devices = await this.getActiveFcmTokens(userId);
      const tokens = devices.map((d) => d.token);
      if (!tokens.length) {
        console.warn(
          `⚠️ No hay tokens FCM activos para el usuario ${userId}`,
        );
        return false;
      }

      const merged: Record<string, any> = {
        ...data,
        title,
        body,
        timestamp: data.timestamp ?? Date.now(),
        emergency_user_id: data.emergency_user_id ?? data.userId ?? '',
        emergency_user_name: data.emergency_user_name ?? data.userName ?? '',
        emergency_latitude: data.emergency_latitude ?? data.latitude ?? '',
        emergency_longitude: data.emergency_longitude ?? data.longitude ?? '',
        emergency_avatar_url: data.emergency_avatar_url ?? data.avatarUrl ?? '',
        emergency_room_id: data.emergency_room_id ?? data.roomId ?? '',
       vehicle_type:
  data.vehicle_type ?? data.vehicleType ?? data.typeVehiculo ?? '',

vehicle_foto:
  data.vehicle_foto ?? data.fotoVehiculoUri ?? '',

vehicle_marca:
  data.vehicle_marca ?? data.marca ?? '',

vehicle_modelo:
  data.vehicle_modelo ?? data.modelo ?? '',

vehicle_patente:
  data.vehicle_patente ?? data.patente ?? '',

vehicle_frame_serial_number:
  data.vehicle_frame_serial_number ??
  data.frameSerialNumber ??
  '',

vehicle_color:
  data.vehicle_color ?? data.color ?? '',

vehicle_description:
  data.vehicle_description ??
  data.vehicleDescription ??
  data.description ??
  data.descripcion ??
  '',
      };
      const safeData = Object.fromEntries(
        Object.entries(merged).map(([k, v]) => [k, v == null ? '' : String(v)]),
      );

      console.log(`📲 Enviando FCM a usuario ${userId}`);
      console.log(`📱 Dispositivos encontrados: ${devices.length}`);
      console.log(`🔑 Tokens encontrados: ${tokens.length}`);
      console.log(`📦 Tipo de mensaje: ${safeData.type}`);
      console.log(`🆘 Emergency user: ${safeData.emergency_user_id}`);
      console.log(`🚗 Vehicle type: ${safeData.vehicle_type}`);

      const res = await this.firebase.messaging.sendEachForMulticast({
        tokens,
        android: {
          priority: 'high',
          ...(data.type === 'emergency' ? { ttl: 60_000 } : {}),
        },
        data: safeData,
        apns: {
          headers: {
            'apns-priority': '10',
          },
          payload: {
            aps: {
              'content-available': 1,
            },
          },
        },
      });

      console.log(
        `📨 FCM resultado usuario ${userId}: success=${res.successCount}, failure=${res.failureCount}`,
      );

      res.responses.forEach((response, index) => {
        if (response.success) {
          console.log(
            `✅ FCM enviado correctamente al dispositivo ${devices[index]?.deviceId}`,
          );
        } else {
          console.error(
            `❌ Error FCM dispositivo ${devices[index]?.deviceId}:`,
            response.error?.code,
            response.error?.message,
          );
        }
      });

      // Deshabilitar tokens inválidos
      const invalidDeviceIds: string[] = [];
      res.responses.forEach((r, idx) => {
        if (!r.success) {
          const code = r.error?.code || '';
          if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token'
          ) {
            if (devices[idx]?.deviceId) invalidDeviceIds.push(devices[idx].deviceId);
          }
        }
      });
      if (invalidDeviceIds.length) await this.disableInvalidDevices(userId, invalidDeviceIds);

      return res.successCount > 0;
    } catch (error) {
      console.error(
        `❌ Error general enviando FCM al usuario ${userId}:`,
        error,
      );

      return false;
    }
  }

  private async disableInvalidDevices(userId: string, deviceIds: string[]): Promise<void> {
    if (!deviceIds.length) return;
    const batch = this.db.batch();
    const base = this.db.collection('users').doc(userId).collection('fcmTokens');
    deviceIds.forEach((id) => {
      batch.set(
        base.doc(id),
        {
          enabled: false,
          invalidatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });
    await batch.commit();
  }
}
