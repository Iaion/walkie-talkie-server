/**
 * diagnostics.controller.ts
 * POST /diagnostics/crash — la app Android manda acá, en su siguiente arranque, el stack trace
 * del último cierre inesperado. Queda en la colección `client_crashes` y en la auditoría.
 * Existe porque un crash en el teléfono de un usuario no deja ningún rastro en el servidor y
 * sin esto había que pedirle a la persona que conecte el teléfono por USB.
 */
import { Body, Controller, HttpCode, Logger, Post, Req } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { AuditService } from '../common/audit.service';

const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() ? v.slice(0, max) : null;

@Controller('diagnostics')
export class DiagnosticsController {
  private readonly logger = new Logger(DiagnosticsController.name);

  constructor(private readonly firebase: FirebaseService, private readonly audit: AuditService) {}

  @Post('crash')
  @HttpCode(200)
  async crash(@Req() req: any, @Body() body: Record<string, any> = {}) {
    const stackTrace = text(body.stackTrace, 20_000);
    if (!stackTrace) return { success: false, message: 'stackTrace es requerido' };
    const uid = req.user.uid;
    const report = {
      uid,
      appVersion: text(body.appVersion, 40),
      versionCode: Number.isFinite(Number(body.versionCode)) ? Number(body.versionCode) : null,
      deviceModel: text(body.deviceModel, 80),
      androidVersion: text(String(body.androidVersion ?? ''), 40),
      thread: text(body.thread, 120),
      stackTrace,
      occurredAt: Number.isFinite(Number(body.occurredAt)) ? Number(body.occurredAt) : null,
      receivedAt: Date.now(),
    };
    try {
      await this.firebase.firestore.collection('client_crashes').add(report);
    } catch (e) {
      this.logger.error(`client_crashes no disponible: ${(e as Error).message}`);
      return { success: false, message: 'No se pudo guardar el reporte' };
    }
    const firstLine = stackTrace.split('\n')[0].slice(0, 300);
    this.logger.error(`CRASH app ${report.appVersion} (${report.deviceModel}, Android ${report.androidVersion}) uid=${uid}: ${firstLine}`);
    void this.audit.record({
      actorUid: uid, action: 'client_crash',
      details: { appVersion: report.appVersion, deviceModel: report.deviceModel, androidVersion: report.androidVersion, firstLine },
    });
    return { success: true };
  }
}
