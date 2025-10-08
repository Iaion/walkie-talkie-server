// Servidor Node.js con Socket.IO, Firebase Firestore y Storage
// 💬 Compatible con tu app Android (SocketRepository y RoomManager actuales)
// 🎨 Logs con colores y emojis para depuración

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');
const { Buffer } = require('buffer');

// 🎨 ANSI colors
const colors = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
};

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e8,
});

app.use(cors());

// -------------------------------
// 🔥 Firebase init
// -------------------------------
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS || !process.env.FIREBASE_STORAGE_BUCKET) {
  console.error(`${colors.red}❌ Falta configuración de Firebase${colors.reset}`);
  process.exit(1);
}

try {
  const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
  console.log(`${colors.green}✅ Firebase inicializado correctamente.${colors.reset}`);
} catch (err) {
  console.error(`${colors.red}❌ Error al inicializar Firebase:${colors.reset}`, err);
  process.exit(1);
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

const USERS_COLLECTION = 'users';
const MESSAGES_COLLECTION = 'messages';

// -------------------------------
// 📦 Estado en memoria
// -------------------------------
const connectedUsers = new Map();     // userId -> { id, username, email, socketId, ... }
const socketToUserMap = new Map();    // socket.id -> userId
const rooms = new Map();              // roomId -> { id, name, description, users:Set<userId>, currentSpeaker, type, isPrivate }
const userToRoomMap = new Map();      // userId -> roomId

// -------------------------------
// 🚪 Salas base
// -------------------------------
const SALAS_ROOM_ID = 'salas';
const GENERAL_ROOM_ID = 'general';
const HANDY_ROOM_ID = 'handy';

rooms.set(SALAS_ROOM_ID, {
  id: SALAS_ROOM_ID,
  name: 'Lobby de Salas',
  description: 'Pantalla de selección de salas',
  users: new Set(),
  currentSpeaker: null,
  type: 'lobby',
  isPrivate: false,
});

rooms.set(GENERAL_ROOM_ID, {
  id: GENERAL_ROOM_ID,
  name: 'Chat General',
  description: 'Sala de chat público',
  users: new Set(),
  currentSpeaker: null,
  type: 'general',
  isPrivate: false,
});

rooms.set(HANDY_ROOM_ID, {
  id: HANDY_ROOM_ID,
  name: 'Radio Handy (PTT)',
  description: 'Simulación de radio PTT',
  users: new Set(),
  currentSpeaker: null,
  type: 'ptt',
  isPrivate: false,
});

// -------------------------------
// 🔧 Helpers
// -------------------------------
function serializeRoom(room) {
  return {
    id: room.id,
    name: room.name,
    description: room.description || '',
    userCount: room.users?.size || 0,
    maxUsers: 50,
    type: room.type || (room.id === HANDY_ROOM_ID ? 'ptt' : 'general'),
    isPrivate: !!room.isPrivate,
    currentSpeakerId: room.currentSpeaker || null,
  };
}

function serializeRooms() {
  return Array.from(rooms.values()).map(serializeRoom);
}

function getRoomUsers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.users)
    .map((id) => connectedUsers.get(id))
    .filter(Boolean);
}

// -------------------------------
// 🌐 Endpoints REST
// -------------------------------
app.get('/health', (_, res) => res.status(200).send('Servidor operativo.'));
app.get('/users', (_, res) => res.json(Array.from(connectedUsers.values())));
app.get('/rooms', (_, res) => res.json(serializeRooms()));

// -------------------------------
// 🔌 Conexión Socket.IO
// -------------------------------
io.on('connection', (socket) => {
  console.log(`${colors.cyan}✅ Nuevo socket conectado: ${socket.id}${colors.reset}`);

  // 📥 Registro de usuario
  socket.on('user-connected', async (user) => {
    console.log(`${colors.blue}📥 user-connected:${colors.reset}`, user);
    if (!user || !user.id || !user.username) {
      console.warn(`${colors.yellow}⚠️ Datos de usuario inválidos.${colors.reset}`);
      return;
    }

    socketToUserMap.set(socket.id, user.id);
    connectedUsers.set(user.id, { ...user, socketId: socket.id, isOnline: true });

    try {
      const userDoc = db.collection(USERS_COLLECTION).doc(user.id);
      const docSnapshot = await userDoc.get();

      if (docSnapshot.exists) {
        await userDoc.update({ ...user, lastLogin: Date.now(), isOnline: true });
        console.log(`${colors.green}🔑 Inicio de sesión:${colors.reset} ${user.username}`);
      } else {
        await userDoc.set({ ...user, createdAt: Date.now(), isOnline: true });
        console.log(`${colors.green}🆕 Usuario nuevo registrado en Firebase:${colors.reset} ${user.username}`);
      }
    } catch (e) {
      console.error(`${colors.red}❌ Error guardando usuario en Firebase:${colors.reset}`, e);
    }

    // Lista global de usuarios conectados
    io.emit('connected_users', Array.from(connectedUsers.values()));

    // Lista de salas para el cliente
    socket.emit('room_list', serializeRooms());
  });

  // 🧩 Aux: salir de la sala actual
  const leaveCurrentRoom = (userId, socketInstance) => {
    const prevRoomId = userToRoomMap.get(userId);
    if (prevRoomId && rooms.has(prevRoomId)) {
      const room = rooms.get(prevRoomId);
      room.users.delete(userId);
      socketInstance.leave(prevRoomId);

      if (prevRoomId === HANDY_ROOM_ID && room.currentSpeaker === userId) {
        room.currentSpeaker = null;
        io.to(HANDY_ROOM_ID).emit('talk_token_released', { roomId: HANDY_ROOM_ID, currentSpeaker: null });
      }

      io.to(prevRoomId).emit('user-left-room', { roomId: prevRoomId, userCount: room.users.size });
      console.log(`${colors.yellow}👋 ${userId} salió de ${prevRoomId}${colors.reset}`);
    }
  };

  // 🏠 Unirse a sala
  socket.on('join_room', (data = {}) => {
    const roomName = data.room || data.roomId;
    const { userId, username } = data;
    console.log(`${colors.cyan}📥 join_room:${colors.reset}`, data);

    // Validaciones
    if (!roomName || !userId || !username) {
      socket.emit('join_error', { message: 'Datos de unión incompletos' });
      return;
    }
    if (!rooms.has(roomName)) {
      socket.emit('join_error', { message: `La sala ${roomName} no existe` });
      return;
    }

    const room = rooms.get(roomName);
    const current = userToRoomMap.get(userId);

    // Ya estaba en la sala
    if (current === roomName) {
      const users = getRoomUsers(roomName);
      socket.emit('join_success', {
        message: `Ya estabas en ${roomName}`,
        room: roomName,
        roomId: roomName,
        users,
        userCount: users.length,
      });
      socket.emit('room_joined', { roomId: roomName, username, userCount: users.length });
      console.log(`${colors.yellow}ℹ️ ${username} ya estaba en ${roomName}${colors.reset}`);
      return;
    }

    // Cambio de sala
    leaveCurrentRoom(userId, socket);
    socket.join(roomName);
    room.users.add(userId);
    userToRoomMap.set(userId, roomName);

    const users = getRoomUsers(roomName);

    // Emitir confirmaciones
    socket.emit('join_success', {
      message: `Te has unido a ${roomName}`,
      room: roomName,
      roomId: roomName,
      users,
      userCount: users.length,
    });
    socket.emit('room_joined', { roomId: roomName, username, userCount: users.length });

    io.to(roomName).emit('user-joined-room', { roomId: roomName, userCount: users.length });

    console.log(`${colors.green}✅ ${username} se unió a ${roomName}${colors.reset}`);
  });

  // 🚪 Salir de sala
  socket.on('leave_room', (data = {}) => {
    const { roomId, userId, username } = data;
    if (!userId) return;
    const current = userToRoomMap.get(userId);
    if (!current) return;

    leaveCurrentRoom(userId, socket);
    socket.emit('left_room', { roomId: current });
    console.log(`${colors.yellow}👋 ${username || userId} pidió salir de ${current}${colors.reset}`);
  });

  // 👥 Lista de usuarios
  socket.on('get_users', (data = {}) => {
    const roomId = data.roomId || data.room || SALAS_ROOM_ID;
    const users = getRoomUsers(roomId);
    socket.emit('users_list', users);
    console.log(`${colors.magenta}👥 Enviando usuarios de sala:${colors.reset} ${roomId}`);
  });

  // 📋 Lista de salas
  socket.on('get_rooms', () => {
    socket.emit('room_list', serializeRooms());
    console.log(`${colors.magenta}📋 Lista de salas enviada.${colors.reset}`);
  });

  // 💬 Mensajes de texto
  socket.on('send_message', async (data = {}) => {
    const { userId, username, text, roomId } = data;
    if (!text || !userId || !roomId) return;
    const message = {
      id: uuidv4(),
      userId,
      username,
      text,
      roomId,
      timestamp: Date.now(),
    };
    try {
      await db.collection(MESSAGES_COLLECTION).add(message);
      io.to(roomId).emit('new_message', message);
      console.log(`${colors.green}💬 ${username} → ${roomId}:${colors.reset} ${text}`);
    } catch (e) {
      console.error(`${colors.red}❌ Error guardando mensaje:${colors.reset}`, e);
    }
  });

  // 🎧 Mensajes de audio
  socket.on('audio_message', async (data = {}) => {
    const { userId, username, audioData, roomId } = data;
    if (!audioData || !userId || !roomId) return;

    try {
      const buffer = Buffer.from(audioData, 'base64');
      const filePath = `audios/${roomId}/${userId}_${Date.now()}_${uuidv4()}.m4a`;
      const file = bucket.file(filePath);
      await file.save(buffer, { contentType: 'audio/m4a', resumable: false });
      await file.makePublic();
      const url = file.publicUrl();

      const audioMsg = {
        id: uuidv4(),
        userId,
        username,
        audioUrl: url,
        roomId,
        timestamp: Date.now(),
      };

      await db.collection(MESSAGES_COLLECTION).add(audioMsg);
      io.to(roomId).emit('new_message', audioMsg);
      console.log(`${colors.green}🎤 Audio subido por ${username} (${roomId})${colors.reset}`);
    } catch (err) {
      console.error(`${colors.red}❌ Error subiendo audio:${colors.reset}`, err);
    }
  });

  // 🔴 Desconexión
  socket.on('disconnect', () => {
    const userId = socketToUserMap.get(socket.id);
    if (userId) {
      leaveCurrentRoom(userId, socket);
      connectedUsers.delete(userId);
      userToRoomMap.delete(userId);
      io.emit('connected_users', Array.from(connectedUsers.values()));
    }
    socketToUserMap.delete(socket.id);
    console.log(`${colors.red}🔴 Socket desconectado:${colors.reset} ${socket.id}`);
  });
});

// -------------------------------
// 🚀 Iniciar servidor
// -------------------------------
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`${colors.green}🚀 Servidor corriendo en puerto ${PORT}${colors.reset}`);
  console.log(`${colors.cyan}🌐 http://localhost:${PORT}${colors.reset}`);
});
