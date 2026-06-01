/**
 * test/setup/auth.js
 * Tokens del Auth emulator para los tests.
 * - getIdToken(): usuario nuevo (delivery, sin claims).
 * - getAdminIdToken(): usuario con el custom claim role=admin (se setea vía firebase-admin
 *   contra el emulador y se refresca el token para que lo incluya).
 */
const fs = require('fs');
const path = require('path');

const AUTH_HOST = 'http://127.0.0.1:9099';
const PROJECT = 'alrescate-dev';

async function signUp() {
  const res = await fetch(
    `${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) },
  );
  if (!res.ok) throw new Error(`signUp falló: ${res.status} ${await res.text()}`);
  return res.json(); // { idToken, refreshToken, localId, ... }
}

async function getIdToken() {
  return (await signUp()).idToken;
}

async function getIdTokenWithUid() {
  const { idToken, localId } = await signUp();
  return { token: idToken, uid: localId };
}

async function refreshIdToken(refreshToken) {
  const res = await fetch(
    `${AUTH_HOST}/securetoken.googleapis.com/v1/token?key=fake-api-key`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }) },
  );
  if (!res.ok) throw new Error(`refresh falló: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.id_token || data.idToken;
}

let adminInitialized = false;
function firebaseAdmin() {
  const admin = require('firebase-admin');
  if (!adminInitialized) {
    const keyPath = path.resolve(__dirname, '..', '..', 'secrets', 'serviceAccountKey.dev.json');
    const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: PROJECT });
    adminInitialized = true;
  }
  return admin;
}

async function getAdminIdToken() {
  const { refreshToken, localId } = await signUp();
  await firebaseAdmin().auth().setCustomUserClaims(localId, { role: 'admin' });
  // El token nuevo (vía refresh) ya incluye el claim.
  return refreshIdToken(refreshToken);
}

/**
 * Mintea un ID token con un uid ESPECÍFICO (para tests de autorización por-usuario en sockets:
 * el evento manda userId='U1' y el socket debe conectarse con un token cuyo uid sea 'U1').
 * Vía custom token (firmado con la service account) → signInWithCustomToken en el emulador.
 */
async function getIdTokenForUid(uid, claims) {
  const customToken = await firebaseAdmin().auth().createCustomToken(uid, claims || {});
  const res = await fetch(
    `${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: customToken, returnSecureToken: true }) },
  );
  if (!res.ok) throw new Error(`signInWithCustomToken falló: ${res.status} ${await res.text()}`);
  return (await res.json()).idToken;
}

module.exports = { getIdToken, getIdTokenWithUid, getIdTokenForUid, getAdminIdToken };
