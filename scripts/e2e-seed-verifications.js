/** e2e-seed-verifications.js — verificaciones pendientes de muestra para capturas del panel. */
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const key = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'secrets', 'serviceAccountKey.dev.json'), 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(key), projectId: 'alrescate-cbb6a' });

const docs = [
  { uid: 'seed-leandro', fullName: 'Leandro Pérez', documentNumber: '38456789', accountType: 'owner', phone: '11 5555-4321', status: 'pending_review', submittedAt: Date.now() - 2 * 3600e3 },
  { uid: 'seed-caro', fullName: 'Caro Gómez', documentNumber: '40123456', accountType: 'renter', phone: '11 4444-8765', status: 'pending_review', submittedAt: Date.now() - 5 * 3600e3, titularName: 'José Gómez', titularDocument: '20111222' },
  { uid: 'seed-matias', fullName: 'Matías Ruiz', documentNumber: '35987654', accountType: 'owner', phone: '11 3333-2211', status: 'pending_review', submittedAt: Date.now() - 26 * 3600e3 },
];

(async () => {
  const db = admin.firestore();
  for (const d of docs) await db.collection('verifications').doc(d.uid).set(d, { merge: true });
  console.log('VERIFICATIONS SEEDED:', docs.length);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
