/**
 * firebase.service.ts
 * Inicializa firebase-admin una sola vez (Firestore/Auth/Storage/FCM) leyendo las MISMAS
 * env vars que el monolito, para que el mismo harness de tests pueda correr esta app.
 * Conecta a los emuladores cuando FIRESTORE_EMULATOR_HOST/FIREBASE_AUTH_EMULATOR_HOST están seteadas.
 *
 * Credenciales: usa FIREBASE_SERVICE_ACCOUNT (preferido) y cae a GOOGLE_APPLICATION_CREDENTIALS
 * por compatibilidad con el harness/monolito. El valor puede ser el JSON inline o un PATH a un
 * archivo .json — se detecta automáticamente (el path estándar es un archivo, no el JSON crudo).
 */
import { Injectable, OnModuleInit } from '@nestjs/common';
import * as admin from 'firebase-admin';
import * as fs from 'fs';

@Injectable()
export class FirebaseService implements OnModuleInit {
  onModuleInit(): void {
    if (admin.apps.length) return;

    const raw = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS;

    // Modo emulador SIN service account (CI / máquinas sin la key): los emuladores no validan
    // credenciales, alcanza con el projectId. En cualquier entorno SIN emuladores la key sigue
    // siendo obligatoria.
    const usingEmulators = !!process.env.FIRESTORE_EMULATOR_HOST;
    if (!raw && usingEmulators) {
      admin.initializeApp({
        projectId: process.env.FIREBASE_PROJECT_ID || 'alrescate-dev',
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      });
      admin.firestore().settings({ ignoreUndefinedProperties: true });
      return;
    }
    if (!raw) throw new Error('Falta FIREBASE_SERVICE_ACCOUNT (o GOOGLE_APPLICATION_CREDENTIALS): JSON o path de la service account');

    // JSON inline (empieza con '{') o path a un archivo .json
    const trimmed = raw.trim();
    const serviceAccount = trimmed.startsWith('{') ? JSON.parse(trimmed) : JSON.parse(fs.readFileSync(trimmed, 'utf8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      // Permite forzar el projectId (útil con emuladores: el cliente puede usar otro proyecto que la
      // service account). Cae al project_id de la service account si no se setea.
      projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });
    admin.firestore().settings({ ignoreUndefinedProperties: true });
  }

  get firestore(): admin.firestore.Firestore {
    return admin.firestore();
  }

  get auth(): admin.auth.Auth {
    return admin.auth();
  }

  get storage(): admin.storage.Storage {
    return admin.storage();
  }

  get messaging(): admin.messaging.Messaging {
    return admin.messaging();
  }
}
