/**
 * e2e-seed-full.js (temporal) — seed del e2e del producto entero (proyecto alrescate-cbb6a):
 *  - usuario de la APP (email verificado, la app lo exige)
 *  - usuario ADMIN del panel (custom claim role=admin)
 */
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const key = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'secrets', 'serviceAccountKey.dev.json'), 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(key), projectId: 'alrescate-cbb6a' });

const APP = { uid: 'delivery-e2e', email: 'delivery@alrescate.test', password: 'Test123456' };
const ADMIN = { uid: 'admin-e2e', email: 'admin@alrescate.test', password: 'Test123456' };

(async () => {
  for (const u of [APP, ADMIN]) {
    try { await admin.auth().deleteUser(u.uid); } catch { /* no existía */ }
  }
  await admin.auth().createUser({ uid: APP.uid, email: APP.email, password: APP.password, emailVerified: true });
  await admin.auth().createUser({ uid: ADMIN.uid, email: ADMIN.email, password: ADMIN.password, emailVerified: true });
  await admin.auth().setCustomUserClaims(ADMIN.uid, { role: 'admin' });
  console.log('SEED FULL OK', JSON.stringify({ app: APP.email, admin: ADMIN.email }));
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
