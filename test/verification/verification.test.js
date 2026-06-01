/**
 * test/verification/verification.test.js
 * Tests del flujo de verificación (Fase 3): estado inicial, validación de campos,
 * cruces antifraude (duplicados, límite por titular), owner vs renter.
 */
const request = require('supertest');
const { clearFirestore, setDoc } = require('../setup/emulator');
const { startServer, stopServer } = require('../setup/server');
const { getIdToken } = require('../setup/auth');

const URL = 'http://127.0.0.1:8080';

const ownerBody = (o = {}) => ({
  accountType: 'owner',
  selfieUrl: 'https://x/s.jpg',
  deliveryAppScreenshotUrl: 'https://x/d.jpg',
  documentUrl: 'https://x/doc.jpg',
  fullName: 'Juan Perez',
  phone: '+54 11 1234-5678',
  documentNumber: '12.345.678',
  ...o,
});
const renterBody = (o = {}) => ({
  ...ownerBody({ accountType: 'renter' }),
  renterFaceUrl: 'https://x/rf.jpg',
  workPhonePhotoUrl: 'https://x/wp.jpg',
  titular: { name: 'Titi', document: '99888777', accountId: 'TIT-1' },
  ...o,
});

describe('Verificación (Fase 3)', () => {
  beforeAll(startServer);
  afterAll(stopServer);
  beforeEach(async () => { await clearFirestore(); });

  // Devuelve un cliente autenticado como un usuario nuevo (uid propio del token).
  async function authed() {
    const token = await getIdToken();
    return (method, path) => request(URL)[method](path).set('Authorization', `Bearer ${token}`);
  }

  test('GET /verification/me de un usuario nuevo → pending_verification', async () => {
    const api = await authed();
    const res = await api('get', '/verification/me');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('pending_verification');
  });

  test('POST /verification sin datos → 400 con lista de faltantes', async () => {
    const api = await authed();
    const res = await api('post', '/verification').send({ accountType: 'owner' });
    expect(res.status).toBe(400);
    expect(res.body.missing).toEqual(expect.arrayContaining(['selfieUrl', 'documentUrl', 'fullName']));
  });

  test('POST /verification owner completo → pending_review sin flags', async () => {
    const api = await authed();
    const res = await api('post', '/verification').send(ownerBody());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, state: 'pending_review', flags: [] });

    const me = await api('get', '/verification/me');
    expect(me.body).toMatchObject({ state: 'pending_review', accountType: 'owner' });
  });

  test('teléfono duplicado (otro usuario) → flag DUPLICATE_PHONE', async () => {
    const a = await authed();
    await a('post', '/verification').send(ownerBody({ phone: '1122334455' }));

    const b = await authed();
    const res = await b('post', '/verification').send(ownerBody({ phone: '11 2233-4455', documentNumber: '99' }));
    expect(res.body.flags.map((f) => f.code)).toContain('DUPLICATE_PHONE');
  });

  test('renter completo → pending_review', async () => {
    const api = await authed();
    const res = await api('post', '/verification').send(renterBody());
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('pending_review');
  });

  test('titular con 5 alquileres activos → flag TITULAR_OVER_LIMIT', async () => {
    for (let i = 0; i < 5; i++) {
      await setDoc('titular_assignments', `a${i}`, { renterUid: `R${i}`, titularAccountId: 'TIT-1', status: 'active', startedAt: 1 });
    }
    const api = await authed();
    const res = await api('post', '/verification').send(renterBody());
    expect(res.body.flags.map((f) => f.code)).toContain('TITULAR_OVER_LIMIT');
  });
});
