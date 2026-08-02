/**
 * test/characterization/restart.test.js
 * Persistencia de emergencias (PLAN_MEJORAS E): si el server se reinicia DURANTE una
 * emergencia (deploy, crash), la emergencia NO desaparece — se rehidrata desde Firestore
 * (alerts + helpers + sala) y la víctima puede resolverla después del restart.
 */
const { io } = require('socket.io-client');
const { startServer, stopServer, PORT } = require('../setup/server');
const { getIdTokenForUid } = require('../setup/auth');
const { getDoc } = require('../setup/emulator');

const URL = `http://127.0.0.1:${PORT}`;
const LOC = { latitude: -34.6037, longitude: -58.3816 };

async function connect(uid) {
  const token = await getIdTokenForUid(uid);
  return new Promise((resolve, reject) => {
    const socket = io(URL, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { token } });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

describe('Emergencias sobreviven a un restart del server (Fase E)', () => {
  let sockets = [];

  beforeAll(async () => { await startServer(); }, 30000);
  afterAll(stopServer);
  afterEach(() => { sockets.forEach((s) => { try { s.close(); } catch { /* ya muerto */ } }); sockets = []; });

  async function newSocket(uid) {
    const s = await connect(uid);
    sockets.push(s);
    return s;
  }

  test('emergencia activa + helper → restart → sigue activa con helper y se puede resolver', async () => {
    // 1) Víctima dispara la emergencia
    const victim = await newSocket('VICTIMA_R');
    await victim.emitWithAck('user-connected', { id: 'VICTIMA_R', username: 'Victima' });
    const alert = await victim.emitWithAck('emergency_alert', {
      userId: 'VICTIMA_R', userName: 'Victima', ...LOC,
    });
    expect(alert.success).toBe(true);

    // 2) Un ayudante confirma (queda espejado en Firestore)
    const helper = await newSocket('HELPER_R');
    const confirm = await helper.emitWithAck('help_confirm', {
      emergencyUserId: 'VICTIMA_R', helperId: 'HELPER_R', helperName: 'Ayudante', ...LOC,
    });
    expect(confirm.success).toBe(true);
    // (el espejo de helpers es fire-and-forget: darle un instante antes del kill)
    await new Promise((r) => setTimeout(r, 800));

    // 2.5) Sanity: el espejo en Firestore existe y está activo ANTES del restart
    const mirror = await getDoc('emergencies', 'VICTIMA_R');
    expect(mirror).toBeTruthy();
    expect(mirror.isActive).toBe(true);
    expect(mirror.helpers).toContain('HELPER_R');

    // 3) RESTART: parar el server CON los sockets aún conectados (como un deploy real:
    //    el disconnect masivo del shutdown NO debe limpiar la emergencia) y relevantarlo
    //    SIN limpiar Firestore (clearData:false — el default limpiaría el espejo).
    await stopServer();
    sockets.forEach((s) => { try { s.close(); } catch { /* ya murió con el server */ } });
    sockets = [];
    await startServer({}, { clearData: false });

    // 4) La emergencia sigue activa (rehidratada)
    const token = await getIdTokenForUid('OBSERVADOR_R');
    const res = await fetch(`${URL}/emergencies/active`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const active = await res.json();
    const mine = (active.emergencies || []).find((e) => e.userId === 'VICTIMA_R');
    expect(mine).toBeDefined();
    expect(mine.status).toBe('active');
    expect(mine.helpersCount).toBe(1);

    // 5) Los helpers también se rehidrataron
    const helpersRes = await fetch(`${URL}/emergencies/VICTIMA_R/helpers`, { headers: { Authorization: `Bearer ${token}` } });
    expect(helpersRes.status).toBe(200);
    const helpersBody = await helpersRes.json();
    expect(JSON.stringify(helpersBody)).toContain('HELPER_R');

    // 6) La víctima reconecta y RESUELVE la emergencia rehidratada
    const victim2 = await newSocket('VICTIMA_R');
    const resolve = await victim2.emitWithAck('emergency_resolve', { userId: 'VICTIMA_R' });
    expect(resolve.success).toBe(true);

    // 7) Y una emergencia nueva puede arrancar (el lock quedó liberado)
    const otra = await newSocket('OTRA_VICTIMA_R');
    await otra.emitWithAck('user-connected', { id: 'OTRA_VICTIMA_R', username: 'Otra' });
    const alert2 = await otra.emitWithAck('emergency_alert', {
      userId: 'OTRA_VICTIMA_R', userName: 'Otra', ...LOC,
    });
    expect(alert2.success).toBe(true);
    await otra.emitWithAck('emergency_resolve', { userId: 'OTRA_VICTIMA_R' });
  }, 60000);
});
