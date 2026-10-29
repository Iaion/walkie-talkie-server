/** Estado autorizado para recuperar una emergencia tras perder la conexión o reiniciar Android. */
import { Injectable } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { StateStore } from './state.store';

@Injectable()
export class EmergencyRecoveryService {
  constructor(private readonly state: StateStore, private readonly firebase: FirebaseService) {}

  async snapshot(uid: string) {
    const user = await this.firebase.firestore.collection('users').doc(uid).get();
    const approved = user.data()?.state === 'approved';
    const emergencies = [...this.state.emergencyAlerts.entries()]
      .filter(([owner]) => owner === uid || approved)
      .map(([owner, alert]) => ({
        ...alert,
        userId: owner,
        roomId: this.state.emergencyUserRoom.get(owner) || alert.roomId,
        helpers: [...(this.state.emergencyHelpers.get(owner) || [])],
      }));
    return { success: true, emergencies };
  }
}
