/**
 * emergencies.controller.ts
 * GET /emergencies/active y GET /emergencies/:userId/helpers — leen el estado de emergencias
 * en memoria (StateStore). Mismo contrato que el monolito.
 */
import { Controller, Get, Param } from '@nestjs/common';
import { StateStore } from './state.store';

@Controller('emergencies')
export class EmergenciesController {
  constructor(private readonly state: StateStore) {}

  @Get('active')
  active() {
    const emergencies = Array.from(this.state.emergencyAlerts.entries()).map(([userId, alert]) => ({
      ...alert,
      helpersCount: this.state.emergencyHelpers.get(userId)?.size || 0,
    }));
    return { success: true, emergencies, total: emergencies.length };
  }

  @Get(':userId/helpers')
  helpers(@Param('userId') userId: string) {
    const helpersSet = this.state.emergencyHelpers.get(userId) || new Set<string>();
    const helpers = Array.from(helpersSet);
    return { success: true, helpers, count: helpers.length };
  }
}
