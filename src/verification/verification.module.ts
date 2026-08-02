/**
 * verification.module.ts
 * Registro + verificación (Fase 3). El review del admin vive en el módulo admin.
 */
import { Module } from '@nestjs/common';
import { VerificationController } from './verification.controller';
import { VerificationService } from './verification.service';
import { VerificationRepository } from './verification.repository';

@Module({
  controllers: [VerificationController],
  providers: [VerificationService, VerificationRepository],
  exports: [VerificationService, VerificationRepository],
})
export class VerificationModule {}
