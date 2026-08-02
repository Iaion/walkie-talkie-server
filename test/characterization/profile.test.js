/**
 * test/characterization/profile.test.js
 * Caracterización de los eventos Socket.IO de perfil: get_profile y update_profile.
 * Nota de comportamiento congelado: update_profile usa db.update(), que FALLA si el
 * usuario no existe → devuelve success:false (no crea el doc).
 */
const { io } = require('socket.io-client');
const { clearFirestore, setDoc } = require('../setup/emulator');
const { startServer, stopServer } = require('../setup/server');
const { getIdTokenForUid } = require('../setup/auth');

const URL = 'http://127.0.0.1:8080';

// Sockets: token cuyo uid es el id que emitirá (autorización por-usuario). get_profile es lectura
// abierta (un ayudante puede ver el perfil de la víctima); update_profile sí valida identidad.
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

describe('Caracterización Socket.IO — perfil', () => {
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

  describe('get_profile', () => {
    test('sin userId → "userId requerido"', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('get_profile', {});
      expect(res).toEqual({ success: false, message: 'userId requerido' });
    });

    test('usuario inexistente → "Perfil no encontrado"', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('get_profile', { userId: 'NOEXISTE' });
      expect(res).toEqual({ success: false, message: 'Perfil no encontrado' });
    });

    test('usuario existente → success con su perfil', async () => {
      await setDoc('users', 'U1', { uid: 'U1', username: 'Juan', email: 'juan@test.com' });
      const s = await newSocket();
      const res = await s.emitWithAck('get_profile', { userId: 'U1' });
      expect(res.success).toBe(true);
      expect(res.username).toBe('Juan');
      expect(res.email).toBe('juan@test.com');
    });

    test('username vacío → reparado con fallback (email)', async () => {
      await setDoc('users', 'U2', { uid: 'U2', username: '', email: 'ana@test.com' });
      const s = await newSocket();
      const res = await s.emitWithAck('get_profile', { userId: 'U2' });
      expect(res.success).toBe(true);
      expect(res.username).toBe('ana'); // prefijo del email
    });
  });

  describe('update_profile', () => {
    test('sin userId → "userId requerido"', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('update_profile', {});
      expect(res).toEqual({ success: false, message: 'userId requerido' });
    });

    test('usuario inexistente → success:false (update() falla, no crea el doc)', async () => {
      const s = await newSocket('NOEXISTE'); // pasa authz (es su propio uid) pero el doc no existe → update falla
      const res = await s.emitWithAck('update_profile', { userId: 'NOEXISTE', username: 'x' });
      expect(res.success).toBe(false);
    });

    test('usuario existente → success con el perfil actualizado', async () => {
      await setDoc('users', 'U1', { uid: 'U1', username: 'Juan' });
      const s = await newSocket('U1');
      const res = await s.emitWithAck('update_profile', {
        userId: 'U1', fullName: 'Juan Pérez', username: 'juanp', email: 'j@x.com', phone: '123',
      });
      expect(res.success).toBe(true);
      expect(res.message).toBe('Perfil actualizado correctamente');
      expect(res.user).toMatchObject({
        id: 'U1', username: 'juanp', fullName: 'Juan Pérez', email: 'j@x.com', phone: '123',
        status: 'Online', presence: 'Available',
      });
    });
  });
});
