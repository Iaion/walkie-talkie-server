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

/**
 * @param {Record<string,string>} extraEnv — env extra para ESTA suite (ej. ALLOWED_ORIGINS
 *        para probar CORS, o límites de rate-limit bajos). No afecta a las demás suites
 *        porque cada archivo levanta su propio server.
 * @param {{clearData?: boolean}} opts — clearData=true (default) limpia Firestore ANTES de
 *        bootear: el server rehidrata emergencias activas al arrancar (Fase E) y sin esta
 *        limpieza los restos de una suite anterior contaminarían a la siguiente.
 *        El test de restart usa clearData:false para verificar justamente la rehidratación.
 */
async function startServer(extraEnv = {}, opts = {}) {
  const { clearData = true } = opts;
  if (clearData) {
    const { clearFirestore } = require('./emulator');
    await clearFirestore();
  }
  // Con la key presente (dev local) se usa; sin ella (CI) el server inicializa firebase-admin
  // en modo emulador solo con projectId (los emuladores no validan credenciales).
  const keyPath = path.join(ROOT, 'secrets', 'serviceAccountKey.dev.json');
  const credentials = fs.existsSync(keyPath)
    ? { GOOGLE_APPLICATION_CREDENTIALS: fs.readFileSync(keyPath, 'utf8') }
    : { FIREBASE_PROJECT_ID: 'alrescate-dev' };

  const env = {
    ...process.env,
    ...credentials,
    FIREBASE_STORAGE_BUCKET: 'alrescate-dev.firebasestorage.app',
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8081',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
    FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199',
    PORT: String(PORT),
    ...extraEnv,
  };

  // El server activo es NestJS (dist/main.js). SERVER_ENTRY permite override (ej. para comparar con el viejo monolito).
  const entry = process.env.SERVER_ENTRY || 'dist/main.js';
  child = spawn('node', [path.join(ROOT, entry)], { env, stdio: 'pipe' });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });

  // 40s: con la máquina fría, el boot (NestJS + firebase-admin contra emuladores) puede
  // superar los 15s originales — era el flake recurrente de socket/misc/restart.test.
  const deadline = Date.now() + 40000;
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
