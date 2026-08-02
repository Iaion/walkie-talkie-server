# Despliegue de AlRescate

Guía para poner en producción las tres piezas: **backend** (NestJS, este repo), **panel admin**
(`alrescate-admin`) y **app Android** (`alrescate-app`). Pensado para hacerse una vez, con cuidado.

> Convención: en **dev** todo corre contra los emuladores de Firebase; en **prod** contra el
> proyecto real de Firebase (lo administra el compañero). Backend y app deben usar el **mismo**
> proyecto Firebase para que los tokens validen.

---

## 0. Prerrequisitos (una sola vez)

- Proyecto Firebase de **producción** en plan **Blaze** (pago por uso). Necesario para **Storage**
  (las fotos de verificación) y para escalar Firestore/FCM más allá del free tier.
- Una **service account** del proyecto prod (JSON). **NUNCA** se commitea ni se pega en chats.
- Decidir el **host del backend** (Render / Railway / Google Cloud Run / Fly.io — todos sirven con
  el `Dockerfile`).
- Cuenta de **Vercel** (panel) y de **Google Play Console** (US$25 únicos, para publicar la app).

---

## 1. Backend (este repo)

Imagen lista con el `Dockerfile` (multi-stage, sin secretos horneados).

**Variables de entorno en el host:**

| Var | Valor |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | el JSON de la service account de prod (inline) **o** un path a un archivo montado |
| `FIREBASE_STORAGE_BUCKET` | `<project-id>.firebasestorage.app` |
| `PORT` | el que asigne el host (el server lee `process.env.PORT`) |
| `ALLOWED_ORIGINS` | **OBLIGATORIA en prod.** CSV de orígenes web permitidos para CORS (REST + Socket.IO), ej. `https://alrescate.example`. Sin setear = abierto (solo aceptable en dev). El panel servido en `/panel` es same-origin y la app Android no manda Origin: ninguno de los dos la necesita listada. |
| `FIREBASE_PROJECT_ID` | *(opcional)* solo si hace falta forzar el projectId |
| `REST_RATE_LIMIT` / `REST_RATE_WINDOW_MS` | *(opcional)* rate limit REST por IP (default 600 req/60s) |
| `SOCKET_RATE_WINDOW_MS` y `SOCKET_RATE_LIMIT_<EVENTO>` | *(opcional)* límites por-socket de eventos calientes (`EMERGENCY_ALERT`, `SEND_MESSAGE`, `AUDIO_MESSAGE`, `UPDATE_LOCATION`, `UPDATE_EMERGENCY_LOCATION`, `UPDATE_HELPER_LOCATION`); defaults en `src/common/socket-throttle.ts` |

**NO** setear `FIRESTORE_EMULATOR_HOST` / `FIREBASE_AUTH_EMULATOR_HOST` / `FIREBASE_STORAGE_EMULATOR_HOST`
en prod (esas son solo para dev contra emuladores).

Deploy típico (Render/Railway): conectar el repo, que detecte el `Dockerfile`, cargar las env vars,
desplegar. Healthcheck: `GET /health` → 200 (la imagen además trae `HEALTHCHECK` propio). CORS: con
`ALLOWED_ORIGINS` seteada queda restringido a esos orígenes.

**El backend también sirve el panel** (ver §2): el `Dockerfile` compila el panel y el server lo
entrega en `/panel`. El build del panel necesita la config WEB de Firebase como **build args**:

```
docker build \
  --build-arg VITE_FIREBASE_API_KEY=... \
  --build-arg VITE_FIREBASE_AUTH_DOMAIN=<project>.firebaseapp.com \
  --build-arg VITE_FIREBASE_PROJECT_ID=<project-id> \
  --build-arg VITE_FIREBASE_APP_ID=1:...:web:... \
  -t alrescate-backend .
```
(En Render/Railway esos build args se cargan en la config del servicio.)

---

## 2. Panel admin (`admin-panel/`) — servido por el backend

El panel vive **adentro de este repo** (`admin-panel/`) y lo **sirve el propio backend** en la ruta
`/panel` → un solo deploy, una sola URL, sin Vercel ni CORS. Cómo funciona:

- `admin-panel/vite.config.ts` usa `base: '/panel/'` al compilar.
- `admin-panel/.env.production` fija `VITE_API_URL=` (mismo origen) y `VITE_USE_EMULATOR=false`.
- `src/main.ts` sirve `admin-panel/dist` en `/panel` si existe.
- El `Dockerfile` compila el panel (con los build args de arriba) y lo copia a la imagen.

Una vez desplegado el backend, el panel queda en **`https://<tu-backend>/panel`**. El admin entra ahí,
se loguea con Firebase y opera. (No hace falta cuenta de Vercel.)

> *Alternativa:* si en el futuro quisieran el panel separado (en Vercel, con su CDN), se puede —
> habría que subir `admin-panel/` a su propio repo y setear `VITE_API_URL` a la URL del backend.

**Dev local:** el panel sigue corriendo aparte con `npm run dev` (hot-reload), apuntando al backend
local. Solo en producción lo sirve el backend.

---

## 3. App Android (`alrescate-app`)

1. Registrar la app en el Firebase de **prod** y bajar el `google-services.json` de prod (reemplaza
   el de dev en `app/`). El `applicationId` debe coincidir con el `package_name` del JSON.
2. Apuntar el backend de release: en `app/build.gradle.kts`, el `buildConfigField SERVER_URL` del
   build `release` → la URL pública del backend.
3. Build de release firmado (keystore propio) → subir a Google Play (internal testing primero).

> Deuda anotada: el package sigue siendo `com.example.a2intento` (Fase 5 lo renombra a
> `com.alrescate.app`; eso requiere re-registrar la app en Firebase con el nuevo package).

---

## 4. Pasos de puesta en marcha (en orden)

1. **Desplegar Security Rules** de Firestore/Storage a prod: `firebase deploy --only firestore:rules,storage:rules`
   (el deny-all es correcto: el cliente no escribe Firestore directo).
2. **Bootstrap del primer admin**: `node scripts/set-admin.js <uid>` apuntado a prod (crea el claim
   `role=admin`). Sin esto nadie entra al panel.
3. **Grandfathering** de usuarios existentes (si se migra desde el prototipo): logueado como admin,
   `GET /admin/grandfather/preview` para ver cuántos, luego `POST /admin/grandfather` para marcarlos
   como aprobados (no quedan bloqueados por el gating).

---

## 5. Checklist de seguridad

- [ ] Service account de prod fuera del repo (solo como env var del host).
- [ ] `ALLOWED_ORIGINS` seteada con los orígenes web reales (sin ella CORS queda abierto).
- [ ] Google Maps API key de la app restringida por package+SHA1 en Google Cloud Console (la key vieja quedó en el historial de git → rotar).
- [ ] Rotar credenciales que hayan estado expuestas (Maps API key del manifest, claves Firebase).
- [ ] Restringir la Maps API key por package + SHA-1 en la consola de Google Cloud.
- [ ] Fotos de verificación = datos sensibles (Ley 25.326): privadas en Storage, acceso solo por
      URL firmada del backend (ya implementado).
- [ ] Confirmar que en prod NO están seteadas las env de emulador.
