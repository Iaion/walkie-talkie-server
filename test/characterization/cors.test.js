/**
 * test/characterization/cors.test.js
 * CORS con whitelist (PLAN_MEJORAS A1): con ALLOWED_ORIGINS seteada, solo los orígenes
 * listados reciben el header Access-Control-Allow-Origin (un browser ajeno queda bloqueado);
 * los no listados, no. Aplica tanto a REST como al handshake HTTP de Socket.IO (polling).
 * Nota: la protección CORS la aplica el browser en base a estos headers; un cliente no-browser
 * (la app Android) no manda Origin y no se ve afectado.
 */
const { startServer, stopServer, PORT } = require('../setup/server');

const BASE = `http://127.0.0.1:${PORT}`;
const PERMITIDO = 'https://panel.alrescate.example';
const AJENO = 'https://malicioso.example';

describe('CORS con ALLOWED_ORIGINS (whitelist activa)', () => {
  beforeAll(async () => {
    await startServer({ ALLOWED_ORIGINS: `${PERMITIDO}, https://otro.alrescate.example` });
  }, 30000);
  afterAll(stopServer);

  test('REST: origen permitido recibe Access-Control-Allow-Origin', async () => {
    const res = await fetch(`${BASE}/health`, { headers: { Origin: PERMITIDO } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(PERMITIDO);
  });

  test('REST: origen NO listado no recibe Access-Control-Allow-Origin', async () => {
    const res = await fetch(`${BASE}/health`, { headers: { Origin: AJENO } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('REST: preflight OPTIONS de origen ajeno no autoriza', async () => {
    const res = await fetch(`${BASE}/vehicles/u1`, {
      method: 'OPTIONS',
      headers: {
        Origin: AJENO,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('Socket.IO (handshake polling): origen permitido sí, ajeno no', async () => {
    const ok = await fetch(`${BASE}/socket.io/?EIO=4&transport=polling`, {
      headers: { Origin: PERMITIDO },
    });
    expect(ok.headers.get('access-control-allow-origin')).toBe(PERMITIDO);

    const mal = await fetch(`${BASE}/socket.io/?EIO=4&transport=polling`, {
      headers: { Origin: AJENO },
    });
    expect(mal.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('CORS sin ALLOWED_ORIGINS (modo dev, abierto como siempre)', () => {
  beforeAll(async () => {
    await startServer();
  }, 30000);
  afterAll(stopServer);

  test('REST: cualquier origen recibe CORS abierto', async () => {
    const res = await fetch(`${BASE}/health`, { headers: { Origin: AJENO } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
