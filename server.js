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
  path: '/socket.io/',
  transports: ['polling', 'websocket'], // aseguramos compatibilidad
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
const SALAS_ROOM_ID = 'salas';        // 🆕 Lobby
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
app.get('/health', (_, res) => res.status(200).send('Servidor operativo.'));
app.get('/users', (_, res) => res.json(Array.from(connectedUsers.values())));
app.get('/rooms', (_, res) => res.json(serializeRooms()));
// -------------------------------

// 🔌 Conexión Socket.IO
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
      await db.collection(USERS_COLLECTION).doc(user.id).set(user, { merge: true });
      console.log(`${colors.green}💾 Usuario guardado en Firestore:${colors.reset} ${user.username}`);
    } catch (e) {
      console.error(`${colors.red}❌ Error guardando usuario:${colors.reset}`, e);
    }

    // Lista global de usuarios conectados
    io.emit('connected_users', Array.from(connectedUsers.values()));

    // Lista de salas serializada (para RoomManager)
    socket.emit('room_list', serializeRooms());

    // 📝 NO auto-unimos a ninguna sala aquí.
    // El cliente decidirá y emitirá join_room("salas") en SalasScreen.
  });

  // 🧩 Aux: salir de la sala actual
  const leaveCurrentRoom = (userId, socket) => {
    const prevRoomId = userToRoomMap.get(userId);
    if (prevRoomId && rooms.has(prevRoomId)) {
      const room = rooms.get(prevRoomId);
      room.users.delete(userId);
      socket.leave(prevRoomId);

      // Si era Handy y hablaba, soltar token
      if (prevRoomId === HANDY_ROOM_ID && room.currentSpeaker === userId) {
        room.currentSpeaker = null;
        io.to(HANDY_ROOM_ID).emit('talk_token_released', { roomId: HANDY_ROOM_ID, currentSpeaker: null });
      }

      io.to(prevRoomId).emit('user-left-room', { roomId: prevRoomId, userCount: room.users.size });
      console.log(`${colors.yellow}👋 ${userId} salió de ${prevRoomId}${colors.reset}`);
    }
  };

  // 🏠 Unirse a sala (idempotente y compatible con Android)
socket.on('join_room', (data = {}) => {
  const roomName = data.room || data.roomId;
  const { userId, username } = data;
  console.log(`${colors.cyan}📥 join_room:${colors.reset}`, data);

  // 🔍 Validaciones básicas
  if (!roomName || !userId || !username) {
    socket.emit('join_error', { message: 'Datos de unión incompletos' });
    console.warn(`${colors.yellow}⚠️ join_room con datos incompletos${colors.reset}`);
    return;
  }

  if (!rooms.has(roomName)) {
    socket.emit('join_error', { message: `La sala ${roomName} no existe` });
    console.warn(`${colors.yellow}⚠️ Sala inexistente: ${roomName}${colors.reset}`);
    return;
  }

  const room = rooms.get(roomName);

  // 🧭 Si ya está en la misma sala, confirmar igual (evita timeout)
  const current = userToRoomMap.get(userId);
  if (current === roomName) {
    const users = getRoomUsers(roomName);
    socket.emit('join_success', {
      message: `Ya estabas en ${roomName}`,
      room: roomName,
      roomId: roomName,
      users,
      currentSpeaker: room.currentSpeaker,
      userCount: users.length,
    });
    socket.emit('room_joined', { roomId: roomName, username, userCount: users.length }); // 👈 Compatibilidad Android
    console.log(`${colors.yellow}ℹ️ ${username} ya estaba en ${roomName}${colors.reset}`);
    return;
  }

  // 🔄 Salir de la sala anterior si corresponde
  leaveCurrentRoom(userId, socket);

  // 🚪 Unirse a la nueva sala
  socket.join(roomName);
  room.users.add(userId);
  userToRoomMap.set(userId, roomName);

  const users = getRoomUsers(roomName);

  // ✅ Confirmaciones al cliente Android
  socket.emit('join_success', {
    message: `Te has unido a ${roomName}`,
    room: roomName,
    roomId: roomName,
    users,
    currentSpeaker: room.currentSpeaker,
    userCount: users.length,
  });

  // 🔹 Evento esperado por tu app (ChatViewModel)
  socket.emit('room_joined', { roomId: roomName, username, userCount: users.length });

  // 📢 Broadcast a todos los usuarios de la sala
  io.to(roomName).emit('user-joined-room', { roomId: roomName, userCount: users.length });

  console.log(`${colors.green}✅ ${username} se unió a ${roomName}${colors.reset}`);
});


    // Broadcast de actualización de contador
    io.to(roomName).emit('user-joined-room', { roomId: roomName, userCount: users.length });

    console.log(`${colors.green}✅ ${username} se unió a ${roomName}${colors.reset}`);
  });

  // 🚪 Salir de sala (desde cliente)
  // 🏠 Unirse a sala (idempotente y compatible con Android)
socket.on('join_room', (data = {}) => {
  const roomName = data.room || data.roomId;
  const { userId, username } = data;
  console.log(`${colors.cyan}📥 join_room:${colors.reset}`, data);

  // 🔍 Validaciones básicas
  if (!roomName || !userId || !username) {
    socket.emit('join_error', { message: 'Datos de unión incompletos' });
    console.warn(`${colors.yellow}⚠️ join_room con datos incompletos${colors.reset}`);
    return;
  }
  if (!rooms.has(roomName)) {
    socket.emit('join_error', { message: `La sala ${roomName} no existe` });
    console.warn(`${colors.yellow}⚠️ Sala inexistente: ${roomName}${colors.reset}`);
    return;
  }

  const room = rooms.get(roomName);

  // 🧭 Si ya está en la misma sala, devolver confirmación inmediata
  const current = userToRoomMap.get(userId);
  if (current === roomName) {
    const users = getRoomUsers(roomName);
    socket.emit('join_success', {
      message: `Ya estabas en ${roomName}`,
      room: roomName,
      roomId: roomName,
      users,
      currentSpeaker: room.currentSpeaker,
      userCount: users.length,
    });
    socket.emit("room_joined", { roomId: roomName, username, userCount: users.length }); // 🔹 Compatibilidad Android
    console.log(`${colors.yellow}ℹ️ ${username} ya estaba en ${roomName}${colors.reset}`);
    return;
  }

  // 🔄 Salir de sala anterior si corresponde
  leaveCurrentRoom(userId, socket);

  // 🚪 Unirse a la nueva sala
  socket.join(roomName);
  room.users.add(userId);
  userToRoomMap.set(userId, roomName);

  const users = getRoomUsers(roomName);

  // ✅ Confirmación al cliente
  socket.emit('join_success', {
    message: `Te has unido a ${roomName}`,
    room: roomName,
    roomId: roomName,
    users,
    currentSpeaker: room.currentSpeaker,
    userCount: users.length,
  });

  // 🔹 Confirmación rápida para Android
  socket.emit("room_joined", { roomId: roomName, username, userCount: users.length });

  // 📢 Broadcast: notificar a la sala que alguien se unió
  io.to(roomName).emit('user-joined-room', { roomId: roomName, userCount: users.length });

  console.log(`${colors.green}✅ ${username} se unió a ${roomName}${colors.reset}`);
});


  // 👥 Lista de usuarios por sala — alias compatibles con Android
  socket.on('get_users', (data = {}) => {
    const roomId = data.roomId || data.room || SALAS_ROOM_ID;
    const users = getRoomUsers(roomId);
    console.log(`${colors.magenta}👥 Enviando usuarios de sala (get_users):${colors.reset} ${roomId}`);
    socket.emit('users_list', users);
  });
 


  // (Compatibilidad) nombre anterior
  socket.on('get_room_users', (roomName) => {
    const roomId = typeof roomName === 'string' ? roomName : roomName?.roomId || SALAS_ROOM_ID;
    const users = getRoomUsers(roomId);
    console.log(`${colors.magenta}👥 Enviando usuarios de sala (get_room_users):${colors.reset} ${roomId}`);
    socket.emit('users_list', users);
  });

  // 🌍 Lista global
  socket.on('get_all_users', () => {
    socket.emit('connected_users', Array.from(connectedUsers.values()));
  });

  // 🎙️ PTT: solicitar token
  socket.on('request_talk_token', ({ userId, roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    if (!room.currentSpeaker) {
      room.currentSpeaker = userId;
      const username = connectedUsers.get(userId)?.username || 'Desconocido';
      io.to(roomId).emit('talk_token_granted', { roomId, currentSpeaker: userId, username });
      console.log(`${colors.green}🎙️ ${username} tomó el token en ${roomId}${colors.reset}`);
    } else if (room.currentSpeaker !== userId) {
      socket.emit('talk_token_denied', { roomId, currentSpeaker: room.currentSpeaker });
      console.log(`${colors.yellow}🚫 Token denegado para ${userId}${colors.reset}`);
    }
  });

  // 🔇 PTT: liberar token
  socket.on('release_talk_token', ({ userId, roomId }) => {
    const room = rooms.get(roomId);
    if (room && room.currentSpeaker === userId) {
      room.currentSpeaker = null;
      io.to(roomId).emit('talk_token_released', { roomId, currentSpeaker: null });
      console.log(`${colors.cyan}🔇 ${userId} liberó el token en ${roomId}${colors.reset}`);
    }
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
      console.log(`${colors.green}💬 Mensaje de ${username} → ${roomId}:${colors.reset} ${text}`);
    } catch (e) {
      console.error(`${colors.red}❌ Error guardando mensaje:${colors.reset}`, e);
    }
  });

  // 🎧 Mensajes de audio (espera audioData en base64)
  socket.on('audio_message', async (data = {}) => {
    const { userId, username, audioData, roomId } = data;
    if (!audioData || !userId || !roomId) {
      console.warn(`${colors.yellow}⚠️ audio_message inválido (falta audioData/userId/roomId)${colors.reset}`);
      return;
    }

    const room = rooms.get(roomId);
    if (roomId === HANDY_ROOM_ID && room?.currentSpeaker !== userId) {
      socket.emit('audio_transmission_failed', { message: 'No tienes el token de palabra (PTT).' });
      console.log(`${colors.yellow}⚠️ Audio rechazado (sin token) para ${username}${colors.reset}`);
      return;
    }

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
