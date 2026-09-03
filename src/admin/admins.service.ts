/**
 * admins.service.ts
 * Gestión de administradores del panel (solo superadmin): listar, dar y quitar el rol admin.
 * Los superadmins no se administran desde acá (se setean por script, decisión de seguridad:
 * el panel jamás puede fabricar ni degradar un superadmin). Todo queda en audit_logs.
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { VerificationRepository } from '../verification/verification.repository';

const PANEL_ROLES = ['admin', 'superadmin'];

@Injectable()
export class AdminsService {
  constructor(
    private readonly firebase: FirebaseService,
    private readonly repo: VerificationRepository,
  ) {}

  /** Lista todos los usuarios con rol de panel (admin o superadmin). */
  async list() {
    const admins: Array<{ uid: string; email: string | null; role: string }> = [];
    let pageToken: string | undefined;
    do {
      const page = await this.firebase.auth.listUsers(1000, pageToken);
      for (const u of page.users) {
        const role = (u.customClaims?.role as string) || '';
        if (PANEL_ROLES.includes(role)) admins.push({ uid: u.uid, email: u.email || null, role });
      }
      pageToken = page.pageToken;
    } while (pageToken);
    admins.sort((a, b) => (a.role === b.role ? (a.email || '').localeCompare(b.email || '') : a.role.localeCompare(b.role)));
    return { success: true, admins };
  }

  /** Auditoría: los últimos movimientos, con el email del actor resuelto para lectura humana. */
  async listAudit(limit = 100) {
    const capped = Math.min(Math.max(limit, 1), 500);
    const snap = await this.firebase.firestore
      .collection('audit_logs')
      .orderBy('timestamp', 'desc')
      .limit(capped)
      .get();

    // Resolver uids → emails en tanda (los logs guardan uid; el panel muestra personas).
    const uids = new Set<string>();
    snap.docs.forEach((d) => {
      const e = d.data();
      if (e.actorUid) uids.add(e.actorUid);
      if (e.targetUid) uids.add(e.targetUid);
    });
    const emails = new Map<string, string>();
    await Promise.all(
      [...uids].map(async (uid) => {
        try {
          const u = await this.firebase.auth.getUser(uid);
          emails.set(uid, u.email || uid);
        } catch {
          emails.set(uid, uid); // usuario borrado: queda el uid
        }
      }),
    );

    const entries = snap.docs.map((d) => {
      const e = d.data();
      return {
        id: d.id,
        action: e.action,
        actor: emails.get(e.actorUid) || e.actorUid || null,
        target: e.targetUid ? emails.get(e.targetUid) || e.targetUid : null,
        details: e.details || null,
        timestamp: e.timestamp || null,
      };
    });
    return { success: true, entries, total: entries.length };
  }

  /** Da rol admin a un usuario EXISTENTE (por email). No crea cuentas ni toca contraseñas. */
  async grant(actorUid: string, email: string) {
    const clean = (email || '').trim().toLowerCase();
    if (!clean) throw new BadRequestException({ success: false, message: 'Falta el email' });

    let user;
    try {
      user = await this.firebase.auth.getUserByEmail(clean);
    } catch {
      throw new NotFoundException({
        success: false,
        message: 'No existe una cuenta con ese email. La persona tiene que registrarse primero.',
      });
    }

    const current = (user.customClaims?.role as string) || '';
    if (current === 'superadmin') throw new BadRequestException({ success: false, message: 'Esa cuenta es superadmin: no se toca desde el panel.' });
    if (current === 'admin') throw new BadRequestException({ success: false, message: 'Esa cuenta ya es admin.' });

    await this.firebase.auth.setCustomUserClaims(user.uid, { ...(user.customClaims || {}), role: 'admin' });
    await this.repo.writeAuditLog({ actorUid, action: 'grant_admin', targetUid: user.uid, details: { email: clean } });
    return { success: true, uid: user.uid, email: clean, role: 'admin' };
  }

  /** Quita el rol admin. A un superadmin no lo toca nadie desde el panel. */
  async revoke(actorUid: string, targetUid: string) {
    let user;
    try {
      user = await this.firebase.auth.getUser(targetUid);
    } catch {
      throw new NotFoundException({ success: false, message: 'Usuario no encontrado' });
    }

    const current = (user.customClaims?.role as string) || '';
    if (current === 'superadmin') throw new BadRequestException({ success: false, message: 'Un superadmin no se puede quitar desde el panel.' });
    if (current !== 'admin') throw new BadRequestException({ success: false, message: 'Esa cuenta no es admin.' });

    const claims = { ...(user.customClaims || {}) } as Record<string, unknown>;
    delete claims.role;
    await this.firebase.auth.setCustomUserClaims(targetUid, claims);
    await this.repo.writeAuditLog({ actorUid, action: 'revoke_admin', targetUid, details: { email: user.email || null } });
    return { success: true, uid: targetUid };
  }
}
