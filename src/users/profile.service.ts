/**
 * profile.service.ts
 * Perfil del usuario en Firestore (users/{uid}) vía API — reemplaza las escrituras DIRECTAS
 * del prototipo Android (saveUserToFirestore / obtenerODatosFirestore), que se rompen con las
 * rules deny-all (PLAN_MEJORAS C2).
 * Seguridad: WHITELIST de campos. El cliente NUNCA puede escribir roles / isVerified / state /
 * isOnline / fcmToken — esos los maneja el backend (verification, gateway de presencia, /fcm).
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { FirebaseService } from '../firebase/firebase.service';
import { getMimeFromDataUrl, getBase64FromDataUrl, isDataUrl } from '../common/image-utils';

@Injectable()
export class ProfileService {
  constructor(private readonly firebase: FirebaseService) {}

  async getProfile(uid: string): Promise<Record<string, unknown>> {
    const doc = await this.firebase.firestore.collection('users').doc(uid).get();
    if (!doc.exists) {
      throw new NotFoundException({ success: false, message: 'Usuario inexistente' });
    }
    return { success: true, profile: { id: uid, ...doc.data() } };
  }

  /**
   * Upsert con merge: crea el doc si no existe (cubre el "crear usuario al primer login" del
   * prototipo) y solo pisa los campos enviados. Los alias legacy (cel/telefono/phoneNumber,
   * avatarUrl/photoURL) los deriva el server para mantener compatibilidad con datos viejos.
   */
  async upsertProfile(uid: string, email: string | undefined, data: Record<string, any>): Promise<Record<string, unknown>> {
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

    const out: Record<string, unknown> = { id: uid };
    if (str(data.fullName) !== undefined) out.fullName = str(data.fullName);
    if (str(data.username) !== undefined) out.username = str(data.username);
    const phone = str(data.phone);
    if (phone !== undefined) Object.assign(out, { phone, cel: phone, telefono: phone, phoneNumber: phone });
    const avatar = str(data.avatarUri) ?? str(data.avatarUrl);
    if (avatar !== undefined) Object.assign(out, { avatarUri: avatar, avatarUrl: avatar, photoURL: avatar });
    if (str(data.status) !== undefined) out.status = str(data.status);
    if (str(data.presence) !== undefined) out.presence = str(data.presence);
    if (num(data.joinedAt) !== undefined) out.joinedAt = num(data.joinedAt);
    if (num(data.lastLogin) !== undefined) out.lastLogin = num(data.lastLogin);

    // Campos que fija el server (no el cliente):
    if (email) out.email = email; // del token, no del payload
    out.lastUpdated = Date.now();
    out.lastAccess = Date.now();

    const ref = this.firebase.firestore.collection('users').doc(uid);
    await this.firebase.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) out.createdAt = Date.now();
      tx.set(ref, out, { merge: true });
    });
    return { success: true };
  }

  /**
   * Sube el avatar vía API (reemplaza el upload directo a Storage del prototipo, que se rompe
   * con las storage.rules deny-all). Misma lógica que el update_profile del gateway: borra los
   * avatares viejos del usuario (best-effort) y publica el nuevo. Devuelve la URL pública.
   * (La unificación de uploads en un StorageService es Fase D5.)
   */
  async uploadAvatar(uid: string, imageData: unknown): Promise<Record<string, unknown>> {
    if (typeof imageData !== 'string' || !isDataUrl(imageData)) {
      throw new BadRequestException({ success: false, message: 'imageData debe ser una data URL base64' });
    }
    const mime = getMimeFromDataUrl(imageData);
    const ext = mime.split('/')[1] || 'jpg';
    const base64 = getBase64FromDataUrl(imageData);
    if (!base64) throw new BadRequestException({ success: false, message: 'Data URL inválida (sin base64)' });
    const buffer = Buffer.from(base64, 'base64');
    try {
      const [oldFiles] = await this.firebase.storage.bucket().getFiles({ prefix: `avatars/${uid}/` });
      await Promise.all(oldFiles.map((f) => f.delete().catch(() => undefined)));
    } catch { /* best-effort: no romper el upload por la limpieza */ }
    const filePath = `avatars/${uid}/${Date.now()}_${uuidv4()}.${ext}`;
    const file = this.firebase.storage.bucket().file(filePath);
    await file.save(buffer, {
      contentType: mime,
      resumable: false,
      metadata: { cacheControl: 'public, max-age=31536000', metadata: { userId: uid } },
    });
    await file.makePublic();
    const url = file.publicUrl();
    await this.firebase.firestore.collection('users').doc(uid).set(
      { avatarUri: url, avatarUrl: url, photoURL: url, lastUpdated: Date.now() },
      { merge: true },
    );
    return { success: true, url };
  }
}
