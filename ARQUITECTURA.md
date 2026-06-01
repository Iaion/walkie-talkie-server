# ARQUITECTURA.md — Backend AlRescate (walkie-talkie-server)

> **Qué es este documento:** la **referencia canónica de convenciones** del backend. Su razón de ser (regla operativa #2 del plan): como el código lo escribe un modelo sin memoria entre sesiones y el dev es la continuidad, las convenciones viven **acá escritas**, no en la memoria de nadie. **Cada sesión se arranca leyendo este archivo.** Si el código se desvía de lo que dice acá, o se corrige el código, o se actualiza este doc — pero nunca divergen en silencio.
>
> El **plan completo** vive en `../PLAN_MAESTRO.md`. Este doc es el "cómo" del backend; aquel es el "qué" y el "porqué".
>
> **Estado:** v0 (Fase 0). Documento vivo: se actualiza a medida que el código existe.

---

## 1. Stack

- **Lenguaje:** TypeScript (estricto).
- **Framework:** NestJS (sobre Express).
- **Tiempo real:** Socket.IO vía Gateway de NestJS.
- **Datos / Auth / Storage / Push:** Firebase (Firestore, Auth, Storage, FCM) vía `firebase-admin`.
- **Email:** Resend (transaccional).
- **Estado de partida:** se migra desde un monolito `server.js` de 3.825 líneas en JS plano, por **estrangulamiento** (módulo por módulo, con tests de caracterización como red).

---

## 2. Reglas operativas (innegociables)

1. **NestJS "aburrido".** Solo el núcleo estándar: `module` / `controller` / `service` / `gateway` / `dto`, DI por constructor. **Sin magia exótica** (custom decorators, interceptors, dynamic modules, providers raros) salvo razón fuerte **explicada en el momento**. Menos indirección = más legible a las 2am.
2. **Cabecera por archivo.** Todo archivo arranca con un comentario que dice **qué responsabilidad tiene**. Ejemplo:
   ```ts
   /**
    * verification.service.ts
    * Lógica del flujo de verificación: recibe la submission, corre los cruces
    * automáticos (duplicados, límite por titular) y maneja la máquina de estados.
    * NO decide acceso (eso es auth.guard) ni notifica (eso es notifications).
    */
   ```
3. **"Frená y desarmamos".** Si algo resulta opaco para el dev, se para y se abre hasta que lo siga. Aceptar código que no se termina de entender = señal de alarma.
4. **Verificación por cambio grande:** `tsc` compila + tests pasan + verificación funcional. No se avanza hasta pasar.

---

## 3. Estructura de carpetas (target)

```
src/
  main.ts                  # bootstrap
  app.module.ts            # módulo raíz, ensambla los demás
  common/                  # config, logging, errores, utils, guards base
    config/
    guards/                # auth.guard, roles.guard
    filters/               # exception filters
    logging/
  auth/                    # verificación de token Firebase, roles/claims
  users/                   # perfil, estados del usuario, ciclo de vida
  verification/            # submission, cruces, máquina de estados
  admin/                   # revisión, aprobación, auditoría (audit_logs)
  alerts/                  # botón de pánico, ciclo de la alerta, locks
  location/                # ubicación en tiempo real (en memoria, NO Firestore)
  realtime/                # Gateway Socket.IO central
  notifications/           # FCM + email (Resend)
  vehicles/                # CRUD de vehículos
  chat/                    # rooms, mensajes, audio (PTT por clips)
```

**Un módulo = un bounded context.** Cada carpeta de feature tiene su `*.module.ts`, `*.controller.ts` (REST) y/o `*.gateway.ts` (Socket.IO), `*.service.ts` (lógica), `dto/` (validación de entrada), y `*.repository.ts` si encapsula acceso a Firestore.

---

## 4. Convenciones de un módulo

- **Controller / Gateway:** solo reciben, validan (DTO) y delegan al service. Nada de lógica de negocio acá.
- **Service:** la lógica. No conoce HTTP ni sockets.
- **Repository:** encapsula el acceso a Firestore. El service no escribe `db.collection(...)` directo — pasa por el repository. (Esto deja la puerta abierta a migrar a Postgres tocando solo repositories.)
- **DTO + validación:** toda entrada externa se valida (class-validator o zod). No se confía en el cliente.

---

## 5. Seguridad (principio rector del proyecto)

- **El server verifica el ID token de Firebase en CADA request REST y en la conexión Socket.IO.** Hoy el monolito no valida nada → esto es lo primero que se cierra (Fase 1).
- **Roles por custom claims** de Firebase Auth: `admin` / `delivery`. Guard de roles para endpoints de admin.
- **El server es la fuente de verdad del ACCESO.** El cliente decide UX; el server autoriza. Un usuario no-`approved` es rechazado server-side en endpoints/eventos sensibles **aunque la app le muestre el home**.
- **`audit_logs` los escribe el server**, nunca el cliente del panel.
- **Security Rules de Firestore/Storage versionadas en git** (`firestore.rules`, `storage.rules`) y endurecidas — porque el cliente Android escribe directo a Firestore/Storage, cerrar solo el server no alcanza.
- **Secretos nunca al repo:** van por variables de entorno. El service account key de Firebase se inyecta por env, no se commitea.

---

## 6. Datos (Firestore)

- Acceso siempre vía repository (ver §4).
- **La ubicación en tiempo real NO se persiste a Firestore** (quemaría la cuota gratis) → vive en memoria en el módulo `location`, persistiendo solo lo necesario.
- Colecciones y modelo: ver `../PLAN_MAESTRO.md` §3.

---

## 7. Config, entornos y secretos

- **Dev/prod separados.** Se desarrolla contra un proyecto Firebase de **dev**; prod se toca solo al desplegar.
- Config por entorno vía `@nestjs/config` + `.env` (con `.env.example` commiteado como plantilla, sin valores reales).
- `.env`, service account keys y cualquier secreto → **ignorados por git** (ya cubierto por `.gitignore`).

---

## 8. Tests

- **Caracterización (Fase 0.5):** caja negra sobre endpoints/eventos del monolito actual → captura el comportamiento funcional como "verdad" **antes** de migrar. Es la red de seguridad del estrangulamiento.
- **Por módulo:** a medida que se extrae cada módulo a NestJS, sus services se cubren con tests unitarios (la DI facilita los fakes).

---

## 9. Estilo y naming (PROPUESTA — confirmar con el dev)

- **Identificadores de código en inglés** (estándar profesional; reemplaza el naming de prototipo tipo `LoguinScreen`/`RegistrerScreen`).
- **Términos de dominio del negocio** pueden quedar en español cuando son el vocabulario real (`titular`, `alquilador`) — son "lenguaje ubicuo", pero **consistentes**.
- **Comentarios y docs en español** (idioma del equipo).
- Formateo automático (Prettier) + lint (ESLint) — se configuran en Fase 0/2.

---

## 10. Workflow

- Se trabaja en la rama `development`. A `master` solo llega lo sólido.
- Migración por estrangulamiento: el monolito sigue vivo hasta que cada módulo está migrado y verificado.

---

## 11. Migración a NestJS (Fase 2) — convenciones y gotchas

Cada módulo migrado debe **replicar EXACTAMENTE** el comportamiento del monolito (lo verifica la caracterización). Gotchas confirmados:

- **POST devuelve 201 por defecto en NestJS**; el monolito devuelve 200 (`res.json()`). Usar **`@HttpCode(200)`** en los handlers POST para igualar el contrato.
- **Errores con shape `{ success:false, message }`**: lanzar las HttpException con un OBJETO, no string → `throw new NotFoundException({ success:false, message:'...' })`. Pasar un objeto hace que el body sea EXACTAMENTE ese objeto (un string lo envuelve en `{statusCode,error,message}`).
- **`ignoreUndefinedProperties: true`** se setea en `FirebaseService` (igual que el monolito) → escribir undefined no rompe.
- **Estructura del módulo:** controller (recibe/delega) → service (lógica) → repository (Firestore). El service no toca `db.collection()` directo.

**Cómo correr la caracterización contra NestJS (no contra el monolito):**
1. `npm run build` (compila a `dist/`).
2. En PowerShell: `$env:SERVER_ENTRY = "dist/main.js"` + prependear `node_modules\.bin` al PATH.
3. `firebase emulators:exec --project alrescate-dev "jest --runInBand --forceExit -t /<filtro>"` (ej. `-t /vehicles` corre solo los tests de ese módulo).
   - El harness (`test/setup/server.js`) respeta `SERVER_ENTRY`; sin él corre el monolito (`server.js`).
   - Jest 30: el filtro por archivo es posicional (`jest <patrón>`), NO `--testPathPattern`.
