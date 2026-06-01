/**
 * test/setup/global-teardown.js
 * Apaga el proceso del server levantado en global-setup.
 * Usa la referencia de globalThis y, como fallback, el pid guardado en archivo.
 */
const fs = require('fs');
const path = require('path');

module.exports = async () => {
  const child = globalThis.__SERVER_CHILD__;
  if (child && !child.killed) {
    child.kill();
  }

  // Fallback por pid (por si globalThis no persistió)
  const pidFile = path.join(__dirname, '.server.pid');
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    try { process.kill(pid); } catch (_) { /* ya estaba muerto */ }
    fs.unlinkSync(pidFile);
  }
};
