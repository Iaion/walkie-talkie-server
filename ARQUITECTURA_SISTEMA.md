# Arquitectura de sistema — AlRescate

Visión de alto nivel de **todo** AlRescate: las tres piezas, cómo se comunican, qué hace cada
módulo, y los conceptos transversales. Para el detalle interno del backend ver `ARQUITECTURA.md`;
para desplegar ver `DEPLOYMENT.md`.

---

## 1. Qué es AlRescate

Botón de pánico para repartidores (deliveries) que sufren robos: uno dispara una emergencia y los
demás cercanos reciben la alerta en tiempo real para acudir. Administrado por una asociación civil
que **verifica y aprueba** a cada repartidor antes de dejarlo usar la app.

## 2. Las tres piezas

```
┌──────────────────┐      REST + Socket.IO       ┌──────────────────────┐
│  App Android     │  (Firebase ID token Bearer) │   Backend NestJS     │
│  (alrescate-app) │ ───────────────────────────▶│ (walkie-talkie-      │
│  Kotlin/Compose  │ ◀─────────────────────────── │  server)             │
└──────────────────┘      eventos en tiempo real  └─────────┬────────────┘
                                                            │ Admin SDK
┌──────────────────┐      REST (token admin)                │ (ignora rules)
│  Panel admin     │ ───────────────────────────▶          ▼
│  (admin-panel)   │                              ┌──────────────────────┐
│  React/Vite      │ ◀───────────────────────────│   Firebase           │
└──────────────────┘                              │ Auth·Firestore·      │
                                                  │ Storage·FCM          │
                                                  └──────────────────────┘
```

Son 3 piezas lógicas pero **2 repos**: el panel vive dentro del backend.

| Pieza | Repo | Rol |
|---|---|---|
| **App Android** | `alrescate-app` | La usa el repartidor: registro, verificación, chat, **botón de pánico**, mapa. |
| **Backend** | `walkie-talkie-server` | Única fuente de verdad. Toda la lógica, seguridad y acceso a Firebase. |
| **Panel admin** | `walkie-talkie-server/admin-panel` | Dentro del backend; el propio backend lo **sirve en `/panel`** (un solo deploy). Lo usa la asociación: aprobar/rechazar verificaciones. |
| **Firebase** | — | Infra: identidad (Auth), datos (Firestore), fotos (Storage), notificaciones (FCM). |

**Principio rector:** el cliente NUNCA toca Firestore/Storage directo en el diseño final. Todo pasa
por el backend, que es el único con Admin SDK. Las Security Rules son **deny-all** (el cliente no
lee/escribe la base directo).

## 3. Flujos principales

### Registro → Verificación → Aprobación
1. App: registro (Firebase Auth) → verificar email → login.
2. App: **gate de verificación** → el repartidor sube selfie + documento + captura de la app de
   delivery (+ datos del titular si *alquila* la cuenta) → `POST /verification`.
3. Backend: corre **cruces antifraude** (duplicados de email/tel/documento, límite por titular) →
   estado `pending_review`.
4. Panel: el admin ve la cola, las fotos (URLs firmadas) y los flags → **aprueba o rechaza** →
   `audit_log` (server-side).
5. App: re-chequea → `approved` → pasa el gate → entra a las salas.

### Botón de pánico (núcleo de vida)
1. App (en sala): toca pánico → `emergency_alert` por socket.
2. Backend: toma un **lock global** (una emergencia a la vez en esta versión), crea sala de
   emergencia, hace broadcast a los demás conectados + push FCM a los offline.
3. Otros: reciben la alerta, confirman ayuda (`help_confirm`), comparten ubicación en tiempo real.

## 4. Mapa del backend (qué hace cada módulo, `src/`)

| Módulo | Responsabilidad |
|---|---|
| `main.ts` / `app.module.ts` | Bootstrap; CORS; body limit 25mb; arma los módulos. |
| `firebase/` | Inicializa el Admin SDK (Auth/Firestore/Storage/FCM); credenciales por env. |
| `common/` | `auth.guard` (verifica el ID token), `roles.guard`+`roles.decorator` (rol admin), `public.decorator`, `ownership` (autorización por-usuario), `image-utils`. |
| `verification/` | Registro+verificación: máquina de estados, `normalize` (antifraude), cruces, submit, cambio de titular, foto privada. |
| `admin/` | Review del admin: cola, aprobar/rechazar, fotos firmadas, grandfathering. Audit logs. |
| `realtime/` | Gateway Socket.IO (20+ eventos): chat, ubicación, **núcleo de pánico**; `StateStore` (estado en memoria), `EmergencyService` (lock). |
| `vehicles/` | CRUD de vehículos del repartidor. |
| `fcm/` | Gestión de tokens de notificaciones push. |
| `notifications/` | Envío de push FCM. |
| `health/` | `GET /health` (para el healthcheck del host). |

**Convención de módulo:** `controller` (HTTP) → `service` (lógica) → `repository` (Firestore). El
service no toca la base directo.

## 5. Estructura de la app Android (`alrescate-app/app/src/main/java/.../`)

| Carpeta | Qué hay |
|---|---|
| `ui/screen/` | Pantallas Compose (Login, Registro, **Verificación**, Salas, Emergencia, Perfil, Vehículos). |
| `ui/viewmodel/` | ViewModels (Auth, **Verification**, Chat, Emergency, Perfil, Vehicle). |
| `ui/navigation/` | `NavGraph` — rutas + **gating** (login/auto-login → verificación → salas). |
| `data/network/` | `ApiService` (Retrofit), `RetrofitInstance`, `AuthInterceptor` (adjunta el ID token). |
| `data/repository/` | `SocketManager`/`SocketRepository` (Socket.IO con token en el handshake), managers de usuario/salas/mensajes. |
| `services/` | Foreground services (socket, ubicación de emergencia), Firebase Messaging. |
| `di/appModule.kt` | Inyección de dependencias (Koin). |
| `MyApplication.kt` | Init de Firebase (apunta a emuladores en debug), Koin, Maps. |

> El package sigue siendo `com.example.a2intento` (deuda del prototipo; Fase 5 lo renombra a
> `com.alrescate.app`).

## 6. Estructura del panel (`admin-panel/src/`)

`firebase.ts` (Auth, emulador en dev) · `api.ts` (cliente REST con ID token) · `auth/` (contexto +
login, gating por claim admin) · `verifications/` (cola con tabs por estado + detalle con fotos y
aprobar/rechazar). Vite + React + TypeScript.

## 7. Conceptos transversales

- **Identidad:** Firebase Auth. El cliente manda el **ID token** (Bearer en REST, `auth.token` en el
  handshake del socket). El backend lo verifica con el Admin SDK.
- **Autorización por-usuario:** el backend deriva el uid del token, no confía en el `userId` del
  cliente (`assertSelf` en REST, `notSelf` en los eventos de socket).
- **Roles:** custom claim `role=admin` (vía `scripts/set-admin.js`) → `RolesGuard` protege `/admin/*`.
- **Estados del usuario:** `pending_verification → pending_review → approved | rejected | suspended`.
- **Modelo titular/alquilador:** una cuenta de delivery puede ser propia (*owner*) o alquilada
  (*renter*, declara al titular). Cambio de titular soportado.
- **Datos sensibles (Ley 25.326):** las fotos de verificación se guardan **privadas** en Storage; el
  admin las ve con **URLs firmadas** temporales.

## 8. Desarrollo local (todo con emuladores Firebase)

1. Emuladores: `firebase emulators:start` (Firestore 8081, Auth 9099, Storage 9199).
2. Backend: `npm run build` y `node dist/main.js` con las env de emulador (ver `test/setup/server.js`).
3. Panel: `npm run dev` (`.env` con `VITE_USE_EMULATOR=true`).
4. App: build debug (apunta a `10.0.2.2:8080` y a los emuladores Firebase).
5. Tests: backend `npm run test:ci` (120 contra NestJS) · panel `npm test` · app `gradlew testDebugUnitTest`.

> Nota: app/backend/panel deben usar el **mismo projectId** de Firebase para que los tokens validen
> (en el e2e se corrió todo como `alrescate-cbb6a`, el de la app).
