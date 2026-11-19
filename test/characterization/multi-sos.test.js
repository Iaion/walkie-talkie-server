/**
 * test/characterization/multi-sos.test.js
 * Varias emergencias a la vez (se eliminó el lock global, 18-nov-2026) y todo lo que eso
 * arrastra: concurrencia por usuario, reemplazo del propio SOS, ayudantes en varias salas,
 * "No puedo" reversible, historial de la última hora, avisos dirigidos y reconexión.
 * Caja negra con clientes reales, igual que socket.test.js.
 */
const { io } = require('socket.io-client');
const { clearFirestore, setDoc, listDocs } = require('../setup/emulator');
const { startServer, stopServer } = require('../setup/server');
const { getIdTokenForUid } = require('../setup/auth');

const URL = 'http://127.0.0.1:8080';
const COORDS = { latitude: -38.0234, longitude: -57.5631 }; // Mar del Plata

const tokenCache = {};
async function tokenFor(uid) {
  if (!tokenCache[uid]) tokenCache[uid] = await getIdTokenForUid(uid);
  return tokenCache[uid];
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Espera un evento que cumpla el predicado (los eventos previos que no lo cumplen se ignoran). */
function waitFor(socket, event, predicate = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const onEvent = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`timeout esperando "${event}"`));
    }, timeoutMs);
    socket.on(event, onEvent);
  });
}
async function until(fn, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('la condición no se cumplió a tiempo');
    await sleep(50);
  }
}

describe('Varias emergencias a la vez', () => {
  let sockets = [];

  beforeAll(async () => { await startServer(); });
  afterAll(stopServer);
  beforeEach(async () => { await clearFirestore(); });
  afterEach(async () => {
    const uids = [...new Set(sockets.filter((s) => s.connected).map((s) => s.testUid))];
    for (const uid of uids) {
      const s = sockets.find((x) => x.connected && x.testUid === uid);
      await s.timeout(5000).emitWithAck('emergency_resolve', { userId: uid });
    }
    sockets.forEach((s) => s.close());
    sockets = [];
  });

  /** Usuario aprobado, conectado e identificado como la app nueva (multiRoom). */
  async function user(uid, { approved = true, multiRoom = true, create = true } = {}) {
    if (approved && create) await setDoc('users', uid, { state: 'approved', username: uid });
    const token = await tokenFor(uid);
    const s = await new Promise((resolve, reject) => {
      const socket = io(URL, { transports: ['websocket'], forceNew: true, auth: { token } });
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });
    s.testUid = uid;
    sockets.push(s);
    const ack = await s.emitWithAck('user-connected', { id: uid, username: uid, multiRoom });
    expect(ack.success).toBe(true);
    return s;
  }
  const sos = (s, extra = {}) => s.emitWithAck('emergency_alert', { userId: s.testUid, userName: s.testUid, ...COORDS, ...extra });
  const sync = (s) => s.timeout(4000).emitWithAck('sync_emergencies', {});

  test('dos usuarios piden a la vez: las dos quedan activas y cada uno recibe la del otro', async () => {
    const a = await user('M_A');
    const b = await user('M_B');
    const aRecibe = waitFor(a, 'emergency_alert', (d) => d.userId === 'M_B');
    const bRecibe = waitFor(b, 'emergency_alert', (d) => d.userId === 'M_A');

    const [ra, rb] = await Promise.all([sos(a), sos(b)]);
    expect(ra).toMatchObject({ success: true, emergencyRoomId: 'emergencia_M_A' });
    expect(rb).toMatchObject({ success: true, emergencyRoomId: 'emergencia_M_B' });
    expect((await aRecibe).emergencyId).toBe(rb.emergencyId);
    expect((await bRecibe).emergencyId).toBe(ra.emergencyId);

    const snap = await sync(a);
    expect(snap.emergencies.map((e) => e.userId).sort()).toEqual(['M_A', 'M_B']);
  });

  test('10 SOS en el mismo instante: todos aceptados, todos visibles y cada usuario recibe los otros 9', async () => {
    const N = 10;
    const users = [];
    for (let i = 0; i < N; i++) users.push(await user(`DIEZ_${i}`));
    const received = users.map(() => new Set());
    users.forEach((s, i) => s.on('emergency_alert', (d) => received[i].add(d.userId)));

    const acks = await Promise.all(users.map((s) => sos(s)));
    acks.forEach((ack) => expect(ack).toMatchObject({ success: true, replaced: false }));
    expect(new Set(acks.map((a) => a.emergencyId)).size).toBe(N);

    await until(() => received.every((set) => set.size === N - 1));
    received.forEach((set, i) => expect(set.has(`DIEZ_${i}`)).toBe(false)); // nadie recibe la propia

    const snap = await sync(users[0]);
    expect(snap.emergencies).toHaveLength(N);

    // Cada uno cierra la suya; las demás siguen hasta que su dueño las cierre.
    await users[0].emitWithAck('emergency_resolve', { userId: 'DIEZ_0' });
    expect((await sync(users[1])).emergencies).toHaveLength(N - 1);
  }, 60000);

  test('carga: 25 SOS simultáneos y 25 ayudantes confirmando en todos a la vez, sin perder ni duplicar nada', async () => {
    const V = 25;
    const H = 25;
    const victims = [];
    const helpers = [];
    for (let i = 0; i < V; i++) victims.push(await user(`CARGA_V${i}`));
    for (let i = 0; i < H; i++) helpers.push(await user(`CARGA_H${i}`));

    const acks = await Promise.all(victims.map((s) => sos(s, { requestId: `c-${s.testUid}` })));
    expect(acks.every((a) => a.success && !a.recovered)).toBe(true);

    // Los 25 ayudantes confirman en las 25 emergencias, todo junto (625 confirmaciones cruzadas).
    const confirms = await Promise.all(helpers.flatMap((h) => victims.map((v) =>
      h.emitWithAck('help_confirm', { emergencyUserId: v.testUid, helperId: h.testUid, helperName: h.testUid }))));
    expect(confirms.filter((c) => !c.success)).toEqual([]);

    const snap = await sync(helpers[0]);
    const mias = snap.emergencies.filter((e) => e.userId.startsWith('CARGA_V'));
    expect(mias).toHaveLength(V);
    for (const e of mias) {
      expect(e.helpersCount).toBe(H);
      expect(new Set(e.helpers).size).toBe(H);            // sin duplicados
      expect(e.helpingByMe).toBe(true);
    }

    // La mitad resuelve y la otra mitad reemplaza su pedido, todo a la vez.
    const mitad = Math.floor(V / 2);
    const results = await Promise.all(victims.map((s, i) => (i < mitad
      ? s.emitWithAck('emergency_resolve', { userId: s.testUid })
      : sos(s, { requestId: `c2-${s.testUid}` }))));
    results.slice(0, mitad).forEach((r) => expect(r).toMatchObject({ success: true, wasActive: true }));
    results.slice(mitad).forEach((r) => expect(r).toMatchObject({ success: true, replaced: true }));

    const despues = await sync(helpers[1]);
    const activas = despues.emergencies.filter((e) => e.userId.startsWith('CARGA_V'));
    expect(activas).toHaveLength(V - mitad);
    activas.forEach((e) => expect(e.helpersCount).toBe(H));  // el reemplazo conserva a los ayudantes
    const terminadas = despues.recent.filter((e) => e.userId.startsWith('CARGA_V'));
    expect(terminadas).toHaveLength(mitad);                  // las reemplazadas no se listan
    terminadas.forEach((e) => expect(e.helpersInfo).toHaveLength(H));
  }, 120000);

  test('doble toque y dos teléfonos de la misma cuenta: una sola emergencia', async () => {
    const tel1 = await user('DOBLE');
    const tel2 = await user('DOBLE', { create: false });
    const testigo = await user('DOBLE_TESTIGO');
    let alertas = 0;
    testigo.on('emergency_alert', () => { alertas++; });

    const [r1, r2, r3] = await Promise.all([
      sos(tel1, { requestId: 'toque-1' }), sos(tel1, { requestId: 'toque-1' }), sos(tel2, { requestId: 'toque-1' }),
    ]);
    const acks = [r1, r2, r3];
    expect(acks.every((a) => a.success)).toBe(true);
    expect(acks.filter((a) => !a.recovered)).toHaveLength(1);       // una sola creación
    expect(new Set(acks.map((a) => a.emergencyId)).size).toBe(1);   // la misma emergencia
    await sleep(300);
    expect(alertas).toBe(1);                                         // un solo aviso
    expect((await sync(testigo)).emergencies).toHaveLength(1);
  });

  test('reintento con el mismo requestId recupera; un toque nuevo REEMPLAZA y conserva ayudantes', async () => {
    const victima = await user('REEMP_V');
    const ayudante = await user('REEMP_H');
    const primero = await sos(victima, { requestId: 'r1' });
    expect((await ayudante.emitWithAck('help_confirm', { emergencyUserId: 'REEMP_V', helperId: 'REEMP_H', helperName: 'Hugo' })).success).toBe(true);

    const reintento = await sos(victima, { requestId: 'r1' });
    expect(reintento).toMatchObject({ success: true, recovered: true, emergencyId: primero.emergencyId, timestamp: primero.timestamp });
    // Cliente viejo (sin requestId): también recupera, nunca reemplaza.
    expect(await sos(victima)).toMatchObject({ recovered: true, emergencyId: primero.emergencyId });

    const nuevaAlerta = waitFor(ayudante, 'emergency_alert', (d) => d.userId === 'REEMP_V' && d.replaced === true);
    await sleep(5); // timestamp distinto garantizado
    const segundo = await sos(victima, { requestId: 'r2', latitude: -38.01, longitude: -57.55 });
    expect(segundo).toMatchObject({ success: true, replaced: true, emergencyRoomId: 'emergencia_REEMP_V' });
    expect(segundo.emergencyId).not.toBe(primero.emergencyId);
    expect(segundo.timestamp).toBeGreaterThan(primero.timestamp);
    expect(await nuevaAlerta).toMatchObject({ emergencyId: segundo.emergencyId, latitude: -38.01 });

    const snap = await sync(ayudante);
    expect(snap.emergencies).toHaveLength(1);
    expect(snap.emergencies[0]).toMatchObject({ emergencyId: segundo.emergencyId, helpingByMe: true, helpers: ['REEMP_H'] });
    expect(snap.emergencies[0].helpersInfo).toEqual([{ id: 'REEMP_H', name: 'Hugo' }]);
    // La reemplazada no ensucia el historial (que es compartido por toda la suite: se filtra por usuario).
    expect(snap.recent.filter((e) => e.userId === 'REEMP_V')).toEqual([]);
  });

  test('"puedo ayudar" le llega a quien pidió ayuda, una vez, y todos ven quién la atiende', async () => {
    const victima = await user('CONF_V');
    const ayudante = await user('CONF_H');
    const tercero = await user('CONF_T');
    const ack = await sos(victima);

    let confirmaciones = 0;
    victima.on('help_confirmed', () => { confirmaciones++; });
    const aviso = waitFor(victima, 'help_confirmed');
    const listaTercero = waitFor(tercero, 'emergency_updated', (d) => d.userId === 'CONF_V' && d.helpersCount === 1);
    const listaVictima = waitFor(victima, 'emergency_updated', (d) => d.helpersCount === 1);

    const res = await ayudante.emitWithAck('help_confirm', { emergencyUserId: 'CONF_V', helperId: 'CONF_H', helperName: 'Ana', ...COORDS });
    expect(res).toMatchObject({ success: true, emergencyId: ack.emergencyId, helpersCount: 1 });
    expect(await aviso).toMatchObject({ emergencyUserId: 'CONF_V', helperId: 'CONF_H', helperName: 'Ana', emergencyId: ack.emergencyId });
    expect((await listaTercero).helpers).toEqual([{ id: 'CONF_H', name: 'Ana' }]);
    await listaVictima;
    await sleep(300);
    expect(confirmaciones).toBe(1);
  });

  test('"No puedo" no borra el pedido y se puede revertir', async () => {
    const victima = await user('NOP_V');
    const otro = await user('NOP_H');
    await sos(victima);

    expect(await otro.emitWithAck('help_reject', { emergencyUserId: 'NOP_V', helperId: 'NOP_H' })).toEqual({ success: true });
    let e = (await sync(otro)).emergencies[0];
    expect(e).toMatchObject({ userId: 'NOP_V', declinedByMe: true, helpingByMe: false, helpersCount: 0 });

    const res = await otro.emitWithAck('help_confirm', { emergencyUserId: 'NOP_V', helperId: 'NOP_H', helperName: 'Otro' });
    expect(res.success).toBe(true);
    e = (await sync(otro)).emergencies[0];
    expect(e).toMatchObject({ declinedByMe: false, helpingByMe: true, helpersCount: 1 });
  });

  test('quien dijo "No puedo" no vuelve a quedar de ayudante por una ubicación tardía', async () => {
    const victima = await user('TARDE_V');
    const otro = await user('TARDE_H');
    await sos(victima);
    await otro.emitWithAck('help_confirm', { emergencyUserId: 'TARDE_V', helperId: 'TARDE_H' });
    await otro.emitWithAck('help_reject', { emergencyUserId: 'TARDE_V', helperId: 'TARDE_H' });
    const loc = await otro.emitWithAck('update_helper_location', { roomId: 'emergencia_TARDE_V', helperId: 'TARDE_H', lat: -38, lng: -57.5 });
    expect(loc).toMatchObject({ success: false, code: 'NOT_A_HELPER' });
    expect((await sync(victima)).emergencies[0].helpersCount).toBe(0);
  });

  test('un ayudante en dos emergencias a la vez recibe el chat de las dos', async () => {
    const v1 = await user('SALAS_V1');
    const v2 = await user('SALAS_V2');
    const h = await user('SALAS_H');
    await sos(v1);
    await sos(v2);
    await h.emitWithAck('help_confirm', { emergencyUserId: 'SALAS_V1', helperId: 'SALAS_H' });
    await h.emitWithAck('help_confirm', { emergencyUserId: 'SALAS_V2', helperId: 'SALAS_H' });
    // La app nueva entra explícitamente a cada sala: la segunda no debe sacarlo de la primera.
    expect((await h.emitWithAck('join_room', { roomId: 'emergencia_SALAS_V1', userId: 'SALAS_H' })).success).toBe(true);
    expect((await h.emitWithAck('join_room', { roomId: 'emergencia_SALAS_V2', userId: 'SALAS_H' })).success).toBe(true);

    const m1 = waitFor(h, 'new_message', (m) => m.roomId === 'emergencia_SALAS_V1');
    const m2 = waitFor(h, 'new_message', (m) => m.roomId === 'emergencia_SALAS_V2');
    await v1.emitWithAck('send_message', { roomId: 'emergencia_SALAS_V1', userId: 'SALAS_V1', username: 'V1', text: 'estoy en la esquina' });
    await v2.emitWithAck('send_message', { roomId: 'emergencia_SALAS_V2', userId: 'SALAS_V2', username: 'V2', text: 'me siguen' });
    expect((await m1).text).toBe('estoy en la esquina');
    expect((await m2).text).toBe('me siguen');

    // Y puede escribir en las dos.
    const r1 = waitFor(v1, 'new_message', (m) => m.userId === 'SALAS_H');
    const r2 = waitFor(v2, 'new_message', (m) => m.userId === 'SALAS_H');
    expect((await h.emitWithAck('send_message', { roomId: 'emergencia_SALAS_V1', userId: 'SALAS_H', username: 'H', text: 'voy' })).success).toBe(true);
    expect((await h.emitWithAck('send_message', { roomId: 'emergencia_SALAS_V2', userId: 'SALAS_H', username: 'H', text: 'en 5 llego' })).success).toBe(true);
    await r1;
    await r2;

    // Se puede pedir ayuda mientras se ayuda: su SOS convive con las otras dos.
    expect(await sos(h)).toMatchObject({ success: true });
    const snap = await sync(h);
    expect(snap.emergencies).toHaveLength(3);
    expect(snap.emergencies.filter((e) => e.helpingByMe)).toHaveLength(2);
  });

  test('se puede escribir en el chat de una emergencia después de salir de la sala general', async () => {
    const victima = await user('SINGEN_V');
    const ayudante = await user('SINGEN_H');
    await sos(victima);
    await ayudante.emitWithAck('help_confirm', { emergencyUserId: 'SINGEN_V', helperId: 'SINGEN_H' });
    // La app nueva sale de "general" al entrar a la pantalla de la emergencia: queda sin sala "actual".
    expect((await ayudante.emitWithAck('leave_room', { roomId: 'general', userId: 'SINGEN_H' })).success).toBe(true);
    expect((await victima.emitWithAck('leave_room', { roomId: 'general', userId: 'SINGEN_V' })).success).toBe(true);

    const llega = waitFor(victima, 'new_message', (m) => m.userId === 'SINGEN_H');
    const eco = waitFor(ayudante, 'message_sent', (m) => m.clientId === 'burbuja-1');
    const envio = await ayudante.emitWithAck('send_message', {
      roomId: 'emergencia_SINGEN_V', userId: 'SINGEN_H', username: 'H', text: 'estoy a dos cuadras', clientId: 'burbuja-1',
    });
    expect(envio.success).toBe(true);
    // El clientId de la app vuelve en el eco y en el mensaje: la burbuja "enviando" se empareja por id.
    expect(await llega).toMatchObject({ text: 'estoy a dos cuadras', clientId: 'burbuja-1' });
    expect((await eco).id).toBe(envio.id);
    expect((await victima.emitWithAck('send_message', { roomId: 'emergencia_SINGEN_V', userId: 'SINGEN_V', username: 'V', text: 'te veo' })).success).toBe(true);
  });

  test('un audio grande (más de 1 MB) no corta la conexión de quien lo manda', async () => {
    const victima = await user('AUDIO_V');
    await sos(victima);
    let desconectado = false;
    victima.on('disconnect', () => { desconectado = true; });
    // ~2 MB de payload: con el límite por defecto de socket.io (1 MB) el servidor cerraba el socket.
    const res = await victima.timeout(15000).emitWithAck('audio_message', {
      roomId: 'emergencia_AUDIO_V', userId: 'AUDIO_V', username: 'V', durationMs: 60000,
      audioDataUrl: 'data:audio/mp4;base64,' + 'A'.repeat(2 * 1024 * 1024),
    });
    expect(desconectado).toBe(false);
    expect(victima.connected).toBe(true);
    expect(res.success).toBe(true);
    expect(res.audioUrl).toBeTruthy();
  }, 30000);

  test('resolver una emergencia no toca la otra ni su chat, y queda en el historial con quién la atendió', async () => {
    const v1 = await user('RES_V1');
    const v2 = await user('RES_V2');
    const h = await user('RES_H');
    const a1 = await sos(v1);
    await sos(v2);
    await h.emitWithAck('help_confirm', { emergencyUserId: 'RES_V1', helperId: 'RES_H', helperName: 'Hache' });
    await v1.emitWithAck('send_message', { roomId: 'emergencia_RES_V1', userId: 'RES_V1', username: 'V1', text: 'uno' });
    await v2.emitWithAck('send_message', { roomId: 'emergencia_RES_V2', userId: 'RES_V2', username: 'V2', text: 'dos' });

    const cancelada = waitFor(v2, 'emergency_cancelled', (d) => d.userId === 'RES_V1');
    const res = await v1.emitWithAck('emergency_resolve', { userId: 'RES_V1' });
    expect(res).toMatchObject({ success: true, wasActive: true });
    expect(await cancelada).toMatchObject({ emergencyId: a1.emergencyId, helpersInfo: [{ id: 'RES_H', name: 'Hache' }] });

    const mensajes = await listDocs('messages');
    expect(mensajes.map((m) => m.roomId)).toEqual(['emergencia_RES_V2']);

    const snap = await sync(h);
    expect(snap.emergencies.map((e) => e.userId)).toEqual(['RES_V2']);
    const propias = snap.recent.filter((e) => e.userId.startsWith('RES_'));
    expect(propias).toEqual([expect.objectContaining({
      emergencyId: a1.emergencyId, userId: 'RES_V1', endReason: 'resolved_by_user', helpersInfo: [{ id: 'RES_H', name: 'Hache' }],
    })]);
    expect(propias[0].endedAt).toBeGreaterThanOrEqual(propias[0].startedAt);
    // El historial viene ordenado: lo más reciente primero.
    expect(snap.recent[0].emergencyId).toBe(a1.emergencyId);
    expect(snap.serverTime).toBeGreaterThan(0);
  });

  test('cancelación y "puedo ayudar" cruzados: el ayudante nunca queda en una emergencia que ya no existe', async () => {
    const victima = await user('CRUCE_V');
    const ayudante = await user('CRUCE_H');
    await sos(victima);
    const [resolve, confirm] = await Promise.all([
      victima.emitWithAck('emergency_resolve', { userId: 'CRUCE_V' }),
      ayudante.emitWithAck('help_confirm', { emergencyUserId: 'CRUCE_V', helperId: 'CRUCE_H' }),
    ]);
    expect(resolve.success).toBe(true);
    // Cualquiera de los dos órdenes es válido, pero el resultado tiene que ser coherente.
    if (!confirm.success) expect(confirm.code).toBe('EMERGENCY_NOT_ACTIVE');
    expect((await sync(ayudante)).emergencies).toEqual([]);
    const tarde = await ayudante.emitWithAck('help_confirm', { emergencyUserId: 'CRUCE_V', helperId: 'CRUCE_H' });
    expect(tarde).toMatchObject({ success: false, code: 'EMERGENCY_NOT_ACTIVE' });
  });

  test('la víctima reconecta y vuelve sola a su sala; el ayudante también', async () => {
    const victima = await user('RECO_V');
    const ayudante = await user('RECO_H');
    await sos(victima);
    await ayudante.emitWithAck('help_confirm', { emergencyUserId: 'RECO_V', helperId: 'RECO_H' });

    victima.close();
    ayudante.close();
    await sleep(300);
    const victima2 = await user('RECO_V', { create: false });
    const ayudante2 = await user('RECO_H', { create: false });

    const paraAyudante = waitFor(ayudante2, 'new_message', (m) => m.roomId === 'emergencia_RECO_V');
    const envio = await victima2.emitWithAck('send_message', { roomId: 'emergencia_RECO_V', userId: 'RECO_V', username: 'V', text: 'sigo acá' });
    expect(envio.success).toBe(true);
    expect((await paraAyudante).text).toBe('sigo acá');
  });

  test('la lista de la sala refleja quién está conectado de verdad', async () => {
    const victima = await user('LISTA_V');
    const ayudante = await user('LISTA_H');
    await sos(victima);
    const conDos = waitFor(victima, 'room_users_updated', (d) => d.roomId === 'emergencia_LISTA_V' && d.userCount === 2);
    await ayudante.emitWithAck('help_confirm', { emergencyUserId: 'LISTA_V', helperId: 'LISTA_H' });
    await conDos;

    const conUno = waitFor(victima, 'room_users_updated', (d) => d.roomId === 'emergencia_LISTA_V' && d.userCount === 1);
    ayudante.close();
    await conUno;
  });

  test('un usuario sin aprobar no puede entrar a la sala de una emergencia ajena', async () => {
    const victima = await user('PRIV_V');
    const curioso = await user('PRIV_X', { approved: false });
    await sos(victima);
    const res = await curioso.emitWithAck('join_room', { roomId: 'emergencia_PRIV_V', userId: 'PRIV_X' });
    expect(res).toMatchObject({ success: false, code: 'ROOM_FORBIDDEN' });
    const msg = await curioso.emitWithAck('send_message', { roomId: 'emergencia_PRIV_V', userId: 'PRIV_X', username: 'X', text: 'hola' });
    expect(msg.success).toBe(false);
    expect((await sync(curioso)).emergencies).toEqual([]);
  });

  test('un SOS que el servidor rechaza deja rastro en la auditoría', async () => {
    const s = await user('AUDIT_R');
    const res = await s.emitWithAck('emergency_alert', { userId: 'AUDIT_R', userName: 'R' }); // sin ubicación
    expect(res.code).toBe('INVALID_LOCATION');
    const log = await until(async () =>
      (await listDocs('audit_logs')).find((l) => l.action === 'emergency_alert_rejected' && l.actorUid === 'AUDIT_R'));
    expect(log.details.code).toBe('INVALID_LOCATION');
  });

  test('GET /emergencies/feed devuelve lo mismo que sync_emergencies, sin socket', async () => {
    const victima = await user('FEED_V');
    await setDoc('users', 'FEED_O', { state: 'approved' });
    const ack = await sos(victima);
    const res = await fetch(`${URL}/emergencies/feed`, { headers: { Authorization: `Bearer ${await tokenFor('FEED_O')}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.emergencies).toEqual([expect.objectContaining({ userId: 'FEED_V', emergencyId: ack.emergencyId, helpingByMe: false, declinedByMe: false })]);
    expect(Array.isArray(body.recent)).toBe(true);
    expect(body.recent.filter((e) => e.userId === 'FEED_V')).toEqual([]);

    // Un usuario sin aprobar no ve emergencias ajenas, ni activas ni del historial.
    const noAprobado = await (await fetch(`${URL}/emergencies/feed`, { headers: { Authorization: `Bearer ${await tokenFor('FEED_PENDIENTE')}` } })).json();
    expect(noAprobado.emergencies).toEqual([]);
    expect(noAprobado.recent).toEqual([]);
  });
});
