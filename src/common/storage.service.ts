/**
 * storage.service.ts
 * Upload de archivos a Storage UNIFICADO (PLAN_MEJORAS D5). Antes la misma lógica
 * (parsear data URL → Buffer → save → makePublic) vivía duplicada en 5 lugares
 * (avatar del gateway, avatar REST, audio, foto de vehículo, foto de verificación);
 * un bug se parcheaba cinco veces. Acá está una sola vez, parametrizada.
 */
import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { FirebaseService } from '../firebase/firebase.service';
import { getMimeFromDataUrl, getBase64FromDataUrl } from './image-utils';

export interface UploadDataUrlOptions {
  dataUrl: string;
  /** MIME explícito (ej. audio): si no se pasa, se detecta como imagen (getMimeFromDataUrl). */
  mime?: string;
  /** Carpeta destino, ej. `avatars/${uid}` (sin slash final). */
  pathPrefix: string;
  /** Nombre del archivo; default `${Date.now()}_${uuid}.${ext}`. */
  fileName?: string;
  /** true = URL pública (avatares, vehículos, audio); false = queda privado (verificación). */
  makePublic: boolean;
  /** Metadata custom (queda en metadata.metadata del objeto). */
  metadata?: Record<string, string>;
  cacheControl?: string;
  /** Si se pasa, borra los archivos previos bajo ese prefijo (best-effort). */
  cleanupPrefix?: string;
}

export interface UploadResult {
  path: string;
  /** URL pública (solo si makePublic). */
  url: string | null;
  mime: string;
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(private readonly firebase: FirebaseService) {}

  async uploadDataUrl(opts: UploadDataUrlOptions): Promise<UploadResult> {
    const mime = opts.mime ?? getMimeFromDataUrl(opts.dataUrl);
    const ext = mime.split('/')[1] || 'jpg';
    const base64 = getBase64FromDataUrl(opts.dataUrl);
    if (!base64) throw new Error('Data URL inválida (sin base64)');
    const buffer = Buffer.from(base64, 'base64');

    if (opts.cleanupPrefix) {
      try {
        const [oldFiles] = await this.firebase.storage.bucket().getFiles({ prefix: opts.cleanupPrefix });
        await Promise.all(oldFiles.map((f) => f.delete().catch(() => undefined)));
      } catch (e) {
        this.logger.warn(`cleanup best-effort falló [${opts.cleanupPrefix}]: ${(e as Error)?.message}`);
      }
    }

    const fileName = opts.fileName ?? `${Date.now()}_${uuidv4()}.${ext}`;
    const path = `${opts.pathPrefix}/${fileName}`;
    const file = this.firebase.storage.bucket().file(path);
    await file.save(buffer, {
      contentType: mime,
      resumable: false,
      metadata: {
        ...(opts.cacheControl ? { cacheControl: opts.cacheControl } : {}),
        ...(opts.metadata ? { metadata: opts.metadata } : {}),
      },
    });

    let url: string | null = null;
    if (opts.makePublic) {
      await file.makePublic();
      url = file.publicUrl();
    }
    return { path, url, mime };
  }
}
