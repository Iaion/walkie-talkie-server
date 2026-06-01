/**
 * test/setup/global-setup.js
 * Levanta el monolito (server.js) como proceso hijo, apuntado a los emuladores Firebase,
 * y espera a que /health responda antes de dejar correr los tests.
 * La referencia al proceso se guarda (globalThis + archivo pid) para que el teardown lo apague.
 *
 * Asume que los emuladores YA están corriendo (los levanta `firebase emulators:exec`,
 * o se corren a mano con `firebase emulators:start`).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 8080;

module.exports = async () => {
  const keyPath = path.join(ROOT, 'secrets', 'serviceAccountKey.dev.json');
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Falta la service account key en ${keyPath}. Ver project_progress / ARQUITECTURA.md.`);
  }
  const serviceAccount = fs.readFileSync(keyPath, 'utf8');

  const env = {
    ...process.env,
    GOOGLE_APPLICATION_CREDENTIALS: serviceAccount,
    FIREBASE_STORAGE_BUCKET: 'alrescate-dev.firebasestorage.app',
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8081',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
    FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199',
    PORT: String(PORT),
  };

  const child = spawn('node', [path.join(ROOT, 'server.js')], { env, stdio: 'pipe' });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });

  // Esperar a que /health responda
  const deadline = Date.now() + 15000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) { healthy = true; break; }
    } catch (_) { /* todavía no levantó */ }
    await new Promise((r) => setTimeout(r, 300));
  }

  if (!healthy) {
    child.kill();
    throw new Error('El server no levantó a tiempo.\n--- logs del server ---\n' + logs);
  }

  globalThis.__SERVER_CHILD__ = child;
  fs.writeFileSync(path.join(__dirname, '.server.pid'), String(child.pid));
  console.log(`\n[global-setup] Server de test corriendo (pid ${child.pid}) contra el emulador.`);
};
