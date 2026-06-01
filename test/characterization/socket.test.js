/**
 * test/characterization/socket.test.js
 * Caracterización de los eventos Socket.IO CRÍTICOS (el núcleo de vida: pánico + ayuda).
 * Congela el comportamiento ACTUAL de los acks y del lock global de emergencia, para
 * detectar regresiones al estrangular el monolito (Fase 2).
 *
 * Estrategia: caja negra. Conectamos clientes reales (socket.io-client) al server corriendo
 * y verificamos las respuestas (acks). El lock vive en Firestore (emulador) → clearFirestore
 * en beforeEach lo resetea, garantizando aislamiento entre tests.
 */
const { io } = require('socket.io-client');
const { clearFirestore } = require('../setup/emulator');
const { startServer, stopServer } = require('../setup/server');

const URL = 'http://127.0.0.1:8080';
const COORDS = { latitude: -34.6037, longitude: -58.3816 }; // Buenos Aires

function connect() {
  return new Promise((resolve, reject) => {
    const socket = io(URL, { transports: ['websocket'], forceNew: true });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

describe('Caracterización Socket.IO — eventos críticos del monolito', () => {
  let sockets = [];

  beforeAll(startServer);
  afterAll(stopServer);

  beforeEach(async () => {
    await clearFirestore();
  });

  afterEach(() => {
    sockets.forEach((s) => s.close());
    sockets = [];
  });

  async function newSocket() {
    const s = await connect();
    sockets.push(s);
    return s;
  }

  describe('user-connected', () => {
    test('sin id → ack failure con mensaje específico', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('user-connected', {});
      expect(res).toEqual({
        success: false,
        message: '⚠️ Datos de usuario inválidos (id requerido)',
      });
    });

    test('con id → ack success con userId y username', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('user-connected', { id: 'U1', username: 'Juan' });
      expect(res).toMatchObject({ success: true, userId: 'U1', username: 'Juan' });
    });

    test('username cae a fallbacks (fullName) si no viene username', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('user-connected', { id: 'U2', fullName: 'Ana Pérez' });
      expect(res).toMatchObject({ success: true, userId: 'U2', username: 'Ana Pérez' });
    });
  });

  describe('emergency_alert (botón de pánico)', () => {
    test('sin userId/userName → INVALID_DATA', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('emergency_alert', { ...COORDS });
      expect(res).toMatchObject({ success: false, code: 'INVALID_DATA' });
    });

    test('coordenadas no numéricas → INVALID_LOCATION', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('emergency_alert', { userId: 'U1', userName: 'Juan' });
      expect(res).toMatchObject({ success: false, code: 'INVALID_LOCATION' });
    });

    test('válida → success con emergencyRoomId = "emergencia_<userId>"', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('emergency_alert', { userId: 'U1', userName: 'Juan', ...COORDS });
      expect(res).toMatchObject({ success: true, emergencyRoomId: 'emergencia_U1' });
    });

    test('segunda emergencia concurrente (otro usuario) → EMERGENCY_ALREADY_ACTIVE (lock global)', async () => {
      const s1 = await newSocket();
      const r1 = await s1.emitWithAck('emergency_alert', { userId: 'U1', userName: 'Juan', ...COORDS });
      expect(r1).toMatchObject({ success: true });

      const s2 = await newSocket();
      const r2 = await s2.emitWithAck('emergency_alert', { userId: 'U2', userName: 'Ana', ...COORDS });
      expect(r2).toMatchObject({ success: false, code: 'EMERGENCY_ALREADY_ACTIVE' });
    });

    test('tras resolver la emergencia, se puede levantar otra', async () => {
      const s1 = await newSocket();
      await s1.emitWithAck('emergency_alert', { userId: 'U1', userName: 'Juan', ...COORDS });
      await s1.emitWithAck('emergency_resolve', { userId: 'U1' });

      const s2 = await newSocket();
      const r2 = await s2.emitWithAck('emergency_alert', { userId: 'U2', userName: 'Ana', ...COORDS });
      expect(r2).toMatchObject({ success: true });
    });
  });

  describe('help_confirm / help_reject', () => {
    test('help_confirm sin datos → "Datos incompletos"', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('help_confirm', {});
      expect(res).toEqual({ success: false, message: 'Datos incompletos' });
    });

    test('help_confirm con datos → {success:true}', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('help_confirm', {
        emergencyUserId: 'U1', helperId: 'H1', helperName: 'Pedro',
      });
      expect(res).toEqual({ success: true });
    });

    test('help_reject sin datos → "Datos incompletos"', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('help_reject', {});
      expect(res).toEqual({ success: false, message: 'Datos incompletos' });
    });

    test('help_reject con datos → {success:true}', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('help_reject', { emergencyUserId: 'U1', helperId: 'H1' });
      expect(res).toEqual({ success: true });
    });
  });

  describe('emergency_resolve', () => {
    test('sin userId → "userId requerido"', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('emergency_resolve', {});
      expect(res).toMatchObject({ success: false, message: 'userId requerido' });
    });
  });
});
