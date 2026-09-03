/**
 * audit.module.ts
 * Módulo GLOBAL: cualquier módulo puede inyectar AuditService sin importar nada.
 */
import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
