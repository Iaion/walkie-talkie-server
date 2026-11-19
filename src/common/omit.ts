/** Copia superficial de `obj` sin las claves indicadas. */
export function omit(obj: Record<string, any>, ...keys: string[]): Record<string, any> {
  const out: Record<string, any> = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}
