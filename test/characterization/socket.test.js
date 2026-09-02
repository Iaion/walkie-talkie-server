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
const { clearFirestore, listDocs, setDoc } = require('../setup/emulator');
const { startServer, stopServer } = require('../setup/server');
const { getIdTokenForUid } = require('../setup/auth');

const URL = 'http://127.0.0.1:8080';
const COORDS = { latitude: -34.6037, longitude: -58.3816 }; // Buenos Aires

// Con autorización por-usuario, el socket debe conectarse con un token cuyo uid sea el userId
// que emitirá (p.ej. 'U1'). Cacheamos un token por uid.
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

describe('Caracterización Socket.IO — eventos críticos del monolito', () => {
  let sockets = [];

  beforeAll(async () => { await startServer(); });
  afterAll(stopServer);

  beforeEach(async () => {
    await clearFirestore();
  });

  afterEach(() => {
    sockets.forEach((s) => s.close());
    sockets = [];
  });

  // uid: el id propio que el socket va a emitir (default 'U0' para los tests que fallan por datos faltantes).
  async function newSocket(uid = 'U0') {
    const s = await connect(uid);
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
      const s = await newSocket('U1');
      const res = await s.emitWithAck('user-connected', { id: 'U1', username: 'Juan' });
      expect(res).toMatchObject({ success: true, userId: 'U1', username: 'Juan' });
    });

    test('username cae a fallbacks (fullName) si no viene username', async () => {
      const s = await newSocket('U2');
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
      const s = await newSocket('U1');
      const res = await s.emitWithAck('emergency_alert', { userId: 'U1', userName: 'Juan' });
      expect(res).toMatchObject({ success: false, code: 'INVALID_LOCATION' });
    });

    test('válida → success con emergencyRoomId = "emergencia_<userId>"', async () => {
      const s = await newSocket('U1');
      const res = await s.emitWithAck('emergency_alert', { userId: 'U1', userName: 'Juan', ...COORDS });
      expect(res).toMatchObject({ success: true, emergencyRoomId: 'emergencia_U1' });
    });

    test('segunda emergencia concurrente (otro usuario) → EMERGENCY_ALREADY_ACTIVE (lock global)', async () => {
      const s1 = await newSocket('U1');
      const r1 = await s1.emitWithAck('emergency_alert', { userId: 'U1', userName: 'Juan', ...COORDS });
      expect(r1).toMatchObject({ success: true });

      const s2 = await newSocket('U2');
      const r2 = await s2.emitWithAck('emergency_alert', { userId: 'U2', userName: 'Ana', ...COORDS });
      expect(r2).toMatchObject({ success: false, code: 'EMERGENCY_ALREADY_ACTIVE' });
    });

    test('tras resolver la emergencia, se puede levantar otra', async () => {
      const s1 = await newSocket('U1');
      await s1.emitWithAck('emergency_alert', { userId: 'U1', userName: 'Juan', ...COORDS });
      await s1.emitWithAck('emergency_resolve', { userId: 'U1' });

      const s2 = await newSocket('U2');
      const r2 = await s2.emitWithAck('emergency_alert', { userId: 'U2', userName: 'Ana', ...COORDS });
      expect(r2).toMatchObject({ success: true });
    });
  });

  describe('help_confirm / help_reject', () => {
    // Desde 8da8438 el ayudante debe existir en users/ con state=approved.
    beforeEach(async () => {
      await setDoc('users', 'H1', { state: 'approved' });
    });

    test('help_confirm sin datos → "Datos incompletos"', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('help_confirm', {});
      expect(res).toEqual({ success: false, message: 'Datos incompletos' });
    });

    test('help_confirm con datos → {success:true}', async () => {
      const s = await newSocket('H1');
      const res = await s.emitWithAck('help_confirm', {
        emergencyUserId: 'U1', helperId: 'H1', helperName: 'Pedro',
      });
      expect(res).toEqual({ success: true });
    });

    test('help_confirm de un usuario inexistente → USER_NOT_FOUND', async () => {
      const s = await newSocket('H2');
      const res = await s.emitWithAck('help_confirm', {
        emergencyUserId: 'U1', helperId: 'H2', helperName: 'Fantasma',
      });
      expect(res).toMatchObject({ success: false, code: 'USER_NOT_FOUND' });
    });

    test('help_confirm de un usuario sin aprobar → USER_NOT_APPROVED', async () => {
      await setDoc('users', 'H2', { state: 'pending_review' });
      const s = await newSocket('H2');
      const res = await s.emitWithAck('help_confirm', {
        emergencyUserId: 'U1', helperId: 'H2', helperName: 'Pendiente',
      });
      expect(res).toMatchObject({ success: false, code: 'USER_NOT_APPROVED' });
    });

    test('help_reject sin datos → "Datos incompletos"', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('help_reject', {});
      expect(res).toEqual({ success: false, message: 'Datos incompletos' });
    });

    test('help_reject con datos → {success:true}', async () => {
      const s = await newSocket('H1');
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

  describe('emergency_resolve — limpieza de historial', () => {
    // uid propio (U9) para no colisionar con el resolveInProgress (cooldown 2s) de otros tests.
    test('borra los mensajes de la sala de emergencia al resolver', async () => {
      const s = await newSocket('U9');
      await s.emitWithAck('emergency_alert', { userId: 'U9', userName: 'Juan', ...COORDS });
      const msg = await s.emitWithAck('send_message', { userId: 'U9', username: 'Juan', text: 'auxilio', roomId: 'emergencia_U9' });
      expect(msg.success).toBe(true);
      expect((await listDocs('messages')).length).toBeGreaterThanOrEqual(1);

      await s.emitWithAck('emergency_resolve', { userId: 'U9' });
      expect((await listDocs('messages')).length).toBe(0);
    });
  });

  // Capa NUEVA: un socket no puede hacerse pasar por OTRO uid (spoofing de identidad).
  describe('Autorización por-usuario (anti-spoofing)', () => {
    test('emergency_alert con userId ajeno → FORBIDDEN', async () => {
      const s = await newSocket('U1'); // el token tiene uid = U1
      const res = await s.emitWithAck('emergency_alert', { userId: 'VICTIMA-AJENA', userName: 'X', ...COORDS });
      expect(res).toMatchObject({ success: false, code: 'FORBIDDEN' });
    });

    test('user-connected con id ajeno → No autorizado', async () => {
      const s = await newSocket('U1');
      const res = await s.emitWithAck('user-connected', { id: 'OTRO-UID', username: 'X' });
      expect(res.success).toBe(false);
      expect(res.message).toMatch(/No autorizado/);
    });

    test('help_confirm declarando helperId ajeno → No autorizado', async () => {
      const s = await newSocket('H1');
      const res = await s.emitWithAck('help_confirm', { emergencyUserId: 'U1', helperId: 'OTRO-HELPER' });
      expect(res.success).toBe(false);
      expect(res.message).toMatch(/No autorizado/);
    });
  });
});
