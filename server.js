// Servidor Node.js con Socket.IO, Firebase Firestore y Storage
// 💬 Compatible con tu app Android (SocketRepository corregido)
// 🎨 Incluye logs con colores y emojis para depuración en tiempo real

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');
const { Buffer } = require('buffer');

// 🎨 Códigos de color ANSI
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
// 🔥 Inicialización Firebase
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
// 📦 Estructuras de datos
// -------------------------------
const connectedUsers = new Map();
const socketToUserMap = new Map();
const rooms = new Map();
const userToRoomMap = new Map();

// -------------------------------
// 🚪 Salas base
// -------------------------------
const GENERAL_ROOM_ID = 'general';
const HANDY_ROOM_ID = 'handy';

rooms.set(GENERAL_ROOM_ID, {
  id: GENERAL_ROOM_ID,
  name: 'Chat General',
  description: 'Sala de chat público',
  users: new Set(),
  currentSpeaker: null,
});

rooms.set(HANDY_ROOM_ID, {
  id: HANDY_ROOM_ID,
  name: 'Radio Handy (PTT)',
  description: 'Simulación de radio PTT',
  users: new Set(),
  currentSpeaker: null,
});

// -------------------------------
// 🧩 API REST básica
// -------------------------------
app.get('/health', (_, res) => res.status(200).send('Servidor operativo.'));
app.get('/users', (_, res) => res.json(Array.from(connectedUsers.values())));
app.get('/rooms', (_, res) => res.json(Array.from(rooms.values())));

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
      await db.collection(USERS_COLLECTION).doc(user.id).set(user, { merge: true });
      console.log(`${colors.green}💾 Usuario guardado en Firestore:${colors.reset} ${user.username}`);
    } catch (e) {
      console.error(`${colors.red}❌ Error guardando usuario:${colors.reset}`, e);
    }

    io.emit('user-list', Array.from(connectedUsers.values()));
    socket.emit('room_list', Array.from(rooms.values()));
  });

  // 🧩 Función auxiliar
  const leaveCurrentRoom = (userId, socket) => {
    const prevRoomId = userToRoomMap.get(userId);
    if (prevRoomId && rooms.has(prevRoomId)) {
      const room = rooms.get(prevRoomId);
      room.users.delete(userId);
      socket.leave(prevRoomId);

      if (prevRoomId === HANDY_ROOM_ID && room.currentSpeaker === userId) {
        room.currentSpeaker = null;
        io.to(HANDY_ROOM_ID).emit('talk_token_released', { roomId: HANDY_ROOM_ID, currentSpeaker: null });
      }

      io.to(prevRoomId).emit('user-left-room', { roomId: prevRoomId, userCount: room.users.size });
      console.log(`${colors.yellow}👋 ${userId} salió de ${prevRoomId}${colors.reset}`);
    }
  };

  // 🏠 Unirse a sala
  socket.on('join_room', (data) => {
    const roomName = data.room || data.roomId;
    const { userId, username } = data;

    console.log(`${colors.cyan}📥 join_room:${colors.reset}`, data);

    if (!roomName || !userId || !username) {
      socket.emit('join_error', { message: 'Datos de unión incompletos' });
      return;
    }

    if (!rooms.has(roomName)) {
      socket.emit('join_error', { message: `La sala ${roomName} no existe` });
      return;
    }

    leaveCurrentRoom(userId, socket);
    socket.join(roomName);
    const room = rooms.get(roomName);
    room.users.add(userId);
    userToRoomMap.set(userId, roomName);

    const users = Array.from(room.users)
      .map((id) => connectedUsers.get(id))
      .filter(Boolean);

    socket.emit('join_success', {
      message: `Te has unido a ${roomName}`,
      room: roomName,
      users,
      currentSpeaker: room.currentSpeaker,
      userCount: users.length,
    });

    io.to(roomName).emit('user-joined-room', { roomId: roomName, userCount: users.length });
    console.log(`${colors.green}✅ ${username} se unió a ${roomName}${colors.reset}`);
  });

  // 📋 Solicitar salas
  socket.on('get_rooms', () => {
    console.log(`${colors.magenta}📋 get_rooms solicitado${colors.reset}`);
    socket.emit('room_list', Array.from(rooms.values()));
  });

  // 👥 Lista de usuarios
  socket.on('get_room_users', (roomName) => {
    if (!roomName || !rooms.has(roomName)) return;
    const users = Array.from(rooms.get(roomName).users)
      .map((id) => connectedUsers.get(id))
      .filter(Boolean);
    console.log(`${colors.magenta}👥 Enviando usuarios de sala:${colors.reset}`, roomName);
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
  socket.on('send_message', async (data) => {
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

  // 🎧 Mensajes de audio
  socket.on('audio_message', async (data) => {
    const { userId, username, audioData, roomId } = data;
    if (!audioData || !userId || !roomId) return;

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
      io.emit('user-list', Array.from(connectedUsers.values()));
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
