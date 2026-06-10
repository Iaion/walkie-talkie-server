/**
 * test/characterization/validation.test.js
 * Endurecimiento de validación (PLAN_MEJORAS D1/D6): rangos de lat/lng, tope de tamaño
 * de texto y health check profundo. Los acks son LOS MISMOS códigos/mensajes que para
 * datos faltantes (extensión del contrato, no cambio).
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

describe('Validación endurecida de payloads', () => {
  let sockets = [];

  beforeAll(async () => { await startServer(); }, 30000);
  afterAll(stopServer);
  afterEach(() => { sockets.forEach((s) => s.close()); sockets = []; });

  async function newSocket(uid) {
    const s = await connect(uid);
    sockets.push(s);
    return s;
  }

  test('update_location con lat fuera de rango → mismo ack que datos inválidos', async () => {
    const s = await newSocket('V1');
    await s.emitWithAck('user-connected', { id: 'V1', username: 'Vali' });
    const res = await s.emitWithAck('update_location', { userId: 'V1', lat: 999, lng: -58.4 });
    expect(res).toEqual({ success: false, message: 'Datos inválidos' });
  });

  test('update_location con lng infinito → rechazado', async () => {
    const s = await newSocket('V2');
    const res = await s.emitWithAck('update_location', { userId: 'V2', lat: -34.6, lng: 1e9 });
    expect(res).toEqual({ success: false, message: 'Datos inválidos' });
  });

  test('emergency_alert con ubicación fuera de rango → INVALID_LOCATION', async () => {
    const s = await newSocket('V3');
    const res = await s.emitWithAck('emergency_alert', {
      userId: 'V3', userName: 'Vali', latitude: -91, longitude: -58.4,
    });
    expect(res.code).toBe('INVALID_LOCATION');
  });

  test('send_message con texto desmedido (>5000 chars) → mensaje inválido', async () => {
    const s = await newSocket('V4');
    const res = await s.emitWithAck('send_message', {
      userId: 'V4', username: 'Vali', text: 'x'.repeat(6000), roomId: 'general',
    });
    expect(res.success).toBe(false);
    expect(res.message).toContain('inválidos');
  });

  test('GET /health/deep → ok con latencia de Firestore', async () => {
    const res = await fetch(`${URL}/health/deep`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.firestore).toBe('ok');
    expect(typeof body.latencyMs).toBe('number');
  });
});
