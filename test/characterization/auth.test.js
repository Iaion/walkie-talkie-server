/**
 * test/characterization/auth.test.js
 * Verifica la SEGURIDAD agregada en Fase 1: el server exige un Firebase ID token válido.
 * Usa requests/sockets SIN autenticar a propósito (no el helper authed).
 */
const request = require('supertest');
const { io } = require('socket.io-client');
const { startServer, stopServer } = require('../setup/server');
const { getIdToken } = require('../setup/auth');

const URL = 'http://127.0.0.1:8080';

describe('Seguridad (Fase 1) — autenticación', () => {
  beforeAll(startServer);
  afterAll(stopServer);

  describe('REST', () => {
    test('/health es público → 200 sin token', async () => {
      const res = await request(URL).get('/health');
      expect(res.status).toBe(200);
    });

    test('endpoint protegido sin token → 401', async () => {
      const res = await request(URL).get('/vehicles/U1');
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ success: false });
    });

    test('endpoint protegido con token inválido → 401', async () => {
      const res = await request(URL).get('/vehicles/U1').set('Authorization', 'Bearer token-invalido');
      expect(res.status).toBe(401);
    });

    test('endpoint protegido con token válido → pasa (200)', async () => {
      const token = await getIdToken();
      const res = await request(URL).get('/vehicles/U1').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });
  });

  describe('Socket.IO', () => {
    function tryConnect(opts) {
      return new Promise((resolve, reject) => {
        const socket = io(URL, { transports: ['websocket'], forceNew: true, ...opts });
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', (err) => { socket.close(); reject(err); });
      });
    }

    test('sin token → rechaza la conexión', async () => {
      await expect(tryConnect({})).rejects.toBeDefined();
    });

    test('con token inválido → rechaza la conexión', async () => {
      await expect(tryConnect({ auth: { token: 'token-invalido' } })).rejects.toBeDefined();
    });

    test('con token válido → conecta', async () => {
      const token = await getIdToken();
      const socket = await tryConnect({ auth: { token } });
      expect(socket.connected).toBe(true);
      socket.close();
    });
  });
});
