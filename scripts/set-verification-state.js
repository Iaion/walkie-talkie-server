/** set-verification-state.js <estado> — cambia users/delivery-e2e.state (para capturas E2E). */
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const key = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'secrets', 'serviceAccountKey.dev.json'), 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(key), projectId: 'alrescate-cbb6a' });

const state = process.argv[2];
if (!state) { console.error('uso: node set-verification-state.js <estado>'); process.exit(1); }

admin.firestore().collection('users').doc('delivery-e2e').set({ state }, { merge: true })
  .then(() => { console.log('STATE =', state); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
