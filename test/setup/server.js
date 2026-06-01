/**
 * test/setup/server.js
 * Arranca/para el monolito (server.js) como proceso hijo, apuntado a los emuladores.
 * Se usa con beforeAll/afterAll EN CADA archivo de test, para que cada suite tenga un
 * server con estado EN MEMORIA limpio (el monolito guarda emergencias/usuarios/locks en
 * memoria, y clearFirestore no los toca). Aislamiento real entre archivos.
 *
 * Asume que los emuladores ya están corriendo (los levanta `firebase emulators:exec`).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 8080;
let child = null;

async function startServer() {
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

  // El server activo es NestJS (dist/main.js). SERVER_ENTRY permite override (ej. para comparar con el viejo monolito).
  const entry = process.env.SERVER_ENTRY || 'dist/main.js';
  child = spawn('node', [path.join(ROOT, entry)], { env, stdio: 'pipe' });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return;
    } catch (_) { /* todavía no levantó */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error('El server no levantó a tiempo.\n--- logs del server ---\n' + logs);
}

async function stopServer() {
  if (!child) return;
  const c = child;
  child = null;
  await new Promise((resolve) => {
    c.once('exit', resolve);
    c.kill();
    setTimeout(resolve, 2000); // fallback por si no emite 'exit'
  });
}

module.exports = { startServer, stopServer, PORT };
