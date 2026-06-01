/**
 * verification.service.ts
 * Lógica del registro + verificación (Fase 3). Corre los CRUCES ANTIFRAUDE y maneja la
 * máquina de estados del usuario. El admin (en otro módulo) aprueba/rechaza.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { VerificationRepository } from './verification.repository';
import { FirebaseService } from '../firebase/firebase.service';
import { normalizeEmail, normalizePhone, normalizeDocument } from './normalize';
import { isDataUrl, getMimeFromDataUrl, getBase64FromDataUrl } from '../common/image-utils';
import { AccountType, UserState, VerificationFlag, VerificationSubmission } from './verification.types';

@Injectable()
export class VerificationService {
  /** Tope de alquileres simultáneos por titular antes de levantar flag (cuenta-granja). */
  private readonly MAX_RENTERS_PER_TITULAR = 5;
  private readonly PHOTO_TYPES = ['selfie', 'deliveryAppScreenshot', 'document', 'renterFace', 'workPhone'];

  constructor(
    private readonly repo: VerificationRepository,
    private readonly firebase: FirebaseService,
  ) {}

  /**
   * Sube una foto de verificación a Storage de forma PRIVADA (datos sensibles, Ley 25.326):
   * sin makePublic. Devuelve el path del objeto; el admin lo verá con URL firmada.
   */
  async uploadPhoto(uid: string, type: string, imageData: string) {
    if (!this.PHOTO_TYPES.includes(type)) {
      throw new BadRequestException({ success: false, message: 'Tipo de foto inválido' });
    }
    if (!isDataUrl(imageData)) {
      throw new BadRequestException({ success: false, message: 'imageData inválido (no es data URL de imagen)' });
    }
    const mime = getMimeFromDataUrl(imageData);
    const ext = mime.split('/')[1] || 'jpg';
    const base64 = getBase64FromDataUrl(imageData);
    if (!base64) throw new BadRequestException({ success: false, message: 'Data URL inválida' });
    const buffer = Buffer.from(base64, 'base64');
    const path = `verifications/${uid}/${type}_${Date.now()}.${ext}`;
    const file = this.firebase.storage.bucket().file(path);
    await file.save(buffer, { contentType: mime, resumable: false, metadata: { metadata: { uid, type } } });
    // Privado: NO makePublic. El acceso lo da el admin con URL firmada.
    return { success: true, type, path };
  }

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

  /**
   * El alquilador cambia de titular (PLAN §4.1): NO se re-pide identidad (selfie/documento),
   * solo el nuevo titular + nueva captura del perfil de la app. Cierra la asignación activa,
   * crea una nueva (pending), y vuelve el usuario a pending_review (review liviano).
   */
  async changeTitular(uid: string, body: { titular?: any; deliveryAppScreenshotUrl?: string }) {
    const missing: string[] = [];
    if (!body.deliveryAppScreenshotUrl) missing.push('deliveryAppScreenshotUrl');
    if (!body.titular || !body.titular.name || !body.titular.document || !body.titular.accountId) missing.push('titular');
    if (missing.length) throw new BadRequestException({ success: false, message: 'Faltan datos requeridos', missing });

    const now = Date.now();
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const flags: VerificationFlag[] = [];
    const recentChanges = await this.repo.countAssignmentsSince(uid, now - THIRTY_DAYS);
    if (recentChanges >= 3) {
      flags.push({ code: 'FREQUENT_TITULAR_CHANGES', message: `Cambió de titular ${recentChanges} veces en el último mes` });
    }

    const active = await this.repo.getActiveAssignmentForRenter(uid);
    const newAssignment = {
      id: uuidv4(), renterUid: uid,
      titularName: body.titular.name, titularDocument: body.titular.document, titularAccountId: body.titular.accountId,
      status: 'pending', startedAt: now, kind: 'titular_change',
    };
    const verificationPatch = {
      accountType: AccountType.RENTER,
      titular: body.titular,
      deliveryAppScreenshotUrl: body.deliveryAppScreenshotUrl,
      status: UserState.PENDING_REVIEW,
      flags,
      titularChangedAt: now,
    };
    const userPatch = { state: UserState.PENDING_REVIEW, accountType: AccountType.RENTER, updatedAt: now };

    await this.repo.applyTitularChange(uid, active?.id || null, newAssignment, verificationPatch, userPatch);
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
