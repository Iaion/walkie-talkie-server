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

/** Convierte un valor del formato REST de Firestore a JS plano. */
function fromFirestoreValue(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in v) return fromFirestoreFields(v.mapValue.fields || {});
  return v;
}

function fromFirestoreFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = fromFirestoreValue(v);
  return out;
}

/** Lee un documento del emulador (vía owner). Devuelve objeto JS plano o null si no existe. */
async function getDoc(collection, id) {
  const res = await fetch(`${DOCS}/${collection}/${encodeURIComponent(id)}`, { headers: OWNER });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getDoc(${collection}/${id}) falló: ${res.status} ${await res.text()}`);
  const doc = await res.json();
  return fromFirestoreFields(doc.fields || {});
}

/** Lista los documentos de una colección (vía owner). Devuelve un array de objetos JS planos. */
async function listDocs(collection) {
  const res = await fetch(`${DOCS}/${collection}`, { headers: OWNER });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`listDocs(${collection}) falló: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.documents || []).map((d) => fromFirestoreFields(d.fields || {}));
}

module.exports = { clearFirestore, setDoc, getDoc, listDocs };
