/**
 * c4-approve.js (temporal del E2E C4) — marca approved al usuario del e2e directamente
 * con el Admin SDK (equivale a la aprobación del panel, ya verificada en su propio E2E).
 */
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const key = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'secrets', 'serviceAccountKey.dev.json'), 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(key), projectId: 'alrescate-cbb6a' });

(async () => {
  await admin.firestore().collection('users').doc('delivery-e2e').set(
    { state: 'approved', accountType: 'owner', role: 'delivery' },
    { merge: true },
  );
  console.log('APPROVED OK delivery-e2e');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
