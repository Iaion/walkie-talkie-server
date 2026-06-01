/**
 * verification.service.ts
 * Lógica del registro + verificación (Fase 3). Corre los CRUCES ANTIFRAUDE y maneja la
 * máquina de estados del usuario. El admin (en otro módulo) aprueba/rechaza.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { VerificationRepository } from './verification.repository';
import { normalizeEmail, normalizePhone, normalizeDocument } from './normalize';
import { AccountType, UserState, VerificationFlag, VerificationSubmission } from './verification.types';

@Injectable()
export class VerificationService {
  /** Tope de alquileres simultáneos por titular antes de levantar flag (cuenta-granja). */
  private readonly MAX_RENTERS_PER_TITULAR = 5;

  constructor(private readonly repo: VerificationRepository) {}

  /** Estado del usuario para el gating. Crea el doc (pending_verification) si es la 1ª vez. */
  async getMyState(uid: string, email?: string) {
    let user = await this.repo.getUser(uid);
    if (!user) {
      await this.repo.ensureUser(uid, { email: email || null });
      user = await this.repo.getUser(uid);
    }
    return {
      uid,
      state: user?.state || UserState.PENDING_VERIFICATION,
      accountType: user?.accountType || null,
      role: user?.role || 'delivery',
    };
  }

  /** El delivery envía su verificación → cruces → estado pending_review. */
  async submit(uid: string, email: string | undefined, body: VerificationSubmission) {
    const missing = this.validateRequired(body);
    if (missing.length) {
      throw new BadRequestException({ success: false, message: 'Faltan datos requeridos', missing });
    }

    const normalizedEmail = normalizeEmail(email || '');
    const normalizedPhone = normalizePhone(body.phone);
    const normalizedDocument = normalizeDocument(body.documentNumber);

    // Cruces automáticos → flags (no bloquean, los ve el admin)
    const flags: VerificationFlag[] = await this.repo.findDuplicates(uid, {
      normalizedEmail, normalizedPhone, normalizedDocument,
    });
    if (body.accountType === AccountType.RENTER && body.titular?.accountId) {
      const count = await this.repo.countActiveTitularAssignments(body.titular.accountId);
      if (count >= this.MAX_RENTERS_PER_TITULAR) {
        flags.push({ code: 'TITULAR_OVER_LIMIT', message: `El titular ya tiene ${count} alquileres activos (posible cuenta-granja)` });
      }
    }

    const now = Date.now();
    const userPatch = {
      uid, role: 'delivery', accountType: body.accountType, state: UserState.PENDING_REVIEW,
      fullName: body.fullName, phone: body.phone, documentNumber: body.documentNumber,
      normalizedEmail, normalizedPhone, normalizedDocument, email: email || null, updatedAt: now,
    };
    const verificationDoc = { uid, ...body, status: UserState.PENDING_REVIEW, flags, submittedAt: now };

    let assignment: Record<string, any> | null = null;
    if (body.accountType === AccountType.RENTER && body.titular) {
      assignment = {
        id: uuidv4(), renterUid: uid,
        titularName: body.titular.name, titularDocument: body.titular.document, titularAccountId: body.titular.accountId,
        status: 'pending', startedAt: now,
      };
    }

    await this.repo.saveSubmission(uid, userPatch, verificationDoc, assignment);
    return { success: true, state: UserState.PENDING_REVIEW, flags };
  }

  private validateRequired(body: VerificationSubmission): string[] {
    const missing: string[] = [];
    if (!body.accountType || ![AccountType.OWNER, AccountType.RENTER].includes(body.accountType)) missing.push('accountType');
    for (const f of ['selfieUrl', 'deliveryAppScreenshotUrl', 'documentUrl', 'fullName', 'phone', 'documentNumber'] as const) {
      if (!body[f]) missing.push(f);
    }
    if (body.accountType === AccountType.RENTER) {
      for (const f of ['renterFaceUrl', 'workPhonePhotoUrl'] as const) {
        if (!body[f]) missing.push(f);
      }
      if (!body.titular || !body.titular.name || !body.titular.document || !body.titular.accountId) missing.push('titular');
    }
    return missing;
  }
}
