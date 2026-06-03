/**
 * Inicializa Firebase (solo Auth en el panel: el resto pasa por la API NestJS).
 * En desarrollo se conecta al emulador de Auth si VITE_USE_EMULATOR === 'true'.
 */
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

if (import.meta.env.VITE_USE_EMULATOR === 'true') {
  connectAuthEmulator(auth, import.meta.env.VITE_AUTH_EMULATOR_URL || 'http://127.0.0.1:9099', {
    disableWarnings: true,
  });
}
