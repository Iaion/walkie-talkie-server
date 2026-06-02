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

  // ===== Admin =====

  async getVerification(uid: string): Promise<Record<string, any> | null> {
    const d = await this.verifications.doc(uid).get();
    return d.exists ? { uid: d.id, ...(d.data() as Record<string, any>) } : null;
  }

  /** Cola de verificaciones por estado (default: las que esperan review). */
  async listByStatus(status: string): Promise<Record<string, any>[]> {
    const snap = await this.verifications.where('status', '==', status).get();
    return snap.docs.map((d) => ({ uid: d.id, ...(d.data() as Record<string, any>) }));
  }

  /** Aprobar/rechazar: actualiza estado del user y de la verification de forma atómica. */
  async setReviewed(
    uid: string,
    review: { status: UserState; reviewedBy: string; rejectionReason?: string },
  ): Promise<void> {
    const now = Date.now();
    const batch = this.firebase.firestore.batch();
    batch.set(this.users.doc(uid), {
      state: review.status, reviewedBy: review.reviewedBy, reviewedAt: now,
      rejectionReason: review.rejectionReason || null, updatedAt: now,
    }, { merge: true });
    batch.set(this.verifications.doc(uid), {
      status: review.status, reviewedBy: review.reviewedBy, reviewedAt: now,
      rejectionReason: review.rejectionReason || null,
    }, { merge: true });
    await batch.commit();
  }

  /** Al aprobar un renter, su titular_assignment pendiente pasa a activa. */
  async activateTitularAssignment(renterUid: string): Promise<void> {
    const snap = await this.assignments
      .where('renterUid', '==', renterUid)
      .where('status', '==', 'pending')
      .get();
    const batch = this.firebase.firestore.batch();
    snap.docs.forEach((d) => batch.set(d.ref, { status: 'active', activatedAt: Date.now() }, { merge: true }));
    await batch.commit();
  }

  async writeAuditLog(entry: Record<string, any>): Promise<void> {
    await this.auditLogs.add({ ...entry, timestamp: entry.timestamp || Date.now() });
  }

  // ===== Grandfathering (migración puntual de usuarios previos a la verificación) =====

  /** Todos los usuarios. Para el grandfathering (Firestore no puede consultar "campo ausente"). */
  async getAllUsers(): Promise<Record<string, any>[]> {
    const snap = await this.users.get();
    return snap.docs.map((d) => ({ uid: d.id, ...(d.data() as Record<string, any>) }));
  }

  /** Aplica un patch (merge) a muchos usuarios en batches (límite de Firestore = 500). */
  async patchUsers(uids: string[], patch: Record<string, any>): Promise<void> {
    for (let i = 0; i < uids.length; i += 450) {
      const batch = this.firebase.firestore.batch();
      uids.slice(i, i + 450).forEach((uid) => batch.set(this.users.doc(uid), patch, { merge: true }));
      await batch.commit();
    }
  }

  // ===== Cambio de titular =====

  async getActiveAssignmentForRenter(renterUid: string): Promise<Record<string, any> | null> {
    const snap = await this.assignments
      .where('renterUid', '==', renterUid)
      .where('status', '==', 'active')
      .limit(1)
      .get();
    return snap.empty ? null : { id: snap.docs[0].id, ...(snap.docs[0].data() as Record<string, any>) };
  }

  /** Cuántas asignaciones declaró este alquilador desde `sinceMs` (señal de cambios frecuentes). */
  async countAssignmentsSince(renterUid: string, sinceMs: number): Promise<number> {
    const snap = await this.assignments
      .where('renterUid', '==', renterUid)
      .where('startedAt', '>=', sinceMs)
      .get();
    return snap.size;
  }

  /** Cierra la asignación activa, crea la nueva (pending) y vuelve al user a review. Atómico. */
  async applyTitularChange(
    uid: string,
    oldAssignmentId: string | null,
    newAssignment: Record<string, any>,
    verificationPatch: Record<string, any>,
    userPatch: Record<string, any>,
  ): Promise<void> {
    const batch = this.firebase.firestore.batch();
    if (oldAssignmentId) {
      batch.set(this.assignments.doc(oldAssignmentId), { status: 'ended', endedAt: Date.now() }, { merge: true });
    }
    batch.set(this.assignments.doc(newAssignment.id), newAssignment);
    batch.set(this.verifications.doc(uid), verificationPatch, { merge: true });
    batch.set(this.users.doc(uid), userPatch, { merge: true });
    await batch.commit();
  }
}
