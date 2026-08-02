/**
 * test/unit/env-validation.test.js
 * Unit test puro de la validación de entorno al boot (PLAN_MEJORAS B4).
 */
const { validateEnv } = require('../../dist/common/env.validation');

const DEV_EMU = {
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8081',
  FIREBASE_STORAGE_BUCKET: 'alrescate-dev.firebasestorage.app',
};

describe('validateEnv', () => {
  test('dev con emuladores (sin credenciales) → válido', () => {
    expect(() => validateEnv({ ...DEV_EMU })).not.toThrow();
  });

  test('falta FIREBASE_STORAGE_BUCKET → error que la nombra', () => {
    expect(() => validateEnv({ FIRESTORE_EMULATOR_HOST: 'x' })).toThrow(/FIREBASE_STORAGE_BUCKET/);
  });

  test('sin emuladores y sin credenciales → error que pide la service account', () => {
    expect(() => validateEnv({ FIREBASE_STORAGE_BUCKET: 'b' })).toThrow(/FIREBASE_SERVICE_ACCOUNT/);
  });

  test('producción sin ALLOWED_ORIGINS → error', () => {
    expect(() =>
      validateEnv({ NODE_ENV: 'production', FIREBASE_STORAGE_BUCKET: 'b', FIREBASE_SERVICE_ACCOUNT: '{}' }),
    ).toThrow(/ALLOWED_ORIGINS/);
  });

  test('producción con env de emulador seteada → error', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'production', FIREBASE_STORAGE_BUCKET: 'b', FIREBASE_SERVICE_ACCOUNT: '{}',
        ALLOWED_ORIGINS: 'https://a.example', FIRESTORE_EMULATOR_HOST: 'x',
      }),
    ).toThrow(/NO deben/);
  });

  test('producción bien configurada → válido', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'production', FIREBASE_STORAGE_BUCKET: 'b', FIREBASE_SERVICE_ACCOUNT: '{}',
        ALLOWED_ORIGINS: 'https://a.example',
      }),
    ).not.toThrow();
  });
});
