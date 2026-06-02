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
| `FIREBASE_PROJECT_ID` | *(opcional)* solo si hace falta forzar el projectId |

**NO** setear `FIRESTORE_EMULATOR_HOST` / `FIREBASE_AUTH_EMULATOR_HOST` / `FIREBASE_STORAGE_EMULATOR_HOST`
en prod (esas son solo para dev contra emuladores).

Deploy típico (Render/Railway): conectar el repo, que detecte el `Dockerfile`, cargar las env vars,
desplegar. Healthcheck: `GET /health` → 200. CORS ya está habilitado (`app.enableCors()`).

---

## 2. Panel admin (`alrescate-admin`)

App estática (Vite) → **Vercel**.

1. Subir `alrescate-admin` a su propio repo de GitHub.
2. En Vercel: importar el repo (framework Vite, build `npm run build`, output `dist/`).
3. Env vars de **producción** (Project → Settings → Environment Variables):
   - `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`,
     `VITE_FIREBASE_APP_ID` → del **app web** registrada en el Firebase de prod.
   - `VITE_API_URL` → la URL pública del **backend** desplegado.
   - `VITE_USE_EMULATOR=false`.

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
- [ ] Rotar credenciales que hayan estado expuestas (Maps API key del manifest, claves Firebase).
- [ ] Restringir la Maps API key por package + SHA-1 en la consola de Google Cloud.
- [ ] Fotos de verificación = datos sensibles (Ley 25.326): privadas en Storage, acceso solo por
      URL firmada del backend (ya implementado).
- [ ] Confirmar que en prod NO están seteadas las env de emulador.
