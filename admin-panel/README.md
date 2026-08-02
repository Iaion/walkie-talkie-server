# AlRescate · Panel Admin

Panel web para que la asociación revise las verificaciones de los deliveries (aprobar/rechazar,
ver fotos, flags antifraude). **No accede a Firestore directo**: todo pasa por la API NestJS
(`walkie-talkie-server`), que aplica el rol `admin` y registra `audit_logs`.

Stack: Vite + React + TypeScript + Firebase Auth (solo login).

## Puesta en marcha (desarrollo)

1. **Configurar Firebase Web.** En la consola de Firebase del proyecto de dev:
   _Configuración del proyecto → Tus apps → Web (`</>`)_ → copiar el `firebaseConfig`.
2. `cp .env.example .env` y completar `VITE_FIREBASE_*`. Para dev contra los emuladores dejá
   `VITE_USE_EMULATOR=true` (el login pega al emulador de Auth, no a Firebase real).
3. Levantar el backend + emuladores (en `walkie-talkie-server`) y después:
   ```
   npm install
   npm run dev      # http://localhost:5173
   ```

## Crear un admin (dev)

El panel solo deja entrar a usuarios con el custom claim `role=admin`. Para crear uno en el
emulador: registrar un usuario (email/password) en el emulador de Auth y correr el bootstrap del
server (`scripts/set-admin.js` con su uid). En producción, lo mismo contra el proyecto real.

## Scripts

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo (Vite) |
| `npm run build` | Type-check + build de producción (`dist/`) |
| `npm run typecheck` | Solo type-check |
| `npm test` | Tests (Vitest) |

## Deploy

Pensado para Vercel (build estático en `dist/`). Falta: crear el repo propio y conectar Vercel,
configurar las env vars `VITE_*` de **producción** (Firebase real + `VITE_API_URL` del backend
desplegado, `VITE_USE_EMULATOR=false`).
