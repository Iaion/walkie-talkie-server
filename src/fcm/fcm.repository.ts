/**
 * fcm.repository.ts
 * Acceso a Firestore de los tokens FCM (campos del doc users/{uid}). Transacciones para
 * cleanup/refresh. Replica la lógica del monolito (throw "Usuario no encontrado" si no existe).
 */
import { Injectable } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { FirebaseService } from '../firebase/firebase.service';

@Injectable()
export class FcmRepository {
  constructor(private readonly firebase: FirebaseService) {}

  private userRef(userId: string) {
    return this.firebase.firestore.collection('users').doc(userId);
  }

  async getUser(userId: string): Promise<Record<string, any> | null> {
    const doc = await this.userRef(userId).get();
    return doc.exists ? (doc.data() as Record<string, any>) : null;
  }

  async cleanupTokens(userId: string, invalidTokens: string[]): Promise<number> {
    const ref = this.userRef(userId);
    let removedCount = 0;
    await this.firebase.firestore.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw new Error('Usuario no encontrado');
      const data = doc.data() as Record<string, any>;
      const currentTokens: string[] = data.fcmTokens || [];
      const currentFcmToken: string = data.fcmToken || '';
      const currentDevices: Record<string, any> = data.devices || {};

      const validTokens = currentTokens.filter((t) => !invalidTokens.includes(t));
      const newFcmToken = invalidTokens.includes(currentFcmToken) ? '' : currentFcmToken;
      const validDevices: Record<string, any> = {};
      Object.entries(currentDevices).forEach(([deviceId, info]: [string, any]) => {
        if (info.token && !invalidTokens.includes(info.token)) validDevices[deviceId] = info;
        else removedCount++;
      });

      tx.update(ref, {
        fcmTokens: validTokens,
        fcmToken: newFcmToken,
        devices: validDevices,
        tokensCleanedAt: Date.now(),
        tokensCleanedCount: invalidTokens.length,
      });
    });
    return removedCount;
  }

  async refreshToken(
    userId: string,
    { oldToken, newToken, deviceId }: { oldToken?: string; newToken: string; deviceId?: string },
  ): Promise<void> {
    const ref = this.userRef(userId);
    const now = Date.now();
    await this.firebase.firestore.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw new Error('Usuario no encontrado');
      const data = doc.data() as Record<string, any>;
      let currentTokens: string[] = data.fcmTokens || [];
      const currentDevices: Record<string, any> = data.devices || {};

      if (oldToken && currentTokens.includes(oldToken)) {
        currentTokens = currentTokens.filter((t) => t !== oldToken);
      }
      if (!currentTokens.includes(newToken)) currentTokens.push(newToken);

      const updatedDevices = { ...currentDevices };
      if (deviceId && updatedDevices[deviceId]) {
        updatedDevices[deviceId] = {
          ...updatedDevices[deviceId],
          token: newToken,
          lastActive: now,
          lastTokenRefresh: now,
        };
      }

      tx.update(ref, {
        fcmTokens: currentTokens,
        fcmToken: newToken,
        fcmTokensUpdatedAt: now,
        devices: updatedDevices,
        lastTokenRefresh: now,
      });
    });
  }

  private devicesRef(userId: string) {
    return this.userRef(userId).collection('fcmTokens');
  }

  /**
   * Registra el token en `users/{uid}/fcmTokens/{deviceId}`: el ÚNICO lugar que lee el envío
   * de notificaciones. Antes el registro por HTTP escribía solo en campos del usuario que el
   * envío no mira, así que un token renovado con la app cerrada no servía para nada.
   */
  async upsertDeviceToken(
    userId: string,
    d: { deviceId: string; token: string; oldToken?: string; platform?: string; deviceModel?: string | null; appVersion?: string | null },
  ): Promise<void> {
    const stamp = admin.firestore.FieldValue.serverTimestamp();
    const batch = this.firebase.firestore.batch();
    // El mismo token (o el que este reemplaza) no debe quedar activo bajo otro deviceId del usuario.
    const existing = await this.devicesRef(userId).get();
    existing.docs.forEach((doc) => {
      const t = doc.data()?.token;
      if (doc.id !== d.deviceId && (t === d.token || (d.oldToken && t === d.oldToken))) {
        batch.set(doc.ref, { enabled: false, supersededAt: stamp, updatedAt: stamp }, { merge: true });
      }
    });
    batch.set(this.devicesRef(userId).doc(d.deviceId), {
      token: d.token, platform: d.platform || 'android',
      deviceModel: d.deviceModel || null, appVersion: d.appVersion || null,
      enabled: true, source: 'http',
      lastActiveAt: stamp, updatedAt: stamp, createdAt: stamp,
    }, { merge: true });
    batch.set(this.userRef(userId), {
      lastTokenRefreshAt: stamp,
      ...(d.appVersion && { appVersion: d.appVersion, appVersionAt: Date.now() }),
      ...(d.deviceModel && { appDevice: d.deviceModel }),
    }, { merge: true });
    await batch.commit();
  }

  /** Dispositivos con token habilitado (los que pueden recibir alertas). */
  async activeDevices(userId: string): Promise<{ deviceId: string; token: string }[]> {
    const snap = await this.devicesRef(userId).where('enabled', '==', true).get();
    return snap.docs
      .map((doc) => ({ deviceId: doc.id, token: String(doc.data()?.token || '').trim() }))
      .filter((x) => x.token.length > 0);
  }

  /** Da de baja el token de un dispositivo (cierre de sesión). */
  async disableDevice(userId: string, deviceId: string): Promise<void> {
    const stamp = admin.firestore.FieldValue.serverTimestamp();
    await this.devicesRef(userId).doc(deviceId).set(
      { enabled: false, disabledAt: stamp, updatedAt: stamp, disabledReason: 'logout' }, { merge: true },
    );
  }
}
