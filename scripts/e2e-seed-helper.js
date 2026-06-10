/**
 * e2e-seed-helper.js (E2E grande) — segundo usuario APROBADO para el flujo de ayudante.
 */
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const key = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'secrets', 'serviceAccountKey.dev.json'), 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(key), projectId: 'alrescate-cbb6a' });

const U = { uid: 'helper-e2e', email: 'helper@alrescate.test', password: 'Test123456' };

(async () => {
  try { await admin.auth().deleteUser(U.uid); } catch { /* no existía */ }
  await admin.auth().createUser({ uid: U.uid, email: U.email, password: U.password, emailVerified: true });
  await admin.firestore().collection('users').doc(U.uid).set(
    { state: 'approved', accountType: 'owner', role: 'delivery' },
    { merge: true },
  );
  console.log('HELPER OK', JSON.stringify(U));
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
