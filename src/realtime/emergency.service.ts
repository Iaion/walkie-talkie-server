/**
 * emergency.service.ts
 * Lock GLOBAL de emergencia (LOCKS/active_emergency) — una emergencia a la vez.
 * Portado del monolito: acquire (con reemplazo de lock viejo por TTL) + release (force).
 * Transacciones Firestore para evitar carreras.
 */
import { Injectable } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';

export interface AcquireResult {
  allowed: boolean;
  staleReplaced?: boolean;
  activeEmergency?: { userId: string | null; roomId: string | null; startedAt: number | null };
}

@Injectable()
export class EmergencyService {
  private readonly LOCK_TTL_MS = 5 * 60 * 1000; // 5 min

  constructor(private readonly firebase: FirebaseService) {}

  private get lockRef() {
    return this.firebase.firestore.collection('LOCKS').doc('active_emergency');
  }

  async acquireLock(userId: string, emergencyRoomId: string, emergencyType: string): Promise<AcquireResult> {
    return this.firebase.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(this.lockRef);
      const lock = snap.exists ? (snap.data() || {}) : null;

      if (lock?.active === true) {
        const startedAt = typeof lock.startedAt === 'number' ? lock.startedAt : 0;
        const age = Date.now() - startedAt;

        if (startedAt > 0 && age > this.LOCK_TTL_MS) {
          // lock viejo (stale) → lo reemplazamos
          tx.set(this.lockRef, {
            active: true, userId, roomId: emergencyRoomId, startedAt: Date.now(), emergencyType,
            replacedStaleLock: true,
            previousLock: { userId: lock.userId || null, roomId: lock.roomId || null, startedAt: lock.startedAt || null },
          }, { merge: true });
          return { allowed: true, staleReplaced: true };
        }

        return {
          allowed: false,
          activeEmergency: { userId: lock.userId || null, roomId: lock.roomId || null, startedAt: lock.startedAt || null },
        };
      }

      tx.set(this.lockRef, { active: true, userId, roomId: emergencyRoomId, startedAt: Date.now(), emergencyType }, { merge: true });
      return { allowed: true };
    });
  }

  async releaseLock(opts: { userId?: string | null; roomId?: string | null; reason?: string; force?: boolean }): Promise<void> {
    const { userId = null, roomId = null, reason = 'manual_or_system', force = false } = opts;
    const now = Date.now();
    await this.firebase.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(this.lockRef);
      if (!snap.exists) {
        tx.set(this.lockRef, {
          active: false, releasedAt: now, releaseReason: reason,
          userId: null, roomId: null, emergencyType: 'general', previousLock: null, createdAt: now,
        });
        return;
      }
      const lock = snap.data() || {};
      if (lock.active !== true) return; // idempotente
      if (!force && userId && lock.userId && lock.userId !== userId) return; // de otro usuario
      tx.update(this.lockRef, {
        active: false, releasedAt: now, releaseReason: reason,
        releasedBy: userId || null, releasedRoomId: roomId || null,
        userId: null, roomId: null, emergencyType: 'general',
      });
    });
  }
}
