/**
 * firebase.module.ts
 * Módulo global: expone FirebaseService (y el StorageService que lo envuelve para uploads,
 * D5) a toda la app sin re-importarlos en cada módulo.
 */
import { Global, Module } from '@nestjs/common';
import { FirebaseService } from './firebase.service';
import { StorageService } from '../common/storage.service';

@Global()
@Module({
  providers: [FirebaseService, StorageService],
  exports: [FirebaseService, StorageService],
})
export class FirebaseModule {}
