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

// Estructuras para la gestión de salas
const connectedUsers = new Map(); 
const socketToUserMap = new Map(); 

const rooms = new Map(); // Mapa de roomId -> { name, users: Set(userId), currentSpeaker: string | null }
const userToRoomMap = new Map(); // Mapa de userId -> roomId

// Inicializar Sala General
const GENERAL_ROOM_ID = 'general';
rooms.set(GENERAL_ROOM_ID, {
  id: GENERAL_ROOM_ID,
  name: 'Chat General',
  description: 'Sala de chat público',
  users: new Set(),
  currentSpeaker: null, // No se usa en General, pero mantiene la estructura.
});

// ✅ Inicializar Sala Handy (PTT)
const HANDY_ROOM_ID = 'handy';
rooms.set(HANDY_ROOM_ID, {
  id: HANDY_ROOM_ID,
  name: 'Radio Handy (PTT)',
  description: 'Simulación de radio VHF (Push-To-Talk)',
  users: new Set(),
  currentSpeaker: null, // CRÍTICO: Rastrea el userId que tiene el token para hablar.
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
    type: room.id === GENERAL_ROOM_ID ? 'general' : 'ptt', // Diferenciar la sala PTT
    currentSpeaker: room.currentSpeaker || null // Incluir el estado del hablante
  }));
  res.status(200).json(roomsArray);
});

// WebSocket (Socket.IO)
io.on('connection', (socket) => {
  console.log(`✅ Usuario conectado: ${socket.id}`);

  // Manejar el evento de inicio de sesión
  socket.on('user-connected', async (userData) => {
    console.log('🎯 RECIBIENDO user-connected:', userData);
    
    // ✅ CORRECCIÓN: Socket.IO ya parsea automáticamente los JSON
    const user = userData; // Ya es un objeto, no necesita JSON.parse()
    
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
      type: room.id === GENERAL_ROOM_ID ? 'general' : 'ptt',
      currentSpeaker: room.currentSpeaker || null
    })));
  });

  // ✅ Función auxiliar para manejar la salida de sala y limpieza de token
  const leaveCurrentRoom = (userId, socket) => {
    const prevRoomId = userToRoomMap.get(userId);
    if (prevRoomId && rooms.has(prevRoomId)) {
      const prevRoom = rooms.get(prevRoomId);
      prevRoom.users.delete(userId);
      socket.leave(prevRoomId);
      
      // Lógica de liberación de token PTT si estaba hablando
      if (prevRoomId === HANDY_ROOM_ID && prevRoom.currentSpeaker === userId) {
          prevRoom.currentSpeaker = null;
          io.to(HANDY_ROOM_ID).emit('talk_token_released', { roomId: HANDY_ROOM_ID, currentSpeaker: null });
          console.log(`🔇 Token PTT liberado por ${userId} al cambiar de sala.`);
      }
      
      io.to(prevRoomId).emit('user-left-room', { roomId: prevRoomId, userCount: prevRoom.users.size });
    }
  };

  // ✅✅✅ CORREGIDO: join_general_chat - CON ENVÍO EXPLÍCITO DE join_success
  socket.on('join_general_chat', (userData) => {
    console.log('🎯🎯🎯 RECIBIENDO join_general_chat:', userData);
    
    const { userId, username } = userData;
    
    if (!userId || !username) {
        console.error('❌ join_general_chat: Usuario o username no definidos.');
        return;
    }

    // Eliminar usuario de la sala anterior y limpiar token
    leaveCurrentRoom(userId, socket);

    // Unir a la sala general
    socket.join(GENERAL_ROOM_ID);
    rooms.get(GENERAL_ROOM_ID).users.add(userId);
    userToRoomMap.set(userId, GENERAL_ROOM_ID);

    console.log(`👤 ${username} se ha unido a la sala general.`);
    
    // ✅ CORREGIDO: Enviar usuarios COMPLETOS, no solo IDs
    const roomUsers = Array.from(rooms.get(GENERAL_ROOM_ID).users).map(userId => {
        const user = connectedUsers.get(userId);
        return user ? {
            id: user.id,
            username: user.username,
            isOnline: true,
            status: "Online", 
            presence: "Available"
        } : null;
    }).filter(user => user !== null);
    
    // ✅✅✅ CRÍTICO CORREGIDO: ENVÍO EXPLÍCITO CON DEBUG
    const joinSuccessData = { 
        message: 'Te has unido a la sala General.', 
        roomId: GENERAL_ROOM_ID,
        users: roomUsers,
        currentSpeaker: rooms.get(GENERAL_ROOM_ID).currentSpeaker,
        userCount: rooms.get(GENERAL_ROOM_ID).users.size
    };
    
    console.log('📤📤📤 ENVIANDO join_success AL CLIENTE:');
    console.log('   - Socket ID destino:', socket.id);
    console.log('   - Usuario destino:', username);
    console.log('   - Datos a enviar:', JSON.stringify(joinSuccessData, null, 2));
    
    // ✅✅✅ ENVIAR join_success EXPLÍCITAMENTE
    socket.emit('join_success', joinSuccessData);
    
    console.log('✅✅✅ join_success ENVIADO EXITOSAMENTE');
    
    // Notificar a la sala del cambio de conteo
    io.to(GENERAL_ROOM_ID).emit('user-joined-room', { 
        roomId: GENERAL_ROOM_ID, 
        userCount: rooms.get(GENERAL_ROOM_ID).users.size 
    });
    
    console.log(`✅ join_general_chat COMPLETADO para: ${username}`);
  });

  // ✅✅✅ CORREGIDO: join_handy_chat - CON ENVÍO EXPLÍCITO DE join_success
  socket.on('join_handy_chat', (userData) => {
    console.log('🎯🎯🎯 RECIBIENDO join_handy_chat:', userData);
    
    const { userId, username } = userData;
    
    if (!userId || !username) {
      console.error('❌ join_handy_chat: Usuario o username no definidos.');
      return;
    }

    // Eliminar usuario de la sala anterior y limpiar token
    leaveCurrentRoom(userId, socket);

    // Unir a la sala handy
    socket.join(HANDY_ROOM_ID);
    rooms.get(HANDY_ROOM_ID).users.add(userId);
    userToRoomMap.set(userId, HANDY_ROOM_ID);

    console.log(`👤 ${username} se ha unido a la sala Handy (PTT).`);
    
    // ✅ CORREGIDO: Enviar usuarios COMPLETOS, no solo IDs
    const roomUsers = Array.from(rooms.get(HANDY_ROOM_ID).users).map(userId => {
        const user = connectedUsers.get(userId);
        return user ? {
            id: user.id,
            username: user.username,
            isOnline: true,
            status: "Online", 
            presence: "Available"
        } : null;
    }).filter(user => user !== null);
    
    // ✅✅✅ CRÍTICO CORREGIDO: ENVÍO EXPLÍCITO CON DEBUG
    const joinSuccessData = { 
        message: 'Te has unido a la sala Handy (PTT).', 
        roomId: HANDY_ROOM_ID,
        users: roomUsers,
        currentSpeaker: rooms.get(HANDY_ROOM_ID).currentSpeaker,
        userCount: rooms.get(HANDY_ROOM_ID).users.size
    };
    
    console.log('📤📤📤 ENVIANDO join_success AL CLIENTE:');
    console.log('   - Socket ID destino:', socket.id);
    console.log('   - Usuario destino:', username);
    console.log('   - Datos a enviar:', JSON.stringify(joinSuccessData, null, 2));
    
    // ✅✅✅ ENVIAR join_success EXPLÍCITAMENTE
    socket.emit('join_success', joinSuccessData);
    
    console.log('✅✅✅ join_success ENVIADO EXITOSAMENTE');
    
    io.to(HANDY_ROOM_ID).emit('user-joined-room', { 
        roomId: HANDY_ROOM_ID, 
        userCount: rooms.get(HANDY_ROOM_ID).users.size 
    });
    
    console.log(`✅ join_handy_chat COMPLETADO para: ${username}`);
  });

  // ✅✅✅ NUEVO: Manejar join_room (compatible con Android)
  socket.on('join_room', (data) => {
    console.log('🎯🎯🎯 RECIBIENDO join_room:', data);
    
    const { room, userId, username } = data;
    
    if (!room || !userId || !username) {
        console.error('❌ join_room: Datos incompletos');
        console.error('   - room:', room);
        console.error('   - userId:', userId);
        console.error('   - username:', username);
        socket.emit('join_error', { message: 'Datos de unión incompletos' });
        return;
    }

    // Validar que la sala existe
    if (!rooms.has(room)) {
        console.error('❌ join_room: Sala no existe:', room);
        socket.emit('join_error', { message: `La sala ${room} no existe` });
        return;
    }

    console.log(`🔄 Uniendo usuario ${username} a sala: ${room}`);

    // Eliminar usuario de la sala anterior y limpiar token
    leaveCurrentRoom(userId, socket);

    // Unir a la nueva sala
    socket.join(room);
    rooms.get(room).users.add(userId);
    userToRoomMap.set(userId, room);

    console.log(`👤 ${username} se ha unido a la sala ${room}.`);
    
    // Obtener usuarios completos de la sala
    const roomUsers = Array.from(rooms.get(room).users).map(userId => {
        const user = connectedUsers.get(userId);
        return user ? {
            id: user.id,
            username: user.username,
            isOnline: true,
            status: "Online", 
            presence: "Available"
        } : null;
    }).filter(user => user !== null);
    
    // ✅✅✅ ENVÍO EXPLÍCITO DE join_success
    const joinSuccessData = { 
        message: `Te has unido a la sala ${room}.`, 
        room: room,
        users: roomUsers,
        currentSpeaker: rooms.get(room).currentSpeaker,
        userCount: rooms.get(room).users.size
    };
    
    console.log('📤📤📤 ENVIANDO join_success AL CLIENTE:');
    console.log('   - Socket ID destino:', socket.id);
    console.log('   - Usuario destino:', username);
    console.log('   - Sala:', room);
    console.log('   - Datos a enviar:', JSON.stringify(joinSuccessData, null, 2));
    
    // ✅✅✅ ENVIAR join_success EXPLÍCITAMENTE
    socket.emit('join_success', joinSuccessData);
    
    console.log('✅✅✅ join_success ENVIADO EXITOSAMENTE');
    
    // Notificar a la sala del cambio de conteo
    io.to(room).emit('user-joined-room', { 
        roomId: room, 
        userCount: rooms.get(room).users.size 
    });
    
    console.log(`✅ join_room COMPLETADO para: ${username} en sala: ${room}`);
  });

  // ✅✅✅ NUEVO: Manejar get_rooms (compatible con Android)
  socket.on('get_rooms', () => {
    console.log('🎯 RECIBIENDO get_rooms de:', socket.id);
    
    const roomsArray = Array.from(rooms.values()).map(room => ({
        id: room.id,
        name: room.name,
        description: room.description,
        userCount: room.users.size,
        type: room.id === GENERAL_ROOM_ID ? 'general' : 'ptt',
        currentSpeaker: room.currentSpeaker || null
    }));
    
    console.log('📤 Enviando room_list con salas:', roomsArray.length);
    socket.emit('room_list', roomsArray);
  });

  // ✅✅✅ NUEVO: Manejar get_room_users (compatible con Android)
  socket.on('get_room_users', (roomName) => {
    console.log('🎯 RECIBIENDO get_room_users para sala:', roomName);
    
    if (!roomName || !rooms.has(roomName)) {
        console.error('❌ get_room_users: Sala no existe:', roomName);
        return;
    }
    
    const roomUsers = Array.from(rooms.get(roomName).users).map(userId => {
        const user = connectedUsers.get(userId);
        return user ? {
            id: user.id,
            username: user.username,
            isOnline: true,
            status: "Online", 
            presence: "Available"
        } : null;
    }).filter(user => user !== null);
    
    console.log('📤 Enviando users_list para sala:', roomName, '- Usuarios:', roomUsers.length);
    socket.emit('users_list', roomUsers);
  });

  // ✅✅✅ NUEVO: Manejar get_all_users (compatible con Android)
  socket.on('get_all_users', () => {
    console.log('🎯 RECIBIENDO get_all_users de:', socket.id);
    
    const allUsers = Array.from(connectedUsers.values()).map(user => ({
        id: user.id,
        username: user.username,
        isOnline: true,
        status: "Online",
        presence: "Available"
    }));
    
    console.log('📤 Enviando connected_users - Total usuarios:', allUsers.length);
    socket.emit('connected_users', allUsers);
  });

  // --- Lógica PTT (Token de Palabra) ---

  // ✅ NUEVO: Manejar solicitud del token de palabra (PTT Press)
  socket.on('request_talk_token', (data) => {
    console.log('🎯 RECIBIENDO request_talk_token:', data);
    
    const { userId, roomId } = data;
    
    // Solo aplica a la sala PTT
    if (roomId !== HANDY_ROOM_ID || !userId) return;

    const room = rooms.get(roomId);
    if (!room || !connectedUsers.has(userId)) return;

    if (room.currentSpeaker === null) {
        // Token concedido (Usuario empieza a hablar)
        room.currentSpeaker = userId;
        const username = connectedUsers.get(userId)?.username || userId;
        console.log(`🎙️ ${username} ha tomado el token de palabra en ${roomId}.`);
        
        // Notificar a todos en la sala (incluido el emisor)
        io.to(roomId).emit('talk_token_granted', { 
            roomId, 
            currentSpeaker: userId, 
            username
        });
    } else if (room.currentSpeaker !== userId) {
        // Token denegado (Alguien más está hablando)
        console.log(`🚫 ${userId} intentó hablar, pero ${room.currentSpeaker} ya tiene el token.`);
        socket.emit('talk_token_denied', { 
            roomId, 
            currentSpeaker: room.currentSpeaker 
        });
    }
  });

  // ✅ NUEVO: Manejar liberación del token de palabra (PTT Release)
  socket.on('release_talk_token', (data) => {
    console.log('🎯 RECIBIENDO release_talk_token:', data);
    
    const { userId, roomId } = data;
    
    // Solo aplica a la sala PTT
    if (roomId !== HANDY_ROOM_ID || !userId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    if (room.currentSpeaker === userId) {
        // Token liberado
        room.currentSpeaker = null;
        console.log(`🔇 ${userId} ha liberado el token de palabra en ${roomId}.`);
        
        // Notificar a todos en la sala
        io.to(roomId).emit('talk_token_released', { 
            roomId, 
            currentSpeaker: null 
        });
    }
  });

  // ----------------------------------------

  // ✅ Manejar el envío de mensajes de texto
  socket.on('send_message', async (data) => {
    console.log('🎯🎯🎯 RECIBIENDO send_message:', data);
    
    const { userId, username, text, roomId } = data;
    
    if (!text || !userId || !username || !roomId) {
      console.error('❌ send_message: Datos incompletos');
      console.error('   - userId:', userId);
      console.error('   - username:', username);
      console.error('   - text:', text);
      console.error('   - roomId:', roomId);
      return;
    }

    const newMessage = {
      id: uuidv4(),
      userId,
      username,
      text,
      roomId,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };

    console.log('📝 CREANDO NUEVO MENSAJE:', newMessage);

    try {
      await db.collection(MESSAGES_COLLECTION).add(newMessage);
      console.log('💾 Mensaje guardado en Firestore');
      
      console.log('📤📤📤 EMITIENDO new_message a sala:', roomId);
      console.log('📦 Datos a emitir:', newMessage);
      
      io.to(roomId).emit('new_message', newMessage);
      console.log('✅✅✅ new_message ENVIADO CORRECTAMENTE');
      
    } catch (error) {
      console.error('❌❌❌ ERROR al guardar/emitir mensaje:', error);
    }
  });

  // ✅ Manejar el envío de mensajes de audio (Base64)
  socket.on('audio_message', async (data) => {
    console.log('🎯🎯🎯 RECIBIENDO audio_message:', data);
    
    const { userId, username, audioData, roomId } = data;
    
    // --- Lógica de PTT AÑADIDA: Bloquear si no tiene el token ---
    if (roomId === HANDY_ROOM_ID) {
        const room = rooms.get(roomId);
        // Si es una sala Handy, verifica si el usuario tiene el token.
        // El cliente debe liberar el token *después* de que este mensaje haya terminado de subir.
        if (!room || room.currentSpeaker !== userId) {
            console.warn(`⚠️ Rechazando audio de ${username} en sala PTT. No tienen el token.`);
            // Informar al cliente que la transmisión fue abortada.
            socket.emit('audio_transmission_failed', { message: 'No tienes el token de palabra (PTT).' });
            return;
        }
    }
    // --- FIN Lógica de PTT AÑADIDA ---

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
      
      console.log('📤📤📤 EMITIENDO new_message (audio) a sala:', roomId);
      console.log('📦 Datos audio a emitir:', audioMessage);
      
      io.to(roomId).emit('new_message', audioMessage);
      console.log(`✅✅✅ Audio de ${username} subido y compartido. URL: ${url}`);
    } catch (error) {
      console.error('❌ Error al procesar el mensaje de audio:', error);
      socket.emit('audioUploadError', { message: 'Error al subir el audio.' });
    }
  });

  // ✅ Manejar la desconexión
  socket.on('disconnect', () => {
    console.log(`🔴 Usuario desconectado: ${socket.id}`);
    
    // 1. Obtener el userId usando el nuevo mapa (CRÍTICO)
    const userId = socketToUserMap.get(socket.id);
    
    if (userId) {
        const user = connectedUsers.get(userId);
        
        // 2. Solo proceder si el socket ID que se desconecta es el último que se registró (para evitar desconexiones accidentales)
        if (user && user.socketId === socket.id) { 
            // 3. Eliminar usuario de la sala actual y limpiar token
            leaveCurrentRoom(userId, socket); // Reutilizar la función de limpieza
            
            // 4. Eliminar del mapa de usuarios conectados únicos
            connectedUsers.delete(userId);
            userToRoomMap.delete(userId);
            
            console.log(`❌ Usuario desconectado: ${user.username}`);
            
            // 5. Emitir la lista actualizada de usuarios
            io.emit('user-list', Array.from(connectedUsers.values()));
        } else if (user) {
            console.log(`⚠️ Socket secundario ${socket.id} de ${user.username} desconectado. El usuario sigue conectado.`);
        }
        
        // 6. Eliminar el mapeo del socket
        socketToUserMap.delete(socket.id);

    } else {
      console.log(`❌ Usuario desconocido desconectado: ${socket.id}`);
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
  console.log('   - Chat en tiempo real');
  console.log('   - Gestión de salas de chat (General y PTT)');
  console.log('   - Compartir audio (con Firebase Storage)');
  console.log('   - Control PTT (Push-To-Talk) para Sala Handy');
  console.log('   - API REST para monitoreo');
  console.log('   - CORS configurado para desarrollo');
});