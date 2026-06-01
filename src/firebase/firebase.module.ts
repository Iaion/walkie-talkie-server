/**
 * firebase.module.ts
 * Módulo global: expone FirebaseService a toda la app sin re-importarlo en cada módulo.
 */
import { Global, Module } from '@nestjs/common';
import { FirebaseService } from './firebase.service';

@Global()
@Module({
  providers: [FirebaseService],
  exports: [FirebaseService],
})
export class FirebaseModule {}
