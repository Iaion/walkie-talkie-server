/**
 * test/setup/emulator.js
 * Helpers para sembrar y limpiar datos en el emulador de Firestore vía su REST API,
 * usando el token `owner` (que saltea las Security Rules, igual que el Admin SDK del server).
 * Permite tests deterministas: cada test parte de un estado conocido.
 */
const PROJECT = 'alrescate-dev';
const HOST = 'http://127.0.0.1:8081';
const DOCS = `${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;
const OWNER = { Authorization: 'Bearer owner' };

/** Borra TODOS los documentos del emulador (aislamiento entre tests). */
async function clearFirestore() {
  const res = await fetch(
    `${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: 'DELETE', headers: OWNER }
  );
  if (!res.ok) throw new Error(`clearFirestore falló: ${res.status} ${await res.text()}`);
}

/** Convierte un objeto JS plano al formato "fields" de la REST de Firestore. */
function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') fields[k] = { stringValue: v };
    else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
    else if (typeof v === 'number') {
      fields[k] = Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    } else if (v === null || v === undefined) fields[k] = { nullValue: null };
    else fields[k] = { stringValue: String(v) };
  }
  return fields;
}

/** Crea/sobrescribe un documento en `collection/id` con los campos dados. */
async function setDoc(collection, id, data) {
  const res = await fetch(`${DOCS}/${collection}?documentId=${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { ...OWNER, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFirestoreFields(data) }),
  });
  if (!res.ok) throw new Error(`setDoc(${collection}/${id}) falló: ${res.status} ${await res.text()}`);
}

module.exports = { clearFirestore, setDoc };
