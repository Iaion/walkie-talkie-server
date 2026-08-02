/**
 * validate.ts
 * Validaciones de payloads de sockets (PLAN_MEJORAS D1). Extienden los chequeos manuales
 * existentes SIN cambiar el contrato de acks (los tests de caracterización son el contrato):
 * un lat=9999 responde el mismo código que un lat faltante.
 */

/** Latitud válida: número finito en [-90, 90]. */
export function isValidLat(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
}

/** Longitud válida: número finito en [-180, 180]. */
export function isValidLng(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;
}

/** String no vacío y acotado (anti payloads gigantes en campos de texto). */
export function isBoundedString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

/** Límites de tamaño de campos de texto que viajan por socket. */
export const MAX_TEXT_MESSAGE = 5_000; // texto de chat
export const MAX_ID_LENGTH = 256; // ids/roomIds/usernames
