/**
 * scripts/bootstrap-admin-prod.js — da rol de admin a un usuario en PRODUCCIÓN.
 * Usa secrets/serviceAccountKey.prod.json.
 *
 * Uso:
 *   node scripts/bootstrap-admin-prod.js <email>              → usuario EXISTENTE: solo agrega el rol (no toca su contraseña)
 *   node scripts/bootstrap-admin-prod.js <email> <password>   → si no existe, lo CREA con esa contraseña
 *
 * El flamante admin tiene que cerrar sesión y volver a entrar al panel para que el rol tome efecto.
 */
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const key = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'secrets', 'serviceAccountKey.prod.json'), 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(key), projectId: key.project_id });

async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email) {
    console.error('Uso: node scripts/bootstrap-admin-prod.js <email> [password-solo-si-es-usuario-nuevo]');
    process.exit(1);
  }

  let user;
  try {
    user = await admin.auth().getUserByEmail(email);
    // Usuario existente: SOLO se agrega el rol. Su contraseña no se toca.
    console.log(`Usuario ya existía: uid=${user.uid} — se le agrega el rol admin, contraseña intacta.`);
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      if (!password) {
        console.error(`${email} no existe. Para crearlo pasá también una contraseña: node scripts/bootstrap-admin-prod.js <email> <password>`);
        process.exit(1);
      }
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
