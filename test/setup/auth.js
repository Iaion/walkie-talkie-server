/**
 * test/setup/auth.js
 * Obtiene un Firebase ID token REAL del Auth emulator para los tests.
 * Como FIREBASE_AUTH_EMULATOR_HOST está seteado, el Admin SDK del server acepta este token.
 * El endpoint accounts:signUp del emulador crea un usuario anónimo y devuelve su idToken
 * (la apiKey puede ser cualquier cosa con el emulador).
 */
const AUTH_HOST = 'http://127.0.0.1:9099';

async function getIdToken() {
  const res = await fetch(
    `${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }),
    }
  );
  if (!res.ok) {
    throw new Error(`getIdToken falló: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.idToken;
}

module.exports = { getIdToken };
