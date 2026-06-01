/**
 * test/characterization/location.test.js
 * Caracterización de los eventos Socket.IO de UBICACIÓN (tracking en tiempo real durante
 * una emergencia). Congela acks y, para los broadcasts críticos, verifica que la víctima
 * en la sala de emergencia reciba las actualizaciones.
 */
const { io } = require('socket.io-client');
const { clearFirestore } = require('../setup/emulator');
const { startServer, stopServer } = require('../setup/server');
const { getIdTokenForUid } = require('../setup/auth');

const URL = 'http://127.0.0.1:8080';
const LOC = { lat: -34.6037, lng: -58.3816 };

// Autorización por-usuario: el socket se conecta con un token cuyo uid es el id que emitirá.
const tokenCache = {};
async function tokenFor(uid) {
  if (!tokenCache[uid]) tokenCache[uid] = await getIdTokenForUid(uid);
  return tokenCache[uid];
}
async function connect(uid) {
  const token = await tokenFor(uid);
  return new Promise((resolve, reject) => {
    const socket = io(URL, { transports: ['websocket'], forceNew: true, auth: { token } });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

function waitForEvent(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout esperando "${event}"`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

describe('Caracterización Socket.IO — ubicación en tiempo real', () => {
  let sockets = [];

  beforeAll(async () => { await startServer(); });
  afterAll(stopServer);
  beforeEach(async () => { await clearFirestore(); });
  afterEach(() => { sockets.forEach((s) => s.close()); sockets = []; });

  async function newSocket(uid = 'U0') {
    const s = await connect(uid);
    sockets.push(s);
    return s;
  }

  describe('update_location', () => {
    test('datos inválidos → "Datos inválidos"', async () => {
      const s = await newSocket('U1');
      const res = await s.emitWithAck('update_location', { userId: 'U1' });
      expect(res).toEqual({ success: false, message: 'Datos inválidos' });
    });

    test('usuario no conectado → "Usuario no conectado"', async () => {
      const s = await newSocket('DESCONOCIDO'); // token uid = DESCONOCIDO → pasa authz, pero no está en connectedUsers
      const res = await s.emitWithAck('update_location', { userId: 'DESCONOCIDO', ...LOC });
      expect(res).toEqual({ success: false, message: 'Usuario no conectado' });
    });

    test('usuario conectado → success', async () => {
      const s = await newSocket('U1');
      await s.emitWithAck('user-connected', { id: 'U1', username: 'Juan' });
      const res = await s.emitWithAck('update_location', { userId: 'U1', ...LOC });
      expect(res).toEqual({ success: true });
    });
  });

  describe('update_emergency_location', () => {
    test('datos inválidos → "Datos de ubicación inválidos"', async () => {
      const s = await newSocket('U1');
      const res = await s.emitWithAck('update_emergency_location', { roomId: 'emergencia_U1', userId: 'U1' });
      expect(res).toEqual({ success: false, message: 'Datos de ubicación inválidos' });
    });

    test('userId que no coincide con la sala → solo la víctima puede', async () => {
      const s = await newSocket('U2'); // U2 es un usuario real distinto: pasa authz pero no es la víctima de la sala
      const res = await s.emitWithAck('update_emergency_location', { roomId: 'emergencia_U1', userId: 'U2', ...LOC });
      expect(res).toEqual({ success: false, message: 'Solo la víctima puede actualizar ubicación de emergencia' });
    });

    test('víctima correcta → success', async () => {
      const s = await newSocket('U1');
      const res = await s.emitWithAck('update_emergency_location', { roomId: 'emergencia_U1', userId: 'U1', ...LOC });
      expect(res).toEqual({ success: true });
    });
  });

  describe('update_helper_location', () => {
    test('datos inválidos → "Datos de ubicación inválidos"', async () => {
      const s = await newSocket('H1');
      const res = await s.emitWithAck('update_helper_location', { roomId: 'emergencia_U1', helperId: 'H1' });
      expect(res).toEqual({ success: false, message: 'Datos de ubicación inválidos' });
    });

    test('sala que no es de emergencia → "Solo para salas de emergencia"', async () => {
      const s = await newSocket('H1');
      const res = await s.emitWithAck('update_helper_location', { roomId: 'general', helperId: 'H1', ...LOC });
      expect(res).toEqual({ success: false, message: 'Solo para salas de emergencia' });
    });

    test('válido → success', async () => {
      const s = await newSocket('H1');
      const res = await s.emitWithAck('update_helper_location', { roomId: 'emergencia_U1', helperId: 'H1', ...LOC });
      expect(res).toEqual({ success: true });
    });

    test('broadcast: la víctima en la sala recibe helper_location_updated', async () => {
      const victim = await newSocket('U1');
      await victim.emitWithAck('emergency_alert', { userId: 'U1', userName: 'Juan', latitude: LOC.lat, longitude: LOC.lng });

      const received = waitForEvent(victim, 'helper_location_updated');
      const helper = await newSocket('H1');
      await helper.emitWithAck('update_helper_location', { roomId: 'emergencia_U1', helperId: 'H1', ...LOC });

      const payload = await received;
      expect(payload).toMatchObject({ roomId: 'emergencia_U1', helperId: 'H1', victimId: 'U1', type: 'helper' });
    });
  });

  describe('request_victim_location', () => {
    test('datos incompletos → "Datos incompletos"', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('request_victim_location', { roomId: 'emergencia_U1' });
      expect(res).toEqual({ success: false, message: 'Datos incompletos' });
    });

    test('válido → success', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('request_victim_location', {
        roomId: 'emergencia_U1', helperId: 'H1', emergencyUserId: 'U1',
      });
      expect(res).toEqual({ success: true });
    });
  });

  describe('helpers_location_request', () => {
    test('datos incompletos → "Datos incompletos"', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('helpers_location_request', { roomId: 'emergencia_U1' });
      expect(res).toEqual({ success: false, message: 'Datos incompletos' });
    });

    test('válido sin ayudantes → success con count 0', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('helpers_location_request', { roomId: 'emergencia_U1', emergencyUserId: 'U1' });
      expect(res).toEqual({ success: true, count: 0 });
    });
  });

  describe('helper_driving_status (sin ack → se verifica por broadcast)', () => {
    test('la sala de emergencia recibe helper_driving_update', async () => {
      const victim = await newSocket('U1');
      await victim.emitWithAck('emergency_alert', { userId: 'U1', userName: 'Juan', latitude: LOC.lat, longitude: LOC.lng });

      const received = waitForEvent(victim, 'helper_driving_update');
      const helper = await newSocket('H1');
      helper.emit('helper_driving_status', { roomId: 'emergencia_U1', helperId: 'H1', isDriving: true });

      const payload = await received;
      expect(payload).toMatchObject({ helperId: 'H1', isDriving: true });
    });
  });
});
