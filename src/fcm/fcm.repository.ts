/**
 * fcm.repository.ts
 * Acceso a Firestore de los tokens FCM (campos del doc users/{uid}). Transacciones para
 * cleanup/refresh. Replica la lógica del monolito (throw "Usuario no encontrado" si no existe).
 */
import { Injectable } from '@nestjs/common';
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
}
