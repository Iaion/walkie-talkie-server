// Servidor Node.js con Socket.IO, Firebase Firestore y Storage

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');
const { Buffer } = require('buffer'); // Manejo de audio

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 1e8, // 100 MB
});

// Configura CORS
app.use(cors());

// Variables de entorno requeridas
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('❌ Falta GOOGLE_APPLICATION_CREDENTIALS');
  process.exit(1);
}
if (!process.env.FIREBASE_STORAGE_BUCKET) {
  console.error('❌ Falta FIREBASE_STORAGE_BUCKET');
  process.exit(1);
}

// Inicializar Firebase
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
  console.log('✅ Firebase Admin inicializado.');
} catch (error) {
  console.error('❌ Error al parsear credenciales Firebase:', error);
  process.exit(1);
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

const USERS_COLLECTION = 'users';
const MESSAGES_COLLECTION = 'messages';

// Gestión de usuarios y salas
const connectedUsers = new Map(); 
const socketToUserMap = new Map(); 
const userToRoomMap = new Map(); 

const rooms = new Map();
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
  description: 'Simulación PTT',
  users: new Set(),
  currentSpeaker: null,
});

// Middleware de log
app.use((req, _, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Rutas REST
app.get('/health', (_, res) => res.status(200).send('Servidor operativo.'));
app.get('/users', (_, res) => res.status(200).json(Array.from(connectedUsers.values())));
app.get('/rooms', (_, res) => {
  res.status(200).json(Array.from(rooms.values()).map(room => ({
    id: room.id,
    name: room.name,
    description: room.description,
    userCount: room.users.size,
    type: room.id === GENERAL_ROOM_ID ? 'general' : 'ptt',
    currentSpeaker: room.currentSpeaker || null,
  })));
});

// WebSocket
io.on('connection', (socket) => {
  console.log(`✅ Usuario conectado: ${socket.id}`);

  socket.on('user-connected', async (user) => {
    console.log('🎯 user-connected:', user);
    if (!user?.id || !user?.username) return;

    socketToUserMap.set(socket.id, user.id);
    connectedUsers.set(user.id, { ...user, socketId: socket.id, isOnline: true });

    try {
      await db.collection(USERS_COLLECTION).doc(user.id).set(user, { merge: true });
    } catch (err) {
      console.error('❌ Error guardando usuario:', err);
    }

    io.emit('user-list', Array.from(connectedUsers.values()));
    socket.emit('room-list', Array.from(rooms.values()).map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      userCount: r.users.size,
      type: r.id === GENERAL_ROOM_ID ? 'general' : 'ptt',
      currentSpeaker: r.currentSpeaker || null,
    })));
  });

  // Función auxiliar
  const leaveCurrentRoom = (userId, socket) => {
    const prevRoomId = userToRoomMap.get(userId);
    if (!prevRoomId || !rooms.has(prevRoomId)) return;

    const prevRoom = rooms.get(prevRoomId);
    prevRoom.users.delete(userId);
    socket.leave(prevRoomId);

    if (prevRoomId === HANDY_ROOM_ID && prevRoom.currentSpeaker === userId) {
      prevRoom.currentSpeaker = null;
      io.to(HANDY_ROOM_ID).emit('talk_token_released', { roomId: HANDY_ROOM_ID, currentSpeaker: null });
    }

    io.to(prevRoomId).emit('user-left-room', { roomId: prevRoomId, userCount: prevRoom.users.size });
  };

  // --- join_general_chat ---
  socket.on('join_general_chat', (userData) => {
    const { userId, username } = userData;
    if (!userId || !username) return;

    leaveCurrentRoom(userId, socket);

    socket.join(GENERAL_ROOM_ID);
    rooms.get(GENERAL_ROOM_ID).users.add(userId);
    userToRoomMap.set(userId, GENERAL_ROOM_ID);

    console.log(`👤 ${username} se unió a General.`);

    const roomUsers = Array.from(rooms.get(GENERAL_ROOM_ID).users)
      .map(id => connectedUsers.get(id))
      .filter(Boolean);

    socket.emit('join_success', {
      message: 'Te uniste al chat General.',
      users: roomUsers,
      currentSpeaker: rooms.get(GENERAL_ROOM_ID).currentSpeaker,
    });

    io.to(GENERAL_ROOM_ID).emit('user-joined-room', {
      roomId: GENERAL_ROOM_ID,
      userCount: rooms.get(GENERAL_ROOM_ID).users.size,
    });
  });

  // --- join_handy_chat ---
  socket.on('join_handy_chat', (userData) => {
    const { userId, username } = userData;
    if (!userId || !username) return;

    leaveCurrentRoom(userId, socket);

    socket.join(HANDY_ROOM_ID);
    rooms.get(HANDY_ROOM_ID).users.add(userId);
    userToRoomMap.set(userId, HANDY_ROOM_ID);

    console.log(`👤 ${username} se unió a Handy.`);

    const roomUsers = Array.from(rooms.get(HANDY_ROOM_ID).users)
      .map(id => connectedUsers.get(id))
      .filter(Boolean);

    socket.emit('join_success', {
      message: 'Te uniste a Handy (PTT).',
      users: roomUsers,
      currentSpeaker: rooms.get(HANDY_ROOM_ID).currentSpeaker,
    });

    io.to(HANDY_ROOM_ID).emit('user-joined-room', {
      roomId: HANDY_ROOM_ID,
      userCount: rooms.get(HANDY_ROOM_ID).users.size,
    });
  });

  // --- Token PTT ---
  socket.on('request_talk_token', ({ userId, roomId }) => {
    if (roomId !== HANDY_ROOM_ID || !userId) return;
    const room = rooms.get(roomId);
    if (!room || !connectedUsers.has(userId)) return;

    if (!room.currentSpeaker) {
      room.currentSpeaker = userId;
      io.to(roomId).emit('talk_token_granted', { roomId, currentSpeaker: userId });
    } else if (room.currentSpeaker !== userId) {
      socket.emit('talk_token_denied', { roomId, currentSpeaker: room.currentSpeaker });
    }
  });

  socket.on('release_talk_token', ({ userId, roomId }) => {
    if (roomId !== HANDY_ROOM_ID || !userId) return;
    const room = rooms.get(roomId);
    if (room?.currentSpeaker === userId) {
      room.currentSpeaker = null;
      io.to(roomId).emit('talk_token_released', { roomId, currentSpeaker: null });
    }
  });

  // --- Mensajes ---
  socket.on('send_message', async ({ userId, username, text, roomId }) => {
    if (!text || !userId || !username || !roomId) return;

    const newMessage = {
      id: uuidv4(),
      userId,
      username,
      text,
      roomId,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    };

    try {
      await db.collection(MESSAGES_COLLECTION).add(newMessage);
      io.to(roomId).emit('new_message', newMessage);
    } catch (err) {
      console.error('❌ Error guardando mensaje:', err);
    }
  });

  socket.on('audio_message', async ({ userId, username, audioData, roomId }) => {
    if (!audioData || !userId || !username || !roomId) return;

    if (roomId === HANDY_ROOM_ID) {
      const room = rooms.get(roomId);
      if (!room || room.currentSpeaker !== userId) {
        socket.emit('audio_transmission_failed', { message: 'No tienes el token PTT.' });
        return;
      }
    }

    try {
      const buffer = Buffer.from(audioData, 'base64');
      const uniqueFileName = `audios/${roomId}/${userId}_${Date.now()}_${uuidv4()}.m4a`;
      const file = bucket.file(uniqueFileName);

      await file.save(buffer, { contentType: 'audio/m4a', resumable: false });
      await file.makePublic();
      const url = file.publicUrl();

      const audioMessage = {
        id: uuidv4(),
        userId,
        username,
        audioUrl: url,
        roomId,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      };

      await db.collection(MESSAGES_COLLECTION).add(audioMessage);
      io.to(roomId).emit('new_message', audioMessage);
    } catch (err) {
      console.error('❌ Error audio:', err);
      socket.emit('audioUploadError', { message: 'Error al subir el audio.' });
    }
  });

  // --- Desconexión ---
  socket.on('disconnect', () => {
    const userId = socketToUserMap.get(socket.id);
    if (userId) {
      const user = connectedUsers.get(userId);
      if (user?.socketId === socket.id) {
        leaveCurrentRoom(userId, socket);
        connectedUsers.delete(userId);
        userToRoomMap.delete(userId);
        io.emit('user-list', Array.from(connectedUsers.values()));
      }
      socketToUserMap.delete(socket.id);
    }
    console.log(`🔴 Socket desconectado: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
});
