/**
 * test/characterization/rooms-chat.test.js
 * Caracterización de salas y chat: REST /rooms y eventos Socket.IO
 * join_room, leave_room, send_message, get_users.
 */
const request = require('supertest');
const { io } = require('socket.io-client');
const { clearFirestore } = require('../setup/emulator');
const { startServer, stopServer } = require('../setup/server');
const { getIdToken } = require('../setup/auth');

const URL = 'http://127.0.0.1:8080';
let TOKEN;
const api = () => {
  const r = request(URL);
  const auth = (req) => req.set('Authorization', `Bearer ${TOKEN}`);
  return { get: (p) => auth(r.get(p)), post: (p) => auth(r.post(p)), delete: (p) => auth(r.delete(p)) };
};

function connect() {
  return new Promise((resolve, reject) => {
    const socket = io(URL, { transports: ['websocket'], forceNew: true, auth: { token: TOKEN } });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

describe('Caracterización — salas y chat', () => {
  let sockets = [];

  beforeAll(async () => { await startServer(); TOKEN = await getIdToken(); });
  afterAll(stopServer);
  beforeEach(async () => { await clearFirestore(); });
  afterEach(() => { sockets.forEach((s) => s.close()); sockets = []; });

  async function newSocket() {
    const s = await connect();
    sockets.push(s);
    return s;
  }

  describe('REST /rooms', () => {
    test('GET /rooms → las 3 salas por defecto', async () => {
      const res = await api().get('/rooms');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.total).toBe(3);
      const ids = res.body.rooms.map((r) => r.id).sort();
      expect(ids).toEqual(['ayuda', 'general', 'handy']);
    });

    test('GET /rooms/:roomId inexistente → 404', async () => {
      const res = await api().get('/rooms/no-existe');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ success: false, message: 'Sala no encontrada' });
    });

    test('GET /rooms/general → success con la sala', async () => {
      const res = await api().get('/rooms/general');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.room).toMatchObject({ id: 'general', name: expect.any(String) });
    });
  });

  describe('join_room', () => {
    test('sin roomId/userId → requeridos', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('join_room', {});
      expect(res).toEqual({ success: false, message: 'roomId y userId son requeridos' });
    });

    test('sala inexistente → "Sala X no encontrada"', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('join_room', { roomId: 'no-existe', userId: 'U1' });
      expect(res).toEqual({ success: false, message: 'Sala no-existe no encontrada' });
    });

    test('sala válida → success', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('join_room', { roomId: 'ayuda', userId: 'U1' });
      expect(res).toMatchObject({ success: true, roomId: 'ayuda', message: 'Unido a sala ayuda' });
    });
  });

  describe('leave_room', () => {
    test('sin roomId → "Sala no especificada"', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('leave_room', {});
      expect(res).toEqual({ success: false, message: '❌ Sala no especificada' });
    });

    test('sala inexistente → "Sala no encontrada"', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('leave_room', { roomId: 'no-existe', userId: 'U1' });
      expect(res).toEqual({ success: false, message: 'Sala no encontrada' });
    });

    test('sala válida → success', async () => {
      const s = await newSocket();
      await s.emitWithAck('user-connected', { id: 'U1', username: 'Juan' });
      const res = await s.emitWithAck('leave_room', { roomId: 'general', userId: 'U1' });
      expect(res).toMatchObject({ success: true, message: 'Salido de general' });
    });
  });

  describe('send_message', () => {
    test('datos inválidos → "Datos de mensaje inválidos"', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('send_message', { userId: 'U1', username: 'Juan' });
      expect(res).toEqual({ success: false, message: '❌ Datos de mensaje inválidos' });
    });

    test('socket sin sala → "No estás en una sala válida"', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('send_message', { userId: 'U1', username: 'Juan', text: 'hola' });
      expect(res).toEqual({ success: false, message: '❌ No estás en una sala válida' });
    });

    test('en sala válida (tras conectarse) → success con id', async () => {
      const s = await newSocket();
      await s.emitWithAck('user-connected', { id: 'U1', username: 'Juan' });
      const res = await s.emitWithAck('send_message', { userId: 'U1', username: 'Juan', text: 'hola', roomId: 'general' });
      expect(res.success).toBe(true);
      expect(res.id).toBeTruthy();
    });
  });

  describe('get_users', () => {
    test('sala inexistente → "Sala no encontrada"', async () => {
      const s = await newSocket();
      const res = await s.emitWithAck('get_users', { roomId: 'no-existe' });
      expect(res).toEqual({ success: false, message: 'Sala no encontrada' });
    });

    test('sala válida → success con lista de usuarios', async () => {
      const s = await newSocket();
      await s.emitWithAck('user-connected', { id: 'U1', username: 'Juan' });
      const res = await s.emitWithAck('get_users', { roomId: 'general' });
      expect(res.success).toBe(true);
      expect(res.roomId).toBe('general');
      expect(Array.isArray(res.users)).toBe(true);
      expect(res.users.some((u) => u.id === 'U1')).toBe(true);
    });
  });
});
