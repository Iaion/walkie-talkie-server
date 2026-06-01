/**
 * test/characterization/misc.test.js
 * Cierra la cobertura de Fase 0.5: GET de un vehículo puntual, POST /vehicles en modo
 * actualización (con id), subida de foto a Storage (emulador), audio_message, y el efecto
 * observable de disconnect (marcar offline en Firestore).
 */
const request = require('supertest');
const { io } = require('socket.io-client');
const { clearFirestore, setDoc, getDoc } = require('../setup/emulator');
const { startServer, stopServer } = require('../setup/server');
const { getIdTokenWithUid } = require('../setup/auth');

const URL = 'http://127.0.0.1:8080';
let TOKEN;
let UID; // con autorización por-usuario, el userId de las rutas REST de vehículos debe ser el del token
const api = () => {
  const r = request(URL);
  const auth = (req) => req.set('Authorization', `Bearer ${TOKEN}`);
  return { get: (p) => auth(r.get(p)), post: (p) => auth(r.post(p)), delete: (p) => auth(r.delete(p)) };
};

// PNG 1x1 transparente
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function connect() {
  return new Promise((resolve, reject) => {
    const socket = io(URL, { transports: ['websocket'], forceNew: true, auth: { token: TOKEN } });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

async function pollUntil(fn, { timeoutMs = 5000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('pollUntil: timeout');
}

describe('Caracterización — cierre de cobertura Fase 0.5', () => {
  let sockets = [];
  beforeAll(async () => { await startServer(); const t = await getIdTokenWithUid(); TOKEN = t.token; UID = t.uid; });
  afterAll(stopServer);
  beforeEach(async () => { await clearFirestore(); });
  afterEach(() => { sockets.forEach((s) => s.close()); sockets = []; });

  async function newSocket() {
    const s = await connect();
    sockets.push(s);
    return s;
  }

  describe('GET /vehicles/:userId/:vehicleId', () => {
    test('inexistente → 404', async () => {
      const res = await api().get(`/vehicles/${UID}/no-existe`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ success: false, message: 'Vehículo no encontrado' });
    });

    // Path = uid propio (pasa authz), pero el vehículo es de OTRO → check interno del handler.
    test('de otro usuario → 403', async () => {
      await setDoc('vehicles', 'veh-1', { userId: 'OTHER', type: 'CAR', isActive: true });
      const res = await api().get(`/vehicles/${UID}/veh-1`);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ success: false, message: 'No tienes permisos para acceder a este vehículo' });
    });

    test('propio → success con el vehículo', async () => {
      await setDoc('vehicles', 'veh-1', { userId: UID, type: 'CAR', name: 'Auto', isActive: true });
      const res = await api().get(`/vehicles/${UID}/veh-1`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.vehicle).toMatchObject({ id: 'veh-1', userId: UID, name: 'Auto', type: 'CAR' });
    });
  });

  describe('POST /vehicles (modo actualización con id)', () => {
    test('id inexistente → 404', async () => {
      const res = await api().post('/vehicles').send({ id: 'no-existe', userId: UID, type: 'CAR' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ success: false, message: 'Vehículo no encontrado' });
    });

    // Body.userId = uid propio (pasa authz), pero el vehículo es de OTRO → check interno del handler.
    test('de otro usuario → 403', async () => {
      await setDoc('vehicles', 'veh-1', { userId: 'OTHER', type: 'CAR', isActive: true });
      const res = await api().post('/vehicles').send({ id: 'veh-1', userId: UID, type: 'CAR' });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ success: false, message: 'No tienes permisos para editar este vehículo' });
    });

    test('propio → actualiza', async () => {
      await setDoc('vehicles', 'veh-1', { userId: UID, type: 'CAR', name: 'viejo', isActive: true });
      const res = await api().post('/vehicles').send({ id: 'veh-1', userId: UID, type: 'CAR', name: 'nuevo' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Vehículo actualizado');
      expect(res.body.vehicle).toMatchObject({ id: 'veh-1', name: 'nuevo' });
    });
  });

  describe('POST /vehicles/photo (Storage emulador)', () => {
    test('datos inválidos → 400', async () => {
      const res = await api().post('/vehicles/photo').send({ userId: UID, vehicleId: 'veh-1', imageData: 'no-es-dataurl' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, message: 'Datos inválidos: userId, vehicleId e imageData son requeridos' });
    });

    test('vehículo inexistente → 404', async () => {
      const res = await api().post('/vehicles/photo').send({ userId: UID, vehicleId: 'no-existe', imageData: PNG_DATA_URL });
      expect(res.status).toBe(404);
    });

    // Body.userId = uid propio (pasa authz), pero el vehículo es de OTRO → check interno del handler.
    test('de otro usuario → 403', async () => {
      await setDoc('vehicles', 'veh-1', { userId: 'OTHER', type: 'CAR', isActive: true });
      const res = await api().post('/vehicles/photo').send({ userId: UID, vehicleId: 'veh-1', imageData: PNG_DATA_URL });
      expect(res.status).toBe(403);
    });

    test('válido → sube a Storage y devuelve url', async () => {
      await setDoc('vehicles', 'veh-1', { userId: UID, type: 'CAR', isActive: true });
      const res = await api().post('/vehicles/photo').send({ userId: UID, vehicleId: 'veh-1', imageData: PNG_DATA_URL });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.url).toBe('string');
    });
  });

  describe('audio_message', () => {
    test('sin userId/username → "userId/username inválidos"', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('audio_message', { audioUrl: 'https://x.com/a.mp3' });
      expect(res).toEqual({ success: false, message: '❌ userId/username inválidos' });
    });

    test('sala inválida → "No estás en una sala válida"', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('audio_message', { userId: 'U1', username: 'Juan', roomId: 'no-existe', audioUrl: 'https://x.com/a.mp3' });
      expect(res).toEqual({ success: false, message: '❌ No estás en una sala válida' });
    });

    test('sin audio → "No se pudo obtener URL de audio"', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('audio_message', { userId: 'U1', username: 'Juan', roomId: 'general' });
      expect(res).toEqual({ success: false, message: '❌ No se pudo obtener URL de audio' });
    });

    test('con audioUrl directo → success', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('audio_message', { userId: 'U1', username: 'Juan', roomId: 'general', audioUrl: 'https://x.com/a.mp3' });
      expect(res.success).toBe(true);
      expect(res.id).toBeTruthy();
      expect(res.audioUrl).toBe('https://x.com/a.mp3');
    });
  });

  describe('register_fcm_token', () => {
    test('sin userId/fcmToken → "userId y fcmToken requeridos"', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('register_fcm_token', { userId: 'U1' });
      expect(res).toEqual({ success: false, message: 'userId y fcmToken requeridos' });
    });

    test('válido → success y guarda el token en la subcolección', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('register_fcm_token', {
        userId: 'U1', fcmToken: 'tok-1', deviceId: 'dev-1', platform: 'android',
      });
      expect(res).toMatchObject({ success: true, message: 'Token registrado', deviceId: 'dev-1' });

      const tokenDoc = await getDoc('users/U1/fcmTokens', 'dev-1');
      expect(tokenDoc.token).toBe('tok-1');
      expect(tokenDoc.enabled).toBe(true);
    });
  });

  describe('disconnect', () => {
    test('al desconectar la última conexión, el usuario queda offline en Firestore', async () => {
      const s = await newSocket();
      await s.emitWithAck('user-connected', { id: 'U1', username: 'Juan' });

      // Tras user-connected el doc existe y está online
      const online = await getDoc('users', 'U1');
      expect(online.isOnline).toBe(true);

      s.close();

      // disconnect es asíncrono → poll hasta isOnline=false
      const offline = await pollUntil(async () => {
        const doc = await getDoc('users', 'U1');
        return doc && doc.isOnline === false ? doc : null;
      });
      expect(offline.isOnline).toBe(false);
    });
  });
});
