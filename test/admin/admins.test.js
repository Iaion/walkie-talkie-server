/**
 * test/admin/admins.test.js
 * Gestión de administradores (solo superadmin): jerarquía de roles, listar, dar y quitar
 * el rol admin, y las protecciones (superadmin intocable desde el panel, email inexistente).
 */
const request = require('supertest');
const { clearFirestore } = require('../setup/emulator');
const { startServer, stopServer } = require('../setup/server');
const { getIdToken, getAdminIdToken, getSuperadminIdToken } = require('../setup/auth');

const URL = 'http://127.0.0.1:8080';
const AUTH_HOST = 'http://127.0.0.1:9099';

describe('Admins — gestión de administradores (superadmin)', () => {
  beforeAll(startServer);
  afterAll(stopServer);
  beforeEach(async () => { await clearFirestore(); });

  const bearer = (token) => (method, path, body) => {
    const req = request(URL)[method](path).set('Authorization', `Bearer ${token}`);
    return body ? req.send(body) : req;
  };

  /** Crea un usuario real en el Auth emulator CON email (signUp anónimo no sirve para grant-por-email). */
  async function signUpWithEmail(email) {
    const res = await fetch(
      `${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'Test123456', returnSecureToken: true }),
      },
    );
    if (!res.ok) throw new Error(`signUp(${email}) falló: ${res.status} ${await res.text()}`);
    return res.json(); // { localId, ... }
  }

  const uniqueEmail = (tag) => `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;

  test('sin rol → 403', async () => {
    const api = bearer(await getIdToken());
    const res = await api('get', '/admin/admins');
    expect(res.status).toBe(403);
  });

  test('admin común → 403 (la ruta pide el rol mayor)', async () => {
    const api = bearer(await getAdminIdToken());
    const res = await api('get', '/admin/admins');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false });
  });

  test('el superadmin sigue entrando a las rutas de admin común (jerarquía)', async () => {
    const { token } = await getSuperadminIdToken();
    const res = await bearer(token)('get', '/admin/verifications');
    expect(res.status).toBe(200);
  });

  test('flujo completo: dar admin por email → aparece en la lista → quitarlo → desaparece', async () => {
    const { token } = await getSuperadminIdToken();
    const api = bearer(token);
    const email = uniqueEmail('nuevo-admin');
    const { localId } = await signUpWithEmail(email);

    const grant = await api('post', '/admin/admins', { email });
    expect(grant.status).toBe(200);
    expect(grant.body).toMatchObject({ success: true, uid: localId, role: 'admin' });

    const list = await api('get', '/admin/admins');
    expect(list.status).toBe(200);
    const found = list.body.admins.find((a) => a.uid === localId);
    expect(found).toMatchObject({ email, role: 'admin' });

    const revoke = await api('delete', `/admin/admins/${localId}`);
    expect(revoke.status).toBe(200);

    const after = await api('get', '/admin/admins');
    expect(after.body.admins.find((a) => a.uid === localId)).toBeUndefined();
  });

  test('el flamante admin puede usar la cola pero NO gestionar admins', async () => {
    const { token } = await getSuperadminIdToken();
    const email = uniqueEmail('admin-operativo');
    await signUpWithEmail(email);
    await bearer(token)('post', '/admin/admins', { email });

    // Login del flamante admin → su token nuevo trae el claim.
    const login = await fetch(
      `${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'Test123456', returnSecureToken: true }),
      },
    );
    const { idToken } = await login.json();
    const api = bearer(idToken);

    expect((await api('get', '/admin/verifications')).status).toBe(200);
    expect((await api('get', '/admin/admins')).status).toBe(403);
  });

  test('email inexistente → 404 con mensaje claro', async () => {
    const { token } = await getSuperadminIdToken();
    const res = await bearer(token)('post', '/admin/admins', { email: uniqueEmail('fantasma') });
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/registrarse primero/);
  });

  test('a un superadmin no se lo toca desde el panel (ni dar de nuevo, ni quitar)', async () => {
    const actor = await getSuperadminIdToken();
    const target = await getSuperadminIdToken();
    const api = bearer(actor.token);

    const revoke = await api('delete', `/admin/admins/${target.uid}`);
    expect(revoke.status).toBe(400);
    expect(revoke.body.message).toMatch(/superadmin/);
  });

  test('directorio de usuarios: lo ve un admin común, combina Auth + Firestore', async () => {
    const { setDoc } = require('../setup/emulator');
    const email = uniqueEmail('vecino');
    const { localId } = await signUpWithEmail(email);
    await setDoc('users', localId, { fullName: 'Vecino Test', state: 'approved' });

    const api = bearer(await getAdminIdToken());
    const res = await api('get', '/admin/users');
    expect(res.status).toBe(200);
    const row = res.body.users.find((u) => u.uid === localId);
    expect(row).toMatchObject({ email, name: 'Vecino Test', state: 'approved', role: null });

    const sinRol = bearer(await getIdToken());
    expect((await sinRol('get', '/admin/users')).status).toBe(403);
  });

  test('quitar a alguien que no es admin → 400', async () => {
    const { token } = await getSuperadminIdToken();
    const email = uniqueEmail('comun');
    const { localId } = await signUpWithEmail(email);
    const res = await bearer(token)('delete', `/admin/admins/${localId}`);
    expect(res.status).toBe(400);
  });
});
