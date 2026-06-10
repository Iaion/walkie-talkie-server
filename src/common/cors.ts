/**
 * cors.ts
 * Origen único de la política CORS (REST y Socket.IO).
 * - Con ALLOWED_ORIGINS (CSV de orígenes, ej. "https://app.alrescate.org,https://panel.alrescate.org"):
 *   solo esos orígenes pueden hacer requests cross-origin / abrir sockets desde un browser.
 * - Sin la var (dev, emuladores, tests): abierto como el monolito, para no romper el entorno local.
 * En producción ALLOWED_ORIGINS es OBLIGATORIA (ver DEPLOYMENT.md). Nota: el panel servido en
 * /panel es same-origin y no depende de esto; la app Android tampoco (no manda header Origin).
 */
export function corsOrigins(): string[] | '*' {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw || !raw.trim()) return '*';
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}
