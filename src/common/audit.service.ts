/**
 * audit.service.ts
 * Registro PERMANENTE de acciones en la colección audit_logs (la misma que ya usaban las
 * acciones de admin, mismo esquema: actorUid, action, targetUid?, details?, timestamp).
 * Best-effort deliberado: la auditoría jamás rompe la operación que audita — si Firestore
 * falla, se loguea el problema y la acción del usuario sigue su curso.
 */
import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';

export interface AuditEntry {
  actorUid: string;
  action: string;
  targetUid?: string;
  details?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly firebase: FirebaseService) {}

  /** Registra y NO lanza. Además deja línea en el log operativo (Railway). */
  async record(entry: AuditEntry): Promise<void> {
    this.logger.log(`AUDIT ${entry.action}: actor=${entry.actorUid}${entry.targetUid ? ` target=${entry.targetUid}` : ''}`);
    try {
      await this.firebase.firestore.collection('audit_logs').add({ ...entry, timestamp: Date.now() });
    } catch (e) {
      this.logger.error(`audit_logs no disponible (${entry.action}): ${(e as Error).message}`);
    }
  }
}
