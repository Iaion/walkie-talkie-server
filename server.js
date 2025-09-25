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

const connectedUsers = new Map();

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

// WebSocket (Socket.IO)
io.on('connection', (socket) => {
  console.log(`✅ Usuario conectado: ${socket.id}`);

  // Manejar el evento de inicio de sesión
  socket.on('userConnected', async ({ username, userId }) => {
    if (!username || !userId) {
      console.error('❌ Error: Nombre de usuario o ID no proporcionados.');
      return;
    }
    const user = { id: userId, username, socketId: socket.id };
    connectedUsers.set(socket.id, user);

    // Guardar el usuario en Firestore si no existe
    const userRef = db.collection(USERS_COLLECTION).doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      await userRef.set(user);
    }

    console.log(`👤 ${username} se unió al chat general (Socket: ${socket.id})`);
    io.emit('userJoined', user);
  });

  // Manejar el envío de mensajes de texto
  socket.on('sendMessage', async ({ userId, username, text }) => {
    if (!text || !userId || !username) return;

    const newMessage = {
      userId,
      username,
      text,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };
    await db.collection(MESSAGES_COLLECTION).add(newMessage);
    io.emit('newMessage', newMessage);
  });

  // Manejar el envío de mensajes de audio
  socket.on('sendAudioMessage', async ({ userId, username, audioData, audioExtension }) => {
    try {
      console.log(`✅ Recibiendo mensaje de audio de ${username} (ID de usuario: ${userId})`);

      if (!audioData || !audioExtension) {
        throw new Error('Datos de audio o extensión no proporcionados.');
      }

      const fileExtension = audioExtension.startsWith('.') ? audioExtension : `.${audioExtension}`;
      const uniqueFileName = `audios/${userId}_${Date.now()}_${uuidv4()}${fileExtension}`;
      const file = bucket.file(uniqueFileName);

      // Subir el archivo de audio a Firebase Storage
      await file.save(audioData, {
        contentType: `audio/${audioExtension.replace('.', '')}`, // ej. 'audio/m4a'
        resumable: false // No usar subidas resumables para archivos pequeños
      });

      // Obtener la URL pública para el audio
      const [url] = await file.getSignedUrl({
        action: 'read',
        expires: '03-09-2491', // Una fecha de expiración muy lejana
      });

      const audioMessage = {
        userId,
        username,
        audioUrl: url, // ✅ Enviamos la URL de Firebase Storage
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      };

      await db.collection(MESSAGES_COLLECTION).add(audioMessage);
      io.emit('newMessage', audioMessage);
      console.log(`✅ Audio de ${username} subido y compartido. URL: ${url}`);
    } catch (error) {
      console.error('❌ Error al procesar el mensaje de audio:', error);
      // Notificar al cliente si algo sale mal
      socket.emit('audioUploadError', { message: 'Error al subir el audio.' });
    }
  });

  // Manejar la desconexión
  socket.on('disconnect', () => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      connectedUsers.delete(socket.id);
      console.log(`❌ Usuario desconectado: ${user.username} (Razón: ${socket.reason})`);
      io.emit('userLeft', user);
    } else {
      console.log(`❌ Usuario desconectado: ${socket.id} (Razón: ${socket.reason})`);
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🚀 Servidor Express con Socket.IO ejecutándose en el puerto ${PORT}`);
  console.log('📍 URL local: http://localhost:8080');
  console.log(`📍 URL red: http://10.250.16.44:${PORT}`);
  console.log('📊 Estado: http://localhost:8080/health');
  console.log('👥 Usuarios: http://localhost:8080/users');
  console.log('🐛 Debug: http://localhost:8080/debug');
  console.log('💬 Funcionalidades implementadas:');
  console.log('   - Chat en tiempo real');
  console.log('   - Lista de usuarios conectados');
  console.log('   - Compartir audio');
  console.log('   - API REST para monitoreo');
  console.log('   - CORS configurado para desarrollo');
});
