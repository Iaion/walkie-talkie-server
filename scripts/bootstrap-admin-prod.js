/**
 * scripts/bootstrap-admin-prod.js — crea (o encuentra) el usuario admin en PRODUCCIÓN
 * y le setea el claim role=admin. Usa secrets/serviceAccountKey.prod.json.
 *
 * Uso: node scripts/bootstrap-admin-prod.js <email> <password>
 */
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const key = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'secrets', 'serviceAccountKey.prod.json'), 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(key), projectId: key.project_id });

async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Uso: node scripts/bootstrap-admin-prod.js <email> <password>');
    process.exit(1);
  }

  let user;
  try {
    user = await admin.auth().getUserByEmail(email);
    console.log(`Usuario ya existía: uid=${user.uid}`);
    await admin.auth().updateUser(user.uid, { password, emailVerified: true });
    console.log('Password actualizada y email marcado verificado.');
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      user = await admin.auth().createUser({ email, password, emailVerified: true });
      console.log(`Usuario creado: uid=${user.uid}`);
    } else {
      throw e;
    }
  }

  await admin.auth().setCustomUserClaims(user.uid, { role: 'admin' });
  console.log(`OK: ${email} (uid=${user.uid}) ahora es ADMIN en ${key.project_id}.`);
  process.exit(0);
}

main().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
