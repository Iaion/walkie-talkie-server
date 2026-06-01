/**
 * health.controller.ts
 * Endpoint público de salud. Replica el contrato del monolito: GET /health → "Servidor operativo 🚀".
 */
import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/public.decorator';

@Controller()
export class HealthController {
  @Public()
  @Get('health')
  health(): string {
    return 'Servidor operativo 🚀';
  }
}
