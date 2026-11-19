/**
 * test/characterization/sos-limits.test.js
 * Límites de las emergencias que necesitan su propio server (env propio):
 *  - vencimiento por inactividad de la víctima (SOS abandonado: teléfono roto o sin batería),
 *  - tope de emergencias nuevas por usuario por minuto (abuso o cliente con bug),
 *  - reinicio del server con VARIAS emergencias activas.
 * También el registro de crashes de la app.
 */
const { io } = require('socket.io-client');
const { setDoc, listDocs } = require('../setup/emulator');
const { startServer, stopServer, PORT } = require('../setup/server');
const { getIdTokenForUid } = require('../setup/auth');

const URL = `http://127.0.0.1:${PORT}`;
const COORDS = { latitude: -38.0234, longitude: -57.5631 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(uid) {
  const token = await getIdTokenForUid(uid);
  const s = await new Promise((resolve, reject) => {
    const socket = io(URL, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { token } });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
  await s.emitWithAck('user-connected', { id: uid, username: uid, multiRoom: true });
  return s;
}
function waitFor(socket, event, predicate = () => true, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const onEvent = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(payload);
    };
    const timer = setTimeout(() => { socket.off(event, onEvent); reject(new Error(`timeout esperando "${event}"`)); }, timeoutMs);
    socket.on(event, onEvent);
  });
}

describe('Límites de las emergencias', () => {
  let sockets = [];
  const open = async (uid) => { const s = await connect(uid); sockets.push(s); return s; };
  afterEach(() => { sockets.forEach((s) => { try { s.close(); } catch { /* ya cerrado */ } }); sockets = []; });

  describe('vencimiento y tope por usuario', () => {
    beforeAll(async () => {
      await startServer({ EMERGENCY_IDLE_TTL_MS: '1500', EMERGENCY_SWEEP_MS: '250', EMERGENCY_MAX_PER_MINUTE: '2' });
    }, 45000);
    afterAll(stopServer);

    test('un SOS sin señales de la víctima vence solo y queda en el historial como vencido', async () => {
      await setDoc('users', 'VENCE_O', { state: 'approved' });
      const victima = await open('VENCE_V');
      const observador = await open('VENCE_O');
      const vencida = waitFor(observador, 'emergency_cancelled', (d) => d.userId === 'VENCE_V');
      const ack = await victima.emitWithAck('emergency_alert', { userId: 'VENCE_V', userName: 'V', ...COORDS, requestId: 'v1' });
      expect(ack.success).toBe(true);
      victima.close(); // teléfono apagado: no hay más actividad

      expect(await vencida).toMatchObject({ reason: 'expired', emergencyId: ack.emergencyId });
      const snap = await observador.timeout(4000).emitWithAck('sync_emergencies', {});
      expect(snap.emergencies).toEqual([]);
      expect(snap.recent).toEqual([expect.objectContaining({ userId: 'VENCE_V', endReason: 'expired' })]);
    }, 20000);

    test('la actividad de la víctima posterga el vencimiento', async () => {
      const victima = await open('VIVA_V');
      await victima.emitWithAck('emergency_alert', { userId: 'VIVA_V', userName: 'V', ...COORDS, requestId: 'a1' });
      for (let i = 0; i < 6; i++) {
        await sleep(500);
        const loc = await victima.emitWithAck('update_emergency_location', {
          roomId: 'emergencia_VIVA_V', userId: 'VIVA_V', lat: COORDS.latitude, lng: COORDS.longitude,
        });
        expect(loc.success).toBe(true);
      }
      // Pasaron 3 s (el doble del TTL) y sigue activa.
      const snap = await victima.timeout(4000).emitWithAck('sync_emergencies', {});
      expect(snap.emergencies).toEqual([expect.objectContaining({ userId: 'VIVA_V', status: 'active' })]);
      expect((await victima.emitWithAck('emergency_resolve', { userId: 'VIVA_V' })).success).toBe(true);
    }, 20000);

    test('tope por usuario: el 3er SOS nuevo en un minuto responde RATE_LIMITED y queda auditado', async () => {
      const s = await open('TOPE_U');
      const sos = (requestId) => s.emitWithAck('emergency_alert', { userId: 'TOPE_U', userName: 'U', ...COORDS, requestId });
      expect(await sos('t1')).toMatchObject({ success: true, replaced: false });
      expect(await sos('t1')).toMatchObject({ success: true, recovered: true }); // un reintento no cuenta
      expect(await sos('t2')).toMatchObject({ success: true, replaced: true });
      expect(await sos('t3')).toMatchObject({ success: false, code: 'RATE_LIMITED' });
      // Otro usuario no se ve afectado.
      const otro = await open('TOPE_OTRO');
      expect(await otro.emitWithAck('emergency_alert', { userId: 'TOPE_OTRO', userName: 'O', ...COORDS, requestId: 'o1' })).toMatchObject({ success: true });
      await sleep(400);
      const rechazos = (await listDocs('audit_logs')).filter((l) => l.action === 'emergency_alert_rejected' && l.actorUid === 'TOPE_U');
      expect(rechazos.map((l) => l.details.code)).toEqual(['RATE_LIMITED']);
    }, 20000);
  });

  describe('reinicio con varias emergencias', () => {
    beforeAll(async () => { await startServer(); }, 45000);
    afterAll(stopServer);

    test('3 emergencias activas con ayudantes y un "No puedo" sobreviven al reinicio', async () => {
      for (const uid of ['RS_H', 'RS_N', 'RS_O']) await setDoc('users', uid, { state: 'approved', username: uid });
      const ids = {};
      for (const uid of ['RS_V1', 'RS_V2', 'RS_V3']) {
        const v = await open(uid);
        const ack = await v.emitWithAck('emergency_alert', { userId: uid, userName: uid, ...COORDS, requestId: `r-${uid}` });
        expect(ack.success).toBe(true);
        ids[uid] = ack.emergencyId;
      }
      const h = await open('RS_H');
      const n = await open('RS_N');
      expect((await h.emitWithAck('help_confirm', { emergencyUserId: 'RS_V1', helperId: 'RS_H', helperName: 'Hache' })).success).toBe(true);
      expect((await h.emitWithAck('help_confirm', { emergencyUserId: 'RS_V2', helperId: 'RS_H', helperName: 'Hache' })).success).toBe(true);
      expect((await n.emitWithAck('help_reject', { emergencyUserId: 'RS_V1', helperId: 'RS_N' })).success).toBe(true);
      await sleep(900); // los espejos en Firestore son fire-and-forget

      await stopServer();
      sockets.forEach((s) => { try { s.close(); } catch { /* murió con el server */ } });
      sockets = [];
      await startServer({}, { clearData: false });

      const h2 = await open('RS_H');
      const snap = await h2.timeout(4000).emitWithAck('sync_emergencies', {});
      expect(snap.emergencies.map((e) => e.userId).sort()).toEqual(['RS_V1', 'RS_V2', 'RS_V3']);
      const byUser = Object.fromEntries(snap.emergencies.map((e) => [e.userId, e]));
      expect(byUser.RS_V1).toMatchObject({ emergencyId: ids.RS_V1, helpingByMe: true, helpersInfo: [{ id: 'RS_H', name: 'Hache' }] });
      expect(byUser.RS_V2.helpingByMe).toBe(true);
      expect(byUser.RS_V3.helpersCount).toBe(0);

      const n2 = await open('RS_N');
      const snapN = await n2.timeout(4000).emitWithAck('sync_emergencies', {});
      expect(snapN.emergencies.find((e) => e.userId === 'RS_V1').declinedByMe).toBe(true);

      // El mismo toque reintentado tras el reinicio recupera, no duplica.
      const v1 = await open('RS_V1');
      expect(await v1.emitWithAck('emergency_alert', { userId: 'RS_V1', userName: 'RS_V1', ...COORDS, requestId: 'r-RS_V1' }))
        .toMatchObject({ success: true, recovered: true, emergencyId: ids.RS_V1 });

      for (const uid of ['RS_V1', 'RS_V2', 'RS_V3']) {
        const v = uid === 'RS_V1' ? v1 : await open(uid);
        expect((await v.emitWithAck('emergency_resolve', { userId: uid })).wasActive).toBe(true);
      }
    }, 90000);

    test('POST /diagnostics/crash guarda el reporte del cierre inesperado de la app', async () => {
      const token = await getIdTokenForUid('CRASH_U');
      const send = (body) => fetch(`${URL}/diagnostics/crash`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(await (await send({})).json()).toMatchObject({ success: false });

      const res = await send({
        appVersion: '1.0-beta5', versionCode: 6, deviceModel: 'moto g54', androidVersion: '14', thread: 'main',
        stackTrace: 'java.lang.IllegalStateException: boom\n\tat com.example.a2intento.X.y(X.kt:10)', occurredAt: 1795038125000,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      const crashes = await listDocs('client_crashes');
      expect(crashes).toEqual([expect.objectContaining({ uid: 'CRASH_U', appVersion: '1.0-beta5', versionCode: 6, deviceModel: 'moto g54' })]);
    });

    test('sin token no se acepta un reporte de crash', async () => {
      const res = await fetch(`${URL}/diagnostics/crash`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(401);
    });
  });
});
