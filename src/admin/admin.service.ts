/**
 * admin.service.ts
 * Review de verificaciones por el admin: listar cola, aprobar, rechazar (con motivo).
 * Escribe audit_logs (server-side, no el cliente) y notifica al usuario. Al aprobar un
 * renter, activa su titular_assignment.
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { VerificationRepository } from '../verification/verification.repository';
import { NotificationsService } from '../notifications/notifications.service';
import { FirebaseService } from '../firebase/firebase.service';
import { UserState } from '../verification/verification.types';

@Injectable()
export class AdminService {
  /** Campos de la verificación que son fotos (datos sensibles, subidas privadas). */
  private readonly PHOTO_FIELDS = ['selfieUrl', 'deliveryAppScreenshotUrl', 'documentUrl', 'renterFaceUrl', 'workPhonePhotoUrl'];

  constructor(
    private readonly repo: VerificationRepository,
    private readonly notifications: NotificationsService,
    private readonly firebase: FirebaseService,
  ) {}

  /**
   * Cola para el panel. Con limit/offset pagina (G2; `hasMore` para el "cargar más");
   * sin limit devuelve todo (contrato original intacto).
   */
  async listVerifications(status: string = UserState.PENDING_REVIEW, limit?: number, offset?: number) {
    const page = limit && limit > 0 ? { limit, offset: Math.max(0, offset || 0) } : undefined;
    const { items, hasMore } = await this.repo.listByStatus(status, page);
    return { success: true, verifications: items, total: items.length, hasMore };
  }

  /**
   * Devuelve URLs temporales (firmadas, 15 min) para que el admin vea las fotos PRIVADAS de una
   * verificación. Los campos que ya son URLs http se pasan tal cual; los que son paths de Storage
   * se firman. Si el entorno no puede firmar (emulador), cae al path para no romper el panel.
   */
  async getVerificationPhotos(targetUid: string) {
    const v = await this.repo.getVerification(targetUid);
    if (!v) throw new NotFoundException({ success: false, message: 'Verificación no encontrada' });

    const photos: Record<string, string> = {};
    for (const field of this.PHOTO_FIELDS) {
      const val = (v as any)[field];
      if (!val || typeof val !== 'string') continue;
      photos[field] = /^https?:\/\//i.test(val) ? val : await this.signedUrl(val);
    }
    return { success: true, photos };
  }

  /**
   * Grandfathering: los usuarios que existían ANTES del sistema de verificación (sin campo `state`)
   * quedarían bloqueados por el gating al desplegar. Esto los marca como APPROVED (grandfathered).
   * apply=false (default) solo PREVISUALIZA (cuántos y quiénes), no escribe nada.
   * NO toca el `role` a propósito (para no pisar admins que no tengan `state`).
   */
  async grandfather(adminUid: string, apply: boolean) {
    const all = await this.repo.getAllUsers();
    const legacy = all.filter((u) => !u.state); // sin estado = previos a la verificación
    const uids = legacy.map((u) => u.uid);

    if (!apply) {
      return { success: true, applied: false, count: uids.length, uids };
    }

    const now = Date.now();
    await this.repo.patchUsers(uids, {
      state: UserState.APPROVED,
      grandfathered: true,
      grandfatheredAt: now,
      updatedAt: now,
    });
    await this.repo.writeAuditLog({ actorUid: adminUid, action: 'grandfather_users', details: { count: uids.length } });
    return { success: true, applied: true, count: uids.length };
  }

  private async signedUrl(path: string): Promise<string> {
    try {
      const [url] = await this.firebase.storage.bucket().file(path).getSignedUrl({
        action: 'read',
        expires: Date.now() + 15 * 60 * 1000,
      });
      return url;
    } catch {
      return path; // fallback (emulador sin capacidad de firmar): el panel recibe el path
    }
  }

  async approve(adminUid: string, targetUid: string) {
    const v = await this.repo.getVerification(targetUid);
    if (!v) throw new NotFoundException({ success: false, message: 'Verificación no encontrada' });

    await this.repo.setReviewed(targetUid, { status: UserState.APPROVED, reviewedBy: adminUid });
    if (v.accountType === 'renter') await this.repo.activateTitularAssignment(targetUid);
    await this.repo.writeAuditLog({ actorUid: adminUid, action: 'approve_verification', targetUid });
    await this.notifications.sendPushNotification(targetUid, '✅ Verificación aprobada', 'Tu cuenta fue aprobada. Ya podés usar AlRescate.', { type: 'verification_approved' });

    return { success: true, state: UserState.APPROVED };
  }

  async reject(adminUid: string, targetUid: string, reason: string) {
    if (!reason || !String(reason).trim()) {
      throw new BadRequestException({ success: false, message: 'Motivo de rechazo requerido' });
    }
    const v = await this.repo.getVerification(targetUid);
    if (!v) throw new NotFoundException({ success: false, message: 'Verificación no encontrada' });

    await this.repo.setReviewed(targetUid, { status: UserState.REJECTED, reviewedBy: adminUid, rejectionReason: reason });
    await this.repo.writeAuditLog({ actorUid: adminUid, action: 'reject_verification', targetUid, details: { reason } });
    await this.notifications.sendPushNotification(targetUid, '❌ Verificación rechazada', `Motivo: ${reason}`, { type: 'verification_rejected', reason });

    return { success: true, state: UserState.REJECTED, reason };
  }
}
