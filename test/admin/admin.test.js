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

  test('admin obtiene URLs de las fotos (http pasa directo, path se firma/cae al path)', async () => {
    await setDoc('users', 'U1', { uid: 'U1', state: 'pending_review', role: 'delivery', accountType: 'owner' });
    await setDoc('verifications', 'U1', {
      uid: 'U1', accountType: 'owner', status: 'pending_review', submittedAt: 1,
      selfieUrl: 'https://cdn.example.com/selfie.jpg', // ya es URL → pasa directo
      documentUrl: 'verifications/U1/document_123.png', // path privado → firmar o caer al path
    });
    const api = bearer(await getAdminIdToken());
    const res = await api('get', '/admin/verifications/U1/photos');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.photos.selfieUrl).toBe('https://cdn.example.com/selfie.jpg');
    expect(typeof res.body.photos.documentUrl).toBe('string');
    expect(res.body.photos.documentUrl.length).toBeGreaterThan(0);
  });

  test('fotos de una verificación inexistente → 404', async () => {
    const api = bearer(await getAdminIdToken());
    const res = await api('get', '/admin/verifications/NOEXISTE/photos');
    expect(res.status).toBe(404);
  });

  test('grandfathering: preview no escribe; apply marca a los legacy (sin state) como approved', async () => {
    await setDoc('users', 'LEGACY1', { uid: 'LEGACY1', username: 'Viejo1' });
    await setDoc('users', 'LEGACY2', { uid: 'LEGACY2', username: 'Viejo2' });
    await setDoc('users', 'NUEVO', { uid: 'NUEVO', state: 'pending_review' });
    const api = bearer(await getAdminIdToken());

    // Preview: cuenta los 2 legacy y NO escribe
    const prev = await api('get', '/admin/grandfather/preview');
    expect(prev.status).toBe(200);
    expect(prev.body).toMatchObject({ applied: false, count: 2 });
    expect((await getDoc('users', 'LEGACY1')).state).toBeUndefined();

    // Apply: los legacy quedan approved+grandfathered; el que ya tenía state no se toca
    const res = await api('post', '/admin/grandfather');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: true, count: 2 });
    const l1 = await getDoc('users', 'LEGACY1');
    expect(l1.state).toBe('approved');
    expect(l1.grandfathered).toBe(true);
    expect((await getDoc('users', 'NUEVO')).state).toBe('pending_review');
  });
});
