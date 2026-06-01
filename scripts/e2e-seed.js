/**
 * e2e-seed.js (solo para el e2e del panel admin, NO producción)
 * Crea un admin con email/password + claim role=admin en el emulador de Auth, y siembra
 * una verificación pendiente para aprobar desde el panel. Requiere las env vars de emulador.
 */
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const key = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'secrets', 'serviceAccountKey.dev.json'), 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(key), projectId: 'alrescate-dev' });

const ADMIN = { uid: 'admin-e2e', email: 'admin-e2e@alrescate.test', password: 'Test1234!' };
const DELIVERY = 'DELIVERY1';

(async () => {
  try { await admin.auth().deleteUser(ADMIN.uid); } catch { /* no existía */ }
  await admin.auth().createUser({ uid: ADMIN.uid, email: ADMIN.email, password: ADMIN.password });
  await admin.auth().setCustomUserClaims(ADMIN.uid, { role: 'admin' });

  const db = admin.firestore();
  await db.collection('users').doc(DELIVERY).set({
    uid: DELIVERY, state: 'pending_review', role: 'delivery', accountType: 'owner',
    fullName: 'Pedro Delivery', documentNumber: '30111222',
  });
  await db.collection('verifications').doc(DELIVERY).set({
    uid: DELIVERY, accountType: 'owner', status: 'pending_review',
    fullName: 'Pedro Delivery', documentNumber: '30111222', phone: '+54 11 5555-0000',
    flags: [{ code: 'DEMO', message: 'Verificación de prueba e2e' }],
    submittedAt: Date.now(),
    selfieUrl: 'https://via.placeholder.com/200x200.png?text=Selfie',
    documentUrl: 'https://via.placeholder.com/200x200.png?text=DNI',
  });

  // eslint-disable-next-line no-console
  console.log('SEED OK', JSON.stringify(ADMIN));
  process.exit(0);
})().catch((e) => { console.error('SEED FAIL', e); process.exit(1); });
