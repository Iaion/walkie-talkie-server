const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*', // Permite todas las solicitudes CORS
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 1e8, // 100 MB
});

// Configura CORS para Express
app.use(cors());

// Verificar si las variables de entorno están configuradas
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('❌ ERROR: La variable de entorno GOOGLE_APPLICATION_CREDENTIALS no está configurada.');
  process.exit(1);
}
if (!process.env.FIREBASE_STORAGE_BUCKET) {
  console.error('❌ ERROR: La variable de entorno FIREBASE_STORAGE_BUCKET no está configurada.');
  process.exit(1);
}

// Inicializar Firebase Admin SDK con la variable de entorno JSON
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET
  });
  console.log('✅ Firebase Admin SDK inicializado correctamente.');
} catch (error) {
  console.error('❌ ERROR: Error al parsear las credenciales de Firebase. Asegúrate de que el valor de la variable de entorno GOOGLE_APPLICATION_CREDENTIALS sea un JSON válido.');
  console.error(error);
  process.exit(1);
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

const USERS_COLLECTION = 'users';
const MESSAGES_COLLECTION = 'messages';

// ✅ Nuevas estructuras para la gestión de salas
const connectedUsers = new Map(); // Mapa de socket.id -> { id, username }
const rooms = new Map(); // Mapa de roomId -> { name, users: Set(userId) }
const userToRoomMap = new Map(); // Mapa de userId -> roomId

// Inicializar la sala general
const GENERAL_ROOM_ID = 'general';
rooms.set(GENERAL_ROOM_ID, {
  id: GENERAL_ROOM_ID,
  name: 'Chat General',
  description: 'Sala de chat público',
  users: new Set(),
});

// Middleware para el log de peticiones
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Rutas de la API REST
app.get('/health', (req, res) => res.status(200).send('Servidor operativo.'));
app.get('/users', (req, res) => {
  const usersArray = Array.from(connectedUsers.values());
  res.status(200).json(usersArray);
});
app.get('/rooms', (req, res) => {
  const roomsArray = Array.from(rooms.values()).map(room => ({
    id: room.id,
    name: room.name,
    description: room.description,
    userCount: room.users.size,
    type: 'general'
  }));
  res.status(200).json(roomsArray);
});

// WebSocket (Socket.IO)
io.on('connection', (socket) => {
  console.log(`✅ Usuario conectado: ${socket.id}`);

  // Manejar el evento de inicio de sesión
  socket.on('user-connected', async (userData) => {
    const user = JSON.parse(userData);
    if (!user || !user.id || !user.username) {
      console.error('❌ Error: Datos de usuario no válidos.');
      return;
    }
    connectedUsers.set(user.id, { ...user, socketId: socket.id });

    // Guardar el usuario en Firestore si no existe
    const userRef = db.collection(USERS_COLLECTION).doc(user.id);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      await userRef.set(user);
    }
    
    console.log(`👤 ${user.username} se ha conectado.`);
    // Envía la lista de usuarios y salas al cliente
    io.emit('user-list', Array.from(connectedUsers.values()));
    socket.emit('room-list', Array.from(rooms.values()).map(room => ({
      id: room.id,
      name: room.name,
      description: room.description,
      userCount: room.users.size,
      type: room.id === 'general' ? 'general' : 'private'
    })));
  });

  // ✅ Manejar unión a la sala general
  socket.on('join_general_chat', (userData) => {
    const { userId, username } = JSON.parse(userData);
    if (!userId || !username) {
      console.error('❌ join_general_chat: Usuario o username no definidos.');
      return;
    }

    // Eliminar usuario de la sala anterior si existe
    const prevRoomId = userToRoomMap.get(userId);
    if (prevRoomId && rooms.has(prevRoomId)) {
      rooms.get(prevRoomId).users.delete(userId);
      socket.leave(prevRoomId);
      io.to(prevRoomId).emit('user-left-room', { roomId: prevRoomId, userCount: rooms.get(prevRoomId).users.size });
    }

    // Unir a la sala general
    socket.join(GENERAL_ROOM_ID);
    rooms.get(GENERAL_ROOM_ID).users.add(userId);
    userToRoomMap.set(userId, GENERAL_ROOM_ID);

    console.log(`👤 ${username} se ha unido a la sala general.`);
    socket.emit('join_success', { message: 'Te has unido a la sala general.', users: Array.from(rooms.get(GENERAL_ROOM_ID).users) });
    io.to(GENERAL_ROOM_ID).emit('user-joined-room', { roomId: GENERAL_ROOM_ID, userCount: rooms.get(GENERAL_ROOM_ID).users.size });
  });

  // ✅ Manejar el envío de mensajes de texto
  socket.on('send_message', async ({ userId, username, text, roomId }) => {
    if (!text || !userId || !username || !roomId) return;

    const newMessage = {
      id: uuidv4(),
      userId,
      username,
      text,
      roomId,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection(MESSAGES_COLLECTION).add(newMessage);
    io.to(roomId).emit('new_message', newMessage);
  });

  // ✅ Manejar el envío de mensajes de audio (Base64)
  socket.on('audio_message', async ({ userId, username, audioData, roomId }) => {
    try {
      console.log(`✅ Recibiendo mensaje de audio de ${username} para la sala ${roomId}`);

      if (!audioData || !userId || !username || !roomId) {
        throw new Error('Datos de audio o de la sala no proporcionados.');
      }

      // ✅ Decodificar la cadena Base64 a un buffer binario
      const audioDataBuffer = Buffer.from(audioData, 'base64');
      const uniqueFileName = `audios/${roomId}/${userId}_${Date.now()}_${uuidv4()}.m4a`;
      const file = bucket.file(uniqueFileName);

      // Subir el archivo de audio a Firebase Storage
      await file.save(audioDataBuffer, {
        contentType: 'audio/m4a',
        resumable: false
      });

      // Obtener la URL pública para el audio
      const [url] = await file.getSignedUrl({
        action: 'read',
        expires: '03-09-2491',
      });

      const audioMessage = {
        id: uuidv4(),
        userId,
        username,
        audioUrl: url,
        roomId,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      };

      await db.collection(MESSAGES_COLLECTION).add(audioMessage);
      io.to(roomId).emit('new_message', audioMessage);
      console.log(`✅ Audio de ${username} subido y compartido. URL: ${url}`);
    } catch (error) {
      console.error('❌ Error al procesar el mensaje de audio:', error);
      socket.emit('audioUploadError', { message: 'Error al subir el audio.' });
    }
  });

  // ✅ Manejar la desconexión
  socket.on('disconnect', () => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      // Eliminar usuario de la sala actual
      const prevRoomId = userToRoomMap.get(user.id);
      if (prevRoomId && rooms.has(prevRoomId)) {
        rooms.get(prevRoomId).users.delete(user.id);
        io.to(prevRoomId).emit('user-left-room', { roomId: prevRoomId, userCount: rooms.get(prevRoomId).users.size });
      }
      
      connectedUsers.delete(socket.id);
      userToRoomMap.delete(user.id);
      console.log(`❌ Usuario desconectado: ${user.username} (Razón: ${socket.reason})`);
      io.emit('user-left', user);
    } else {
      console.log(`❌ Usuario desconectado: ${socket.id} (Razón: ${socket.reason})`);
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🚀 Servidor Express con Socket.IO ejecutándose en el puerto ${PORT}`);
  console.log('📍 URL local: http://localhost:8080');
  console.log('📊 Estado: http://localhost:8080/health');
  console.log('👥 Usuarios: http://localhost:8080/users');
  console.log('🚪 Salas: http://localhost:8080/rooms');
  console.log('💬 Funcionalidades implementadas:');
  console.log('   - Chat en tiempo real');
  console.log('   - Gestión de salas de chat');
  console.log('   - Compartir audio (con Base64)');
  console.log('   - API REST para monitoreo');
  console.log('   - CORS configurado para desarrollo');
});
