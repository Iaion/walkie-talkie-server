/**
 * test/characterization/vehicles-fcm.test.js
 * Caracterización de los endpoints REST que ESCRIBEN en Firestore: CRUD de vehículos
 * y gestión de tokens FCM. Congela el comportamiento actual (incluidas rarezas como que
 * "usuario no encontrado" devuelve 500 en cleanup/refresh por throw dentro de la transacción).
 */
const request = require('supertest');
const { clearFirestore, setDoc } = require('../setup/emulator');
const { startServer, stopServer } = require('../setup/server');
const { getIdTokenWithUid } = require('../setup/auth');

let TOKEN;
let UID; // con autorización por-usuario, el userId (path/body) debe ser el del token
const api = () => {
  const r = request('http://127.0.0.1:8080');
  const auth = (req) => req.set('Authorization', `Bearer ${TOKEN}`);
  return { get: (p) => auth(r.get(p)), post: (p) => auth(r.post(p)), delete: (p) => auth(r.delete(p)) };
};

describe('Caracterización REST escritura — vehículos + FCM', () => {
  beforeAll(async () => { await startServer(); const t = await getIdTokenWithUid(); TOKEN = t.token; UID = t.uid; });
  afterAll(stopServer);
  beforeEach(async () => {
    await clearFirestore();
  });

  describe('POST /vehicles', () => {
    test('sin userId → 400 "userId es requerido"', async () => {
      const res = await api().post('/vehicles').send({ type: 'CAR' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, message: 'userId es requerido' });
    });

    test('tipo inválido → 400 "Tipo de vehículo inválido"', async () => {
      const res = await api().post('/vehicles').send({ userId: UID, type: 'PLANE' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, message: 'Tipo de vehículo inválido' });
    });

    test('primer vehículo del usuario → creado y isPrimary=true', async () => {
      const res = await api().post('/vehicles').send({ userId: UID, type: 'CAR', name: 'Auto 1' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Vehículo creado');
      expect(res.body.vehicle).toMatchObject({
        userId: UID, type: 'CAR', name: 'Auto 1', isActive: true, isPrimary: true,
      });
      expect(res.body.vehicle.id).toBeTruthy();
    });

    test('segundo vehículo del usuario → isPrimary=false', async () => {
      await api().post('/vehicles').send({ userId: UID, type: 'CAR', name: 'Auto 1' });
      const res = await api().post('/vehicles').send({ userId: UID, type: 'MOTORCYCLE', name: 'Moto 1' });
      expect(res.status).toBe(200);
      expect(res.body.vehicle.isPrimary).toBe(false);
    });
  });

  describe('DELETE /vehicles/:userId/:vehicleId', () => {
    test('inexistente → 404', async () => {
      const res = await api().delete(`/vehicles/${UID}/no-existe`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ success: false, message: 'Vehículo no encontrado' });
    });

    // El path es el propio uid (pasa authz), pero el vehículo es de OTRO → el check interno del handler.
    test('de otro usuario → 403', async () => {
      await setDoc('vehicles', 'veh-1', { userId: 'OTHER', isActive: true, type: 'CAR' });
      const res = await api().delete(`/vehicles/${UID}/veh-1`);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ success: false, message: 'No tienes permisos para eliminar este vehículo' });
    });

    test('válido → soft-delete (deja de aparecer en GET /vehicles)', async () => {
      await setDoc('vehicles', 'veh-1', { userId: UID, isActive: true, type: 'CAR', name: 'Auto' });

      const del = await api().delete(`/vehicles/${UID}/veh-1`);
      expect(del.status).toBe(200);
      expect(del.body).toEqual({ success: true, message: 'Vehículo eliminado correctamente' });

      const list = await api().get(`/vehicles/${UID}`);
      expect(list.body).toEqual({ success: true, vehicles: [], count: 0 });
    });
  });

  describe('POST /vehicles/:userId/primary', () => {
    test('sin vehicleId → 400', async () => {
      const res = await api().post(`/vehicles/${UID}/primary`).send({});
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, message: 'vehicleId es requerido' });
    });

    test('cambia el primario (el anterior deja de serlo)', async () => {
      await setDoc('vehicles', 'veh-1', { userId: UID, isActive: true, isPrimary: true, type: 'CAR' });
      await setDoc('vehicles', 'veh-2', { userId: UID, isActive: true, isPrimary: false, type: 'MOTORCYCLE' });

      const res = await api().post(`/vehicles/${UID}/primary`).send({ vehicleId: 'veh-2' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, message: 'Vehículo primario actualizado' });

      const list = await api().get(`/vehicles/${UID}`);
      const byId = Object.fromEntries(list.body.vehicles.map((v) => [v.id, v.isPrimary]));
      expect(byId['veh-2']).toBe(true);
      expect(byId['veh-1']).toBe(false);
    });
  });

  describe('FCM', () => {
    test('GET /fcm/user-tokens/:userId — usuario inexistente → 404', async () => {
      const res = await api().get(`/fcm/user-tokens/${UID}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ success: false, message: 'Usuario no encontrado' });
    });

    test('POST /fcm/refresh-token sin newToken → 400', async () => {
      const res = await api().post('/fcm/refresh-token').send({ userId: UID });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, message: 'userId y newToken son requeridos' });
    });

    test('POST /fcm/refresh-token con usuario inexistente → 500 (throw dentro de transacción)', async () => {
      const res = await api().post('/fcm/refresh-token').send({ userId: UID, newToken: 'tok-1' });
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ success: false, message: 'Usuario no encontrado' });
    });

    test('POST /fcm/refresh-token agrega el token y GET lo refleja', async () => {
      await setDoc('users', UID, { uid: UID, username: 'Juan' });

      const refresh = await api().post('/fcm/refresh-token').send({ userId: UID, newToken: 'tok-1' });
      expect(refresh.status).toBe(200);
      expect(refresh.body).toMatchObject({ success: true, message: 'Token actualizado correctamente' });

      const tokens = await api().get(`/fcm/user-tokens/${UID}`);
      expect(tokens.status).toBe(200);
      expect(tokens.body.success).toBe(true);
      expect(tokens.body.tokens.fcmTokens).toContain('tok-1');
      expect(tokens.body.tokens.fcmToken).toBe('tok-1');
    });

    test('POST /fcm/cleanup-tokens sin array → 400', async () => {
      const res = await api().post('/fcm/cleanup-tokens').send({ userId: UID, invalidTokens: 'no-soy-array' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, message: 'userId y invalidTokens array son requeridos' });
    });
  });

  // Capa NUEVA de seguridad: un usuario autenticado no puede operar sobre datos de OTRO uid.
  describe('Autorización por-usuario (assertSelf)', () => {
    const OTHER = 'otro-usuario-uid';

    test('GET /vehicles/:userId de otro uid → 403 "No autorizado"', async () => {
      const res = await api().get(`/vehicles/${OTHER}`);
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/No autorizado/);
    });

    test('POST /vehicles con userId de otro uid → 403', async () => {
      const res = await api().post('/vehicles').send({ userId: OTHER, type: 'CAR', name: 'Ajeno' });
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/No autorizado/);
    });

    test('GET /fcm/user-tokens/:userId de otro uid → 403', async () => {
      const res = await api().get(`/fcm/user-tokens/${OTHER}`);
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/No autorizado/);
    });
  });
});
