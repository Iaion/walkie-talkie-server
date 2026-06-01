/**
 * verification.repository.ts
 * Acceso Firestore del flujo de verificación: usuarios (estado), verifications,
 * titular_assignments, audit_logs. El service no toca db directo.
 */
import { Injectable } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { UserState, VerificationFlag } from './verification.types';

@Injectable()
export class VerificationRepository {
  constructor(private readonly firebase: FirebaseService) {}

  private get users() { return this.firebase.firestore.collection('users'); }
  private get verifications() { return this.firebase.firestore.collection('verifications'); }
  private get assignments() { return this.firebase.firestore.collection('titular_assignments'); }
  private get auditLogs() { return this.firebase.firestore.collection('audit_logs'); }

  async getUser(uid: string): Promise<Record<string, any> | null> {
    const d = await this.users.doc(uid).get();
    return d.exists ? { uid: d.id, ...(d.data() as Record<string, any>) } : null;
  }

  /** Crea el doc de usuario con estado pending_verification si no existe (registro). */
  async ensureUser(uid: string, fields: Record<string, any>): Promise<void> {
    const d = await this.users.doc(uid).get();
    if (d.exists) return;
    await this.users.doc(uid).set({
      uid, role: 'delivery', state: UserState.PENDING_VERIFICATION, createdAt: Date.now(), ...fields,
    }, { merge: true });
  }

  /** Flags por duplicados de email/teléfono/documento normalizados (en otros usuarios). */
  async findDuplicates(
    uid: string,
    fields: { normalizedEmail: string; normalizedPhone: string; normalizedDocument: string },
  ): Promise<VerificationFlag[]> {
    const flags: VerificationFlag[] = [];
    const checks: [string, string, string, string][] = [
      ['normalizedEmail', fields.normalizedEmail, 'DUPLICATE_EMAIL', 'Email ya usado por otra cuenta'],
      ['normalizedPhone', fields.normalizedPhone, 'DUPLICATE_PHONE', 'Teléfono ya usado por otra cuenta'],
      ['normalizedDocument', fields.normalizedDocument, 'DUPLICATE_DOCUMENT', 'Documento ya usado por otra cuenta'],
    ];
    for (const [field, value, code, message] of checks) {
      if (!value) continue;
      const snap = await this.users.where(field, '==', value).get();
      if (snap.docs.some((d) => d.id !== uid)) flags.push({ code, message });
    }
    return flags;
  }

  /** Cuántos alquileres ACTIVOS tiene la cuenta de un titular (señal de cuenta-granja). */
  async countActiveTitularAssignments(titularAccountId: string): Promise<number> {
    if (!titularAccountId) return 0;
    const snap = await this.assignments
      .where('titularAccountId', '==', titularAccountId)
      .where('status', '==', 'active')
      .get();
    return snap.size;
  }

  /** Guarda la submission de forma atómica (user + verification + assignment opcional). */
  async saveSubmission(
    uid: string,
    userPatch: Record<string, any>,
    verificationDoc: Record<string, any>,
    assignment: Record<string, any> | null,
  ): Promise<void> {
    const batch = this.firebase.firestore.batch();
    batch.set(this.users.doc(uid), userPatch, { merge: true });
    batch.set(this.verifications.doc(uid), verificationDoc);
    if (assignment) batch.set(this.assignments.doc(assignment.id), assignment);
    await batch.commit();
  }
}
