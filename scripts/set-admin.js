/**
 * scripts/set-admin.js
 * Bootstrap del PRIMER admin (problema huevo-y-gallina: setear el custom claim `admin`
 * requiere ser admin... o correr esto a mano una vez con el Admin SDK).
 *
 * Uso:
 *   GOOGLE_APPLICATION_CREDENTIALS='<contenido del service account JSON>' node scripts/set-admin.js <uid>
 *   o, si existe secrets/serviceAccountKey.dev.json, alcanza con:  node scripts/set-admin.js <uid>
 *
 * Para producción: usar la service account de prod, NO la de dev.
 * El usuario debe re-loguearse (o refrescar el token) para que el claim tome efecto.
 */
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

function loadServiceAccount() {
  const fromEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (fromEnv && fromEnv.trim().startsWith('{')) return JSON.parse(fromEnv);
  const local = path.resolve(__dirname, '..', 'secrets', 'serviceAccountKey.dev.json');
  if (fs.existsSync(local)) return JSON.parse(fs.readFileSync(local, 'utf8'));
  throw new Error('No encontré la service account (ni GOOGLE_APPLICATION_CREDENTIALS con JSON, ni secrets/serviceAccountKey.dev.json)');
}

async function main() {
  const uid = process.argv[2];
  if (!uid) {
    console.error('Uso: node scripts/set-admin.js <uid>');
    process.exit(1);
  }
  admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount()) });
  await admin.auth().setCustomUserClaims(uid, { role: 'admin' });
  console.log(`✅ ${uid} ahora tiene rol admin. (Debe re-loguearse para que el token lo incluya.)`);
  process.exit(0);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
