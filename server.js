// Servidor Node.js con Socket.IO, Firebase Firestore y Storage

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');
const { Buffer } = require('buffer'); // Importar Buffer para manejo de audio

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
// ALMACENA: userId -> { id, username, socketId } (Mantiene la info única del usuario)
const connectedUsers = new Map(); 
// ✅ NUEVA ESTRUCTURA CRÍTICA: socketId -> userId (Permite mapear la desconexión al usuario)
const socketToUserMap = new Map(); 

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
  // Solo devuelve usuarios que están marcados como "conectados"
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

    // 1. Mapear el socket actual al ID del usuario (CLAVE para la desconexión)
    socketToUserMap.set(socket.id, user.id); 

    // 2. Almacenar el usuario único (clave: user.id). Esto sobrescribe el socketId anterior si se reconecta.
    connectedUsers.set(user.id, { ...user, socketId: socket.id, isOnline: true });
    
    // 3. Guardar en Firestore
    const userRef = db.collection(USERS_COLLECTION).doc(user.id);
    try {
      await userRef.set(user, { merge: true });
      console.log(`✅ Usuario ${user.username} guardado/actualizado en Firestore.`);
    } catch (error) {
      console.error('❌ Error al guardar usuario en Firestore:', error);
    }
    
    console.log(`👤 ${user.username} se ha conectado.`);
    // 4. Envía la lista de usuarios y salas al cliente
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
    // Enviar la lista de usuarios de la sala (solo IDs en este caso)
    socket.emit('join_success', { 
        message: 'Te has unido a la sala general.', 
        users: Array.from(rooms.get(GENERAL_ROOM_ID).users) 
    });
    // Notificar a la sala del cambio de conteo
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
      // Usamos .m4a que es un formato común para AAC (codec de Android)
      const uniqueFileName = `audios/${roomId}/${userId}_${Date.now()}_${uuidv4()}.m4a`;
      const file = bucket.file(uniqueFileName);

      // Subir el archivo de audio a Firebase Storage
      await file.save(audioDataBuffer, {
        contentType: 'audio/m4a',
        resumable: false
      });

      // ✅ CORRECCIÓN: Hacer el archivo público y obtener la URL de acceso directo
      await file.makePublic();
      const url = file.publicUrl();

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
    // 1. Obtener el userId usando el nuevo mapa (CRÍTICO)
    const userId = socketToUserMap.get(socket.id);
    
    if (userId) {
        const user = connectedUsers.get(userId);
        
        // 2. Solo proceder si el socket ID que se desconecta es el último que se registró (para evitar desconexiones accidentales)
        if (user && user.socketId === socket.id) { 
            // 3. Eliminar usuario de la sala actual
            const prevRoomId = userToRoomMap.get(userId);
            if (prevRoomId && rooms.has(prevRoomId)) {
                rooms.get(prevRoomId).users.delete(userId);
                io.to(prevRoomId).emit('user-left-room', { roomId: prevRoomId, userCount: rooms.get(prevRoomId).users.size });
            }
            
            // 4. Eliminar del mapa de usuarios conectados únicos
            connectedUsers.delete(userId);
            userToRoomMap.delete(userId);
            
            console.log(`❌ Usuario desconectado: ${user.username} (Razón: ${socket.reason})`);
            
            // 5. Emitir la lista actualizada de usuarios
            io.emit('user-list', Array.from(connectedUsers.values()));
        } else if (user) {
            console.log(`⚠️ Socket secundario ${socket.id} de ${user.username} desconectado. El usuario sigue conectado.`);
        }
        
        // 6. Eliminar el mapeo del socket
        socketToUserMap.delete(socket.id);

    } else {
      console.log(`❌ Usuario desconocido desconectado: ${socket.id} (Razón: ${socket.reason})`);
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
  console.log('   - Compartir audio (con Firebase Storage)');
  console.log('   - API REST para monitoreo');
  console.log('   - CORS configurado para desarrollo');
});
