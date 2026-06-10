# AlRescate — Backend + Panel admin

Backend del botón de pánico para repartidores (NestJS + Firebase + Socket.IO). Este repo
también contiene el **panel admin** (`admin-panel/`, React+Vite), que el propio backend
sirve en `/panel` en producción (un solo deploy).

> Visión general del sistema (las 3 piezas, flujos, decisiones): `ARQUITECTURA_SISTEMA.md`.
> Convenciones del código backend: `ARQUITECTURA.md`. Deploy: `DEPLOYMENT.md`.
> La app Android vive en el repo `alrescate-app`.

## Quick start (dev local, contra emuladores)

Requisitos: Node 22+, Java 17 (para los emuladores), `npm i -g firebase-tools@13`.

```bash
npm ci
npm run test:ci        # compila + levanta emuladores + corre TODA la suite (138 tests)
```

Para desarrollar con el server corriendo:

```bash
# Terminal 1 — emuladores (Auth 9099, Firestore 8081, Storage 9199, UI en :4000)
firebase emulators:start --project alrescate-dev

# Terminal 2 — server apuntado a los emuladores
# (con secrets/serviceAccountKey.dev.json presente la toma; sin ella usa modo emulador)
$env:FIRESTORE_EMULATOR_HOST="127.0.0.1:8081"
$env:FIREBASE_AUTH_EMULATOR_HOST="127.0.0.1:9099"
$env:FIREBASE_STORAGE_EMULATOR_HOST="127.0.0.1:9199"
$env:FIREBASE_STORAGE_BUCKET="alrescate-dev.firebasestorage.app"
npm run build; npm start
```

- Variables de entorno: **`.env.example`** (el server valida al boot y avisa qué falta).
- Panel en dev: `cd admin-panel && npm run dev` (corre aparte; en prod lo sirve el backend).
- Seeds para probar flujos completos: `scripts/e2e-seed*.js`. Primer admin: `scripts/set-admin.js`.

## Scripts

| Comando | Qué hace |
|---|---|
| `npm run test:ci` | Build + suite completa contra emuladores (lo que corre el CI) |
| `npm test` | Solo jest (asume emuladores ya levantados) |
| `npm run lint` | ESLint (backend); `cd admin-panel && npm run lint` para el panel |
| `npm run dev` | NestJS en watch mode |

## Estructura

```
src/
  firebase/      init de firebase-admin (emuladores o nube según env)
  common/        auth.guard (token en todo), ownership, cors, socket-throttle, env.validation
  realtime/      StateStore (estado en memoria) + gateway Socket.IO (~20 eventos) + emergencias
  verification/  modelo de estados del repartidor + antifraude + fotos
  admin/         cola de revisión (aprobar/rechazar), roles, audit log
  vehicles/ fcm/ notifications/ health/
admin-panel/     panel React (login admin + cola de verificaciones)
test/            caracterización (caja negra vs :8080) + unit; harness en test/setup/
```

Seguridad (resumen): todo requiere Firebase ID token (REST y handshake del socket); autorización
por-usuario (el uid sale del token, no del payload); Firestore con rules deny-all (el cliente no
toca la base, todo pasa por acá); CORS con whitelist por `ALLOWED_ORIGINS`; rate limiting REST y
por-socket. Detalle: `ARQUITECTURA_SISTEMA.md` §seguridad.
