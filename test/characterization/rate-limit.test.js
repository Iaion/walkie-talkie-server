/**
 * test/characterization/rate-limit.test.js
 * Rate limiting (PLAN_MEJORAS A2). Esta suite levanta SU server con límites mínimos por env
 * (no afecta a las demás: server por archivo). Verifica:
 * - sockets: al exceder el límite por-socket de un evento caliente, ack RATE_LIMITED y el
 *   handler NO se ejecuta; otro evento u otro socket no se ven afectados.
 * - REST: al exceder el límite por IP, 429.
 */
const { io } = require('socket.io-client');
const { startServer, stopServer, PORT } = require('../setup/server');
const { getIdTokenForUid } = require('../setup/auth');

const URL = `http://127.0.0.1:${PORT}`;

async function connect(uid) {
  const token = await getIdTokenForUid(uid);
  return new Promise((resolve, reject) => {
    const socket = io(URL, { transports: ['websocket'], forceNew: true, auth: { token } });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

describe('Rate limiting', () => {
  let sockets = [];

  beforeAll(async () => {
    await startServer({
      SOCKET_RATE_WINDOW_MS: '60000',
      SOCKET_RATE_LIMIT_SEND_MESSAGE: '3',
      SOCKET_RATE_LIMIT_EMERGENCY_ALERT: '2',
      REST_RATE_WINDOW_MS: '60000',
      REST_RATE_LIMIT: '10',
    });
  }, 30000);
  afterAll(stopServer);
  afterEach(() => { sockets.forEach((s) => s.close()); sockets = []; });

  async function newSocket(uid) {
    const s = await connect(uid);
    sockets.push(s);
    return s;
  }

  test('socket: send_message al 4º intento responde RATE_LIMITED', async () => {
    const s = await newSocket('RL1');
    // Payload inválido a propósito: el throttle corre ANTES de validar, y así no hace falta
    // armar sala; los 3 primeros acks son el error de validación de siempre.
    for (let i = 0; i < 3; i++) {
      const res = await s.emitWithAck('send_message', {});
      expect(res.message).toContain('inválidos');
    }
    const limited = await s.emitWithAck('send_message', {});
    expect(limited.success).toBe(false);
    expect(limited.message).toContain('RATE_LIMITED');
  });

  test('socket: el límite es por-evento (otro evento sigue andando) y por-socket', async () => {
    const s = await newSocket('RL2');
    for (let i = 0; i < 4; i++) await s.emitWithAck('send_message', {});
    // Mismo socket, otro evento: no limitado.
    const other = await s.emitWithAck('get_users', { roomId: 'general' });
    expect(other.message || '').not.toContain('RATE_LIMITED');
    // Otro socket (otro usuario), mismo evento: no limitado.
    const s2 = await newSocket('RL3');
    const fresh = await s2.emitWithAck('send_message', {});
    expect(fresh.message).toContain('inválidos');
  });

  test('socket: emergency_alert limitado con code RATE_LIMITED', async () => {
    const s = await newSocket('RL4');
    for (let i = 0; i < 2; i++) {
      const res = await s.emitWithAck('emergency_alert', {});
      expect(res.code).toBe('INVALID_DATA');
    }
    const limited = await s.emitWithAck('emergency_alert', {});
    expect(limited.code).toBe('RATE_LIMITED');
  });

  test('REST: exceder el límite por IP devuelve 429', async () => {
    let got429 = false;
    const statuses = [];
    for (let i = 0; i < 15; i++) {
      const res = await fetch(`${URL}/health`);
      statuses.push(res.status);
      if (res.status === 429) { got429 = true; break; }
    }
    expect(statuses[0]).toBe(200); // al principio pasa
    expect(got429).toBe(true); // y al spamear, corta
  });
});
