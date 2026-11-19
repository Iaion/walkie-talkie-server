/**
 * Foto del estado de emergencias que un usuario está autorizado a ver: su propia emergencia
 * siempre y, si está aprobado, todas las activas más las terminadas en la última hora.
 * La usan `sync_emergencies` (socket) y `GET /emergencies/feed` (HTTP, sin socket).
 */
import { Injectable } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { StateStore } from './state.store';
import { EmergencyService } from './emergency.service';
import { omit } from '../common/omit';

@Injectable()
export class EmergencyRecoveryService {
  constructor(
    private readonly state: StateStore,
    private readonly firebase: FirebaseService,
    private readonly emergency: EmergencyService,
  ) {}

  async isApproved(uid: string): Promise<boolean> {
    const user = await this.firebase.firestore.collection('users').doc(uid).get();
    return user.data()?.state === 'approved';
  }

  async snapshot(uid: string) {
    const approved = await this.isApproved(uid);
    const emergencies = [...this.state.emergencyAlerts.entries()]
      .filter(([owner]) => owner === uid || approved)
      .map(([owner, alert]) => this.view(owner, alert, uid));
    const recent = approved
      ? this.emergency.recent()
      : this.emergency.recent().filter((e) => e.userId === uid);
    return { success: true, serverTime: Date.now(), emergencies, recent };
  }

  /** Vista pública de una emergencia activa (sin campos internos del servidor). */
  view(owner: string, alert: Record<string, any>, viewerUid?: string) {
    const publicAlert = omit(alert, 'helperNames', 'requestId', 'socketId');
    const helpers = [...(this.state.emergencyHelpers.get(owner) || [])];
    return {
      ...publicAlert,
      userId: owner,
      roomId: this.state.emergencyUserRoom.get(owner) || alert.roomId,
      helpers,
      helpersInfo: this.emergency.helpersInfo(owner),
      helpersCount: helpers.length,
      ...(viewerUid && {
        helpingByMe: helpers.includes(viewerUid),
        declinedByMe: this.state.emergencyDeclined.get(owner)?.has(viewerUid) === true,
      }),
    };
  }
}
