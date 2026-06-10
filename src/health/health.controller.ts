/**
 * health.controller.ts
 * Endpoints públicos de salud.
 * - GET /health: liveness — replica el contrato del monolito ("Servidor operativo 🚀").
 *   Lo usan el harness de tests y el HEALTHCHECK del Docker. NO tocar la respuesta.
 * - GET /health/deep: readiness (D6) — verifica que Firestore responda de verdad.
 *   Para monitoreo externo; un 503 acá con /health en 200 = el proceso vive pero
 *   no puede hablar con la base.
 */
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../common/public.decorator';
import { FirebaseService } from '../firebase/firebase.service';

@Controller()
export class HealthController {
  constructor(private readonly firebase: FirebaseService) {}

  @Public()
  @Get('health')
  health(): string {
    return 'Servidor operativo 🚀';
  }

  @Public()
  @Get('health/deep')
  async deep(): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    try {
      // Lectura barata: un doc que puede no existir (igual valida la conexión).
      await this.firebase.firestore.collection('LOCKS').doc('active_emergency').get();
      return { status: 'ok', firestore: 'ok', latencyMs: Date.now() - startedAt };
    } catch (e) {
      throw new ServiceUnavailableException({
        status: 'degraded',
        firestore: 'error',
        message: (e as Error)?.message,
      });
    }
  }
}
