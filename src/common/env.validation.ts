/**
 * env.validation.ts
 * Validación de variables de entorno al boot (PLAN_MEJORAS B4): fail-fast con mensaje claro
 * en vez de bootear "sano" y reventar después (ej. sin FIREBASE_STORAGE_BUCKET el server
 * levantaba bien y fallaba recién al subir la primera foto).
 * Reglas por entorno:
 * - Siempre: FIREBASE_STORAGE_BUCKET.
 * - Sin emuladores (dev contra nube / prod): credenciales obligatorias.
 * - Producción (NODE_ENV=production): además ALLOWED_ORIGINS, y prohibidas las env de emulador.
 */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): void {
  const errors: string[] = [];
  const usingEmulators = !!env.FIRESTORE_EMULATOR_HOST;
  const isProd = env.NODE_ENV === 'production';

  if (!env.FIREBASE_STORAGE_BUCKET) {
    errors.push('FIREBASE_STORAGE_BUCKET: obligatoria (ej. <project-id>.firebasestorage.app) — sin ella las fotos/audio fallan en runtime.');
  }
  if (!usingEmulators && !env.FIREBASE_SERVICE_ACCOUNT && !env.GOOGLE_APPLICATION_CREDENTIALS) {
    errors.push('FIREBASE_SERVICE_ACCOUNT (o GOOGLE_APPLICATION_CREDENTIALS): obligatoria sin emuladores (JSON inline o path al .json).');
  }
  if (isProd) {
    if (!env.ALLOWED_ORIGINS) {
      errors.push('ALLOWED_ORIGINS: obligatoria en producción (CSV de orígenes web permitidos) — sin ella CORS queda abierto a cualquier sitio.');
    }
    if (usingEmulators || env.FIREBASE_AUTH_EMULATOR_HOST || env.FIREBASE_STORAGE_EMULATOR_HOST) {
      errors.push('FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST / FIREBASE_STORAGE_EMULATOR_HOST: NO deben estar seteadas en producción.');
    }
  }

  if (errors.length) {
    throw new Error(`Configuración de entorno inválida:\n- ${errors.join('\n- ')}\nVer .env.example / DEPLOYMENT.md.`);
  }
}
