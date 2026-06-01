/**
 * firebase.service.ts
 * Inicializa firebase-admin una sola vez (Firestore/Auth/Storage/FCM) leyendo las MISMAS
 * env vars que el monolito, para que el mismo harness de tests pueda correr esta app.
 * Conecta a los emuladores cuando FIRESTORE_EMULATOR_HOST/FIREBASE_AUTH_EMULATOR_HOST están seteadas.
 *
 * Nota/deuda: el monolito guarda el JSON de la service account DENTRO de
 * GOOGLE_APPLICATION_CREDENTIALS (que estándarmente es un PATH). Se replica esa convención
 * para reusar el harness; conviene migrar a un nombre propio (ej. FIREBASE_SERVICE_ACCOUNT) más adelante.
 */
import { Injectable, OnModuleInit } from '@nestjs/common';
import * as admin from 'firebase-admin';

@Injectable()
export class FirebaseService implements OnModuleInit {
  onModuleInit(): void {
    if (admin.apps.length) return;

    const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!raw) throw new Error('Falta GOOGLE_APPLICATION_CREDENTIALS (JSON de la service account)');

    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
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
