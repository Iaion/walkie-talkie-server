/**
 * test/admin/admin.test.js
 * Review del admin (Fase 3): guard de rol, cola, aprobar/rechazar, activación de assignment.
 */
const request = require('supertest');
const { clearFirestore, setDoc, getDoc } = require('../setup/emulator');
const { startServer, stopServer } = require('../setup/server');
const { getIdToken, getAdminIdToken } = require('../setup/auth');

const URL = 'http://127.0.0.1:8080';

describe('Admin — review de verificaciones (Fase 3)', () => {
  beforeAll(startServer);
  afterAll(stopServer);
  beforeEach(async () => { await clearFirestore(); });

  const bearer = (token) => (method, path) => request(URL)[method](path).set('Authorization', `Bearer ${token}`);

  async function seedPending(uid = 'U1', accountType = 'owner') {
    await setDoc('users', uid, { uid, state: 'pending_review', role: 'delivery', accountType });
    await setDoc('verifications', uid, { uid, accountType, status: 'pending_review', flags: [], submittedAt: 1 });
  }

  test('sin rol admin → 403', async () => {
    const api = bearer(await getIdToken());
    const res = await api('get', '/admin/verifications');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false });
  });

  test('admin lista la cola pending_review', async () => {
    await seedPending('U1');
    const api = bearer(await getAdminIdToken());
    const res = await api('get', '/admin/verifications');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.verifications.map((v) => v.uid)).toContain('U1');
  });

  test('admin aprueba → usuario approved', async () => {
    await seedPending('U1');
    const api = bearer(await getAdminIdToken());
    const res = await api('post', '/admin/verifications/U1/approve');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, state: 'approved' });
    const user = await getDoc('users', 'U1');
    expect(user.state).toBe('approved');
  });

  test('admin rechaza sin motivo → 400', async () => {
    await seedPending('U1');
    const api = bearer(await getAdminIdToken());
    const res = await api('post', '/admin/verifications/U1/reject').send({});
    expect(res.status).toBe(400);
  });

  test('admin rechaza con motivo → usuario rejected + motivo guardado', async () => {
    await seedPending('U1');
    const api = bearer(await getAdminIdToken());
    const res = await api('post', '/admin/verifications/U1/reject').send({ reason: 'Documento ilegible' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, state: 'rejected', reason: 'Documento ilegible' });
    const user = await getDoc('users', 'U1');
    expect(user.state).toBe('rejected');
    expect(user.rejectionReason).toBe('Documento ilegible');
  });

  test('aprobar un renter activa su titular_assignment (pending → active)', async () => {
    await setDoc('users', 'R1', { uid: 'R1', state: 'pending_review', role: 'delivery', accountType: 'renter' });
    await setDoc('verifications', 'R1', { uid: 'R1', accountType: 'renter', status: 'pending_review', flags: [], submittedAt: 1 });
    await setDoc('titular_assignments', 'asg1', { renterUid: 'R1', titularAccountId: 'T1', status: 'pending', startedAt: 1 });

    const api = bearer(await getAdminIdToken());
    await api('post', '/admin/verifications/R1/approve');

    const asg = await getDoc('titular_assignments', 'asg1');
    expect(asg.status).toBe('active');
  });

  test('aprobar una verificación inexistente → 404', async () => {
    const api = bearer(await getAdminIdToken());
    const res = await api('post', '/admin/verifications/NOEXISTE/approve');
    expect(res.status).toBe(404);
  });
});
