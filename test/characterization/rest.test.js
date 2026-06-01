/**
 * test/characterization/rest.test.js
 * Tests de CARACTERIZACIÓN de los endpoints REST: capturan el comportamiento ACTUAL
 * del monolito como "verdad", para detectar regresiones durante el estrangulamiento (Fase 2).
 * No juzgan si el comportamiento es lindo — lo congelan tal como es hoy.
 */
const request = require('supertest');
const { clearFirestore, setDoc } = require('../setup/emulator');
const { startServer, stopServer } = require('../setup/server');

const api = () => request('http://127.0.0.1:8080');

describe('Caracterización REST — monolito actual', () => {
  beforeAll(startServer);
  afterAll(stopServer);

  beforeEach(async () => {
    await clearFirestore();
  });

  test('GET /health → 200 y "Servidor operativo"', async () => {
    const res = await api().get('/health');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Servidor operativo');
  });

  test('GET /users → [] cuando no hay usuarios conectados (lee estado en memoria)', async () => {
    const res = await api().get('/users');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('GET /emergencies/active → {success:true, emergencies:[], total:0}', async () => {
    const res = await api().get('/emergencies/active');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, emergencies: [], total: 0 });
  });

  test('GET /emergencies/:userId/helpers → {success:true, helpers:[], count:0}', async () => {
    const res = await api().get('/emergencies/U1/helpers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, helpers: [], count: 0 });
  });

  describe('GET /vehicles/:userId (lee de Firestore vía emulador)', () => {
    test('sin vehículos → {success:true, vehicles:[], count:0}', async () => {
      const res = await api().get('/vehicles/NOEXISTE');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, vehicles: [], count: 0 });
    });

    test('devuelve solo los vehículos activos del usuario, mapeados', async () => {
      await setDoc('vehicles', 'veh-activo', {
        userId: 'U1', isActive: true, isPrimary: true, type: 'CAR', name: 'Auto Test', brand: 'Toyota',
      });
      await setDoc('vehicles', 'veh-inactivo', {
        userId: 'U1', isActive: false, type: 'CAR', name: 'Viejo',
      });
      await setDoc('vehicles', 'veh-otro-user', {
        userId: 'U2', isActive: true, type: 'MOTORCYCLE', name: 'De otro',
      });

      const res = await api().get('/vehicles/U1');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.count).toBe(1);
      expect(res.body.vehicles[0]).toMatchObject({
        id: 'veh-activo',
        userId: 'U1',
        name: 'Auto Test',
        brand: 'Toyota',
        type: 'CAR',
        isActive: true,
        isPrimary: true,
      });
    });
  });
});
