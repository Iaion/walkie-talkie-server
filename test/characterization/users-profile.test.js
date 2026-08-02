/**
 * test/characterization/users-profile.test.js
 * GET/PUT /users/:uid/profile (PLAN_MEJORAS C2): el reemplazo server-mediated de las
 * escrituras directas a users/{uid} del prototipo Android. Cubre: auth, autorización
 * por-usuario, upsert con merge, alias legacy, y la WHITELIST (el cliente no puede
 * escalar roles/estado de verificación).
 */
const { clearFirestore, getDoc } = require('../setup/emulator');
const { startServer, stopServer, PORT } = require('../setup/server');
const { getIdTokenWithUid } = require('../setup/auth');

const BASE = `http://127.0.0.1:${PORT}`;

async function api(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('Perfil de usuario vía API (/users/:uid/profile)', () => {
  let me; // { token, uid }

  beforeAll(async () => {
    await startServer();
  }, 30000);
  afterAll(stopServer);
  beforeEach(async () => {
    await clearFirestore();
    me = await getIdTokenWithUid();
  });

  test('sin token → 401', async () => {
    const r = await api('GET', '/users/algunUid/profile');
    expect(r.status).toBe(401);
  });

  test('uid ajeno → 403 (PUT y GET)', async () => {
    const otro = await getIdTokenWithUid();
    const put = await api('PUT', `/users/${otro.uid}/profile`, me.token, { username: 'hacker' });
    expect(put.status).toBe(403);
    const get = await api('GET', `/users/${otro.uid}/profile`, me.token);
    expect(get.status).toBe(403);
  });

  test('GET de perfil inexistente → 404', async () => {
    const r = await api('GET', `/users/${me.uid}/profile`, me.token);
    expect(r.status).toBe(404);
  });

  test('PUT crea el perfil (con alias legacy) y GET lo devuelve', async () => {
    const put = await api('PUT', `/users/${me.uid}/profile`, me.token, {
      fullName: 'Pedro Test', username: 'pedro', phone: '1122334455', avatarUri: 'https://x/a.png',
    });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ success: true });

    const get = await api('GET', `/users/${me.uid}/profile`, me.token);
    expect(get.status).toBe(200);
    const p = get.body.profile;
    expect(p.fullName).toBe('Pedro Test');
    expect(p.username).toBe('pedro');
    // Alias legacy derivados por el server:
    expect(p.cel).toBe('1122334455');
    expect(p.telefono).toBe('1122334455');
    expect(p.phoneNumber).toBe('1122334455');
    expect(p.avatarUrl).toBe('https://x/a.png');
    expect(p.photoURL).toBe('https://x/a.png');
    expect(typeof p.createdAt).toBe('number');
    expect(typeof p.lastUpdated).toBe('number');
  });

  test('PUT parcial hace merge (no pisa lo que no se manda)', async () => {
    await api('PUT', `/users/${me.uid}/profile`, me.token, { fullName: 'Pedro Test', username: 'pedro' });
    await api('PUT', `/users/${me.uid}/profile`, me.token, { phone: '999' });
    const get = await api('GET', `/users/${me.uid}/profile`, me.token);
    expect(get.body.profile.fullName).toBe('Pedro Test');
    expect(get.body.profile.phone).toBe('999');
  });

  test('POST avatar: sube data URL → URL pública y la guarda en el perfil', async () => {
    // PNG 1x1 transparente
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const r = await api('POST', `/users/${me.uid}/avatar`, me.token, { imageData: png });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(typeof r.body.url).toBe('string');
    const doc = await getDoc('users', me.uid);
    expect(doc.avatarUri).toBe(r.body.url);
    expect(doc.photoURL).toBe(r.body.url);
  });

  test('POST avatar: sin data URL válida → 400', async () => {
    const r = await api('POST', `/users/${me.uid}/avatar`, me.token, { imageData: 'no-es-data-url' });
    expect(r.status).toBe(400);
  });

  test('WHITELIST: el cliente NO puede escribir roles/isVerified/state/isOnline/fcmToken', async () => {
    await api('PUT', `/users/${me.uid}/profile`, me.token, {
      username: 'pedro',
      roles: ['admin'], isVerified: true, state: 'approved', isOnline: true, fcmToken: 'tok', hasFcmTokens: true,
    });
    const doc = await getDoc('users', me.uid);
    expect(doc.roles).toBeUndefined();
    expect(doc.isVerified).toBeUndefined();
    expect(doc.state).toBeUndefined();
    expect(doc.isOnline).toBeUndefined();
    expect(doc.fcmToken).toBeUndefined();
    expect(doc.hasFcmTokens).toBeUndefined();
    expect(doc.username).toBe('pedro');
  });
});
