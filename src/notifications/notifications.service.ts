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
    try {
      const devices = await this.getActiveFcmTokens(userId);
      const tokens = devices.map((d) => d.token);
      if (!tokens.length) return false;

      const merged: Record<string, any> = {
        ...data,
        title,
        body,
        timestamp: Date.now(),
        emergency_user_id: data.emergency_user_id ?? data.userId ?? '',
        emergency_user_name: data.emergency_user_name ?? data.userName ?? '',
        emergency_latitude: data.emergency_latitude ?? data.latitude ?? '',
        emergency_longitude: data.emergency_longitude ?? data.longitude ?? '',
        emergency_avatar_url: data.emergency_avatar_url ?? data.avatarUrl ?? '',
        emergency_room_id: data.emergency_room_id ?? data.roomId ?? '',
        vehicle_foto: data.vehicle_foto ?? data.fotoVehiculoUri ?? '',
        vehicle_marca: data.vehicle_marca ?? data.marca ?? '',
        vehicle_modelo: data.vehicle_modelo ?? data.modelo ?? '',
        vehicle_patente: data.vehicle_patente ?? data.patente ?? '',
        vehicle_color: data.vehicle_color ?? data.color ?? '',
      };
      const safeData = Object.fromEntries(
        Object.entries(merged).map(([k, v]) => [k, v == null ? '' : String(v)]),
      );

      const res = await this.firebase.messaging.sendEachForMulticast({
        tokens,
        android: { priority: 'high' },
        data: safeData,
        apns: { headers: { 'apns-priority': '10' }, payload: { aps: { 'content-available': 1 } } },
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
    } catch {
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
