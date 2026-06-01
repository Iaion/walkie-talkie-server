/**
 * normalize.ts
 * Normalización de datos para los cruces antifraude (Fase 1/3): que alias del mismo dato
 * no evadan la detección de duplicados.
 */

/**
 * Normaliza un email para comparar duplicados.
 * - lowercase + trim.
 * - quita el +tag del local part.
 * - en Gmail, quita los puntos del local part (juan.perez == juanperez).
 */
export function normalizeEmail(email: string): string {
  const lower = (email || '').trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at === -1) return lower;
  let local = lower.slice(0, at);
  const domain = lower.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus !== -1) local = local.slice(0, plus);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '');
  }
  return `${local}@${domain}`;
}

/** Solo dígitos (ignora +54, espacios, guiones, paréntesis). */
export function normalizePhone(phone: string): string {
  return (phone || '').replace(/\D/g, '');
}

/** Sin espacios, puntos ni guiones; lowercase. */
export function normalizeDocument(doc: string): string {
  return (doc || '').replace(/[\s.\-]/g, '').toLowerCase();
}
