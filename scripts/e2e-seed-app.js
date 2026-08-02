/**
 * e2e-seed-app.js (temporal) — crea el usuario que usará la APP Android en el e2e del emulador.
 * Email verificado (la app lo exige) en el Auth emulator, proyecto alrescate-cbb6a (el de la app).
 */
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const key = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'secrets', 'serviceAccountKey.dev.json'), 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(key), projectId: 'alrescate-cbb6a' });

const U = { uid: 'delivery-e2e', email: 'delivery@alrescate.test', password: 'Test123456' };

(async () => {
  try { await admin.auth().deleteUser(U.uid); } catch { /* no existía */ }
  await admin.auth().createUser({ uid: U.uid, email: U.email, password: U.password, emailVerified: true });
  console.log('APP USER OK', JSON.stringify(U));
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
