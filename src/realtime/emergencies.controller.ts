/**
 * emergencies.controller.ts
 * Lectura del estado de emergencias (StateStore, en memoria).
 *  - GET /emergencies/feed: lo mismo que el evento `sync_emergencies`, por HTTP. Lo usa la app
 *    cuando no tiene socket (por ejemplo al despertar por un push) para saber qué sigue activo.
 *  - GET /emergencies/active y GET /emergencies/:userId/helpers: contrato heredado del monolito.
 * Las emergencias ajenas (con ubicación) solo las ven usuarios aprobados y administradores;
 * el resto ve únicamente la propia.
 */
import { Controller, Get, Param, Req } from '@nestjs/common';
import { StateStore } from './state.store';
import { EmergencyRecoveryService } from './emergency-recovery.service';

@Controller('emergencies')
export class EmergenciesController {
  constructor(private readonly state: StateStore, private readonly recovery: EmergencyRecoveryService) {}

  private async canSeeAll(req: any): Promise<boolean> {
    const role = req?.user?.role;
    if (role === 'admin' || role === 'superadmin') return true;
    return this.recovery.isApproved(req.user.uid);
  }

  @Get('feed')
  feed(@Req() req: any) {
    return this.recovery.snapshot(req.user.uid);
  }

  @Get('active')
  async active(@Req() req: any) {
    const all = await this.canSeeAll(req);
    const emergencies = Array.from(this.state.emergencyAlerts.entries())
      .filter(([userId]) => all || userId === req.user.uid)
      .map(([userId, alert]) => this.recovery.view(userId, alert));
    return { success: true, emergencies, total: emergencies.length };
  }

  @Get(':userId/helpers')
  async helpers(@Req() req: any, @Param('userId') userId: string) {
    if (userId !== req.user.uid && !(await this.canSeeAll(req))) {
      return { success: true, helpers: [], count: 0 };
    }
    const helpers = Array.from(this.state.emergencyHelpers.get(userId) || new Set<string>());
    return { success: true, helpers, count: helpers.length };
  }
}
