/**
 * test/characterization/vehicles-fcm.test.js
 * Caracterización de los endpoints REST que ESCRIBEN en Firestore: CRUD de vehículos
 * y gestión de tokens FCM. Congela el comportamiento actual (incluidas rarezas como que
 * "usuario no encontrado" devuelve 500 en cleanup/refresh por throw dentro de la transacción).
 */
const request = require('supertest');
const { clearFirestore, setDoc } = require('../setup/emulator');
const { startServer, stopServer } = require('../setup/server');

const api = () => request('http://127.0.0.1:8080');

describe('Caracterización REST escritura — vehículos + FCM', () => {
  beforeAll(startServer);
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
      const res = await api().post('/vehicles').send({ userId: 'U1', type: 'PLANE' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, message: 'Tipo de vehículo inválido' });
    });

    test('primer vehículo del usuario → creado y isPrimary=true', async () => {
      const res = await api().post('/vehicles').send({ userId: 'U1', type: 'CAR', name: 'Auto 1' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Vehículo creado');
      expect(res.body.vehicle).toMatchObject({
        userId: 'U1', type: 'CAR', name: 'Auto 1', isActive: true, isPrimary: true,
      });
      expect(res.body.vehicle.id).toBeTruthy();
    });

    test('segundo vehículo del usuario → isPrimary=false', async () => {
      await api().post('/vehicles').send({ userId: 'U1', type: 'CAR', name: 'Auto 1' });
      const res = await api().post('/vehicles').send({ userId: 'U1', type: 'MOTORCYCLE', name: 'Moto 1' });
      expect(res.status).toBe(200);
      expect(res.body.vehicle.isPrimary).toBe(false);
    });
  });

  describe('DELETE /vehicles/:userId/:vehicleId', () => {
    test('inexistente → 404', async () => {
      const res = await api().delete('/vehicles/U1/no-existe');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ success: false, message: 'Vehículo no encontrado' });
    });

    test('de otro usuario → 403', async () => {
      await setDoc('vehicles', 'veh-1', { userId: 'U1', isActive: true, type: 'CAR' });
      const res = await api().delete('/vehicles/OTRO/veh-1');
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ success: false, message: 'No tienes permisos para eliminar este vehículo' });
    });

    test('válido → soft-delete (deja de aparecer en GET /vehicles)', async () => {
      await setDoc('vehicles', 'veh-1', { userId: 'U1', isActive: true, type: 'CAR', name: 'Auto' });

      const del = await api().delete('/vehicles/U1/veh-1');
      expect(del.status).toBe(200);
      expect(del.body).toEqual({ success: true, message: 'Vehículo eliminado correctamente' });

      const list = await api().get('/vehicles/U1');
      expect(list.body).toEqual({ success: true, vehicles: [], count: 0 });
    });
  });

  describe('POST /vehicles/:userId/primary', () => {
    test('sin vehicleId → 400', async () => {
      const res = await api().post('/vehicles/U1/primary').send({});
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, message: 'vehicleId es requerido' });
    });

    test('cambia el primario (el anterior deja de serlo)', async () => {
      await setDoc('vehicles', 'veh-1', { userId: 'U1', isActive: true, isPrimary: true, type: 'CAR' });
      await setDoc('vehicles', 'veh-2', { userId: 'U1', isActive: true, isPrimary: false, type: 'MOTORCYCLE' });

      const res = await api().post('/vehicles/U1/primary').send({ vehicleId: 'veh-2' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, message: 'Vehículo primario actualizado' });

      const list = await api().get('/vehicles/U1');
      const byId = Object.fromEntries(list.body.vehicles.map((v) => [v.id, v.isPrimary]));
      expect(byId['veh-2']).toBe(true);
      expect(byId['veh-1']).toBe(false);
    });
  });

  describe('FCM', () => {
    test('GET /fcm/user-tokens/:userId — usuario inexistente → 404', async () => {
      const res = await api().get('/fcm/user-tokens/NOEXISTE');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ success: false, message: 'Usuario no encontrado' });
    });

    test('POST /fcm/refresh-token sin newToken → 400', async () => {
      const res = await api().post('/fcm/refresh-token').send({ userId: 'U1' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, message: 'userId y newToken son requeridos' });
    });

    test('POST /fcm/refresh-token con usuario inexistente → 500 (throw dentro de transacción)', async () => {
      const res = await api().post('/fcm/refresh-token').send({ userId: 'NOEXISTE', newToken: 'tok-1' });
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ success: false, message: 'Usuario no encontrado' });
    });

    test('POST /fcm/refresh-token agrega el token y GET lo refleja', async () => {
      await setDoc('users', 'U1', { uid: 'U1', username: 'Juan' });

      const refresh = await api().post('/fcm/refresh-token').send({ userId: 'U1', newToken: 'tok-1' });
      expect(refresh.status).toBe(200);
      expect(refresh.body).toMatchObject({ success: true, message: 'Token actualizado correctamente' });

      const tokens = await api().get('/fcm/user-tokens/U1');
      expect(tokens.status).toBe(200);
      expect(tokens.body.success).toBe(true);
      expect(tokens.body.tokens.fcmTokens).toContain('tok-1');
      expect(tokens.body.tokens.fcmToken).toBe('tok-1');
    });

    test('POST /fcm/cleanup-tokens sin array → 400', async () => {
      const res = await api().post('/fcm/cleanup-tokens').send({ userId: 'U1', invalidTokens: 'no-soy-array' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, message: 'userId y invalidTokens array son requeridos' });
    });
  });
});
