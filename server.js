/// ============================================================
// 🌐 Servidor Node.js con Socket.IO, Firebase Firestore y Storage + PTT + WebRTC
// 💬 Compatible con tu app Android (SocketRepository, ChatViewModel, PTTManager)
// 🛠 CORREGIDO: Gestión unificada de salas y usuarios
// ============================================================

const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const admin = require("firebase-admin");
const { Buffer } = require("buffer");

// 🎨 Colores ANSI
const colors = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
};

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
  allowEIO3: true,
  maxHttpBufferSize: 1e8,
});

app.use(cors());
app.use(express.json({ limit: "25mb" }));

// ============================================================
// 🔥 Firebase
// ============================================================
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

const USERS_COLLECTION = "users";
const MESSAGES_COLLECTION = "messages";

// ============================================================
// 📦 NUEVO SISTEMA UNIFICADO DE GESTIÓN DE SALAS
// ============================================================
const roomManager = {
  // SocketId → Set<RoomIds>
  socketRooms: new Map(),
  // UserId → Set<RoomIds>  
  userRooms: new Map(),
  // RoomId → Set<UserId>
  roomUsers: new Map()
};

const connectedUsers = new Map();
const socketToUserMap = new Map();
const pttState = {};
const tokenTimers = {};

// ============================================================
// 🚪 Salas base
// ============================================================
function createRoom(id, name, description, type) {
  return { 
    id, 
    name, 
    description, 
    users: new Set(), 
    type, 
    isPrivate: false 
  };
}

const rooms = new Map();
rooms.set("salas", createRoom("salas", "Lobby de Salas", "Pantalla principal", "lobby"));
rooms.set("general", createRoom("general", "Chat General", "Sala pública", "main"));
rooms.set("handy", createRoom("handy", "Radio Handy (PTT)", "Simulación de radio", "main"));

// ============================================================
// 🏗️ TIPOS DE SALA JERÁRQUICOS
// ============================================================
const ROOM_TYPES = {
  LOBBY: 'lobby',      // salas - siempre activa
  MAIN: 'main',        // general, handy - sala principal
  SUPPORT: 'support'   // salas temporales
};

// ============================================================
// 🔧 FUNCIONES AUXILIARES MEJORADAS
// ============================================================
function serializeRoom(room) {
  return {
    id: room.id,
    name: room.name,
    description: room.description,
    userCount: room.users.size,
    maxUsers: 50,
    type: room.type,
    isPrivate: !!room.isPrivate,
  };
}

function serializeRooms() {
  return Array.from(rooms.values()).map(serializeRoom);
}

function getRoomUsers(roomId) {
  const room = rooms.get(roomId);
  if (!room) {
    console.warn(`${colors.yellow}⚠️ getRoomUsers: Sala '${roomId}' no encontrada${colors.reset}`);
    return [];
  }
  
  console.log(`${colors.cyan}🔍 getRoomUsers('${roomId}') - Usuarios en room:${colors.reset}`, Array.from(room.users));
  
  const users = Array.from(room.users)
    .map((userId) => {
      const entry = connectedUsers.get(userId);
      if (!entry) {
        console.warn(`${colors.yellow}⚠️ Usuario ${userId} en sala ${roomId} pero no en connectedUsers${colors.reset}`);
        return null;
      }
      return { 
        ...entry.userData, 
        isOnline: true,
        socketCount: entry.sockets.size 
      };
    })
    .filter(Boolean);

  console.log(`${colors.green}✅ getRoomUsers('${roomId}') → ${users.length} usuarios${colors.reset}`);
  return users;
}

// 🎯 OBTENER SALA PRINCIPAL DE UN USUARIO
function getUsersMainRoom(userId) {
  const userRooms = roomManager.userRooms.get(userId) || new Set();
  
  // Prioridad: handy > general > primera sala principal disponible
  if (userRooms.has('handy')) return 'handy';
  if (userRooms.has('general')) return 'general';
  
  const mainRooms = Array.from(userRooms).filter(roomId => {
    const room = rooms.get(roomId);
    return room && room.type === 'main';
  });
  
  return mainRooms[0] || 'general'; // Fallback seguro
}

// 🚪 FUNCIÓN PARA DEJAR SALA
async function leaveRoom(socket, roomId) {
  if (!rooms.has(roomId)) {
    console.warn(`${colors.yellow}⚠️ leaveRoom: Sala ${roomId} no existe${colors.reset}`);
    return;
  }

  const room = rooms.get(roomId);
  const userId = socket.userId;
  const username = socket.username;

  console.log(`${colors.cyan}🚪 leaveRoom: ${username} dejando ${roomId}${colors.reset}`);

  // Salir físicamente de la sala Socket.IO
  socket.leave(roomId);

  // Verificar si hay otros sockets del mismo usuario en la sala
  const roomSockets = io.sockets.adapter.rooms.get(roomId) || new Set();
  const userStillInRoom = Array.from(roomSockets).some(socketId => {
    const s = io.sockets.sockets.get(socketId);
    return s?.userId === userId;
  });

  if (!userStillInRoom) {
    // Remover usuario de la sala
    room.users.delete(userId);
    
    // Actualizar estructuras del roomManager
    if (roomManager.socketRooms.has(socket.id)) {
      roomManager.socketRooms.get(socket.id).delete(roomId);
    }
    
    if (roomManager.userRooms.has(userId)) {
      roomManager.userRooms.get(userId).delete(roomId);
    }

    // Liberar token PTT si era el speaker
    if (pttState[roomId]?.speakerId === userId) {
      console.log(`${colors.yellow}🎙️ Liberando token PTT por salir de sala${colors.reset}`);
      clearTimeout(tokenTimers[roomId]);
      pttState[roomId] = null;
      io.to(roomId).emit("token_released", { roomId, currentSpeaker: null });
      io.to(roomId).emit("current_speaker_update", null);
    }

    // Notificar a la sala que el usuario salió
    io.to(roomId).emit("user_left_room", {
      roomId: roomId,
      username: username,
      userCount: room.users.size
    });

    console.log(`${colors.green}✅ ${username} salió completamente de ${roomId}${colors.reset}`);
  } else {
    console.log(`${colors.gray}🔗 ${username} mantiene otros sockets en ${roomId}${colors.reset}`);
  }
}

// ➕ FUNCIÓN PARA UNIRSE A SALA
async function joinRoom(socket, roomId) {
  if (!rooms.has(roomId)) {
    throw new Error(`Sala ${roomId} no existe`);
  }

  const room = rooms.get(roomId);
  const userId = socket.userId;
  const username = socket.username;

  console.log(`${colors.cyan}➕ joinRoom: ${username} uniéndose a ${roomId}${colors.reset}`);

  // Unirse físicamente a la sala Socket.IO
  socket.join(roomId);

  // Agregar usuario a la sala
  room.users.add(userId);

  // Actualizar estructuras del roomManager
  if (!roomManager.socketRooms.has(socket.id)) {
    roomManager.socketRooms.set(socket.id, new Set());
  }
  roomManager.socketRooms.get(socket.id).add(roomId);

  if (!roomManager.userRooms.has(userId)) {
    roomManager.userRooms.set(userId, new Set());
  }
  roomManager.userRooms.get(userId).add(roomId);

  console.log(`${colors.green}✅ ${username} unido exitosamente a ${roomId}${colors.reset}`);
}

// 🔄 FUNCIÓN PRINCIPAL PARA CAMBIAR DE SALA
async function changeUserRoom(socket, targetRoomId) {
  const userId = socket.userId;
  const username = socket.username;
  const currentRooms = roomManager.socketRooms.get(socket.id) || new Set();

  console.log(`${colors.magenta}🔄 changeUserRoom: ${username} ${Array.from(currentRooms)} → ${targetRoomId}${colors.reset}`);

  // 1️⃣ Salir de TODAS las salas principales anteriores (excepto lobby 'salas')
  for (const roomId of currentRooms) {
    if (roomId !== 'salas' && roomId !== targetRoomId) {
      const room = rooms.get(roomId);
      if (room && room.type === 'main') {
        await leaveRoom(socket, roomId);
      }
    }
  }

  // 2️⃣ Unirse a la nueva sala
  await joinRoom(socket, targetRoomId);
  
  // 3️⃣ Actualizar estado - mantener solo 'salas' y la nueva sala principal
  roomManager.socketRooms.set(socket.id, new Set(['salas', targetRoomId]));
  
  console.log(`${colors.green}🎯 ${username} ahora en salas: salas + ${targetRoomId}${colors.reset}`);
  
  return targetRoomId;
}

// 🛰️ Helper WebRTC mejorado
function findSocketByUserId(userId, roomId) {
  const room = io.sockets.adapter.rooms.get(roomId);
  if (!room) return null;
  
  for (const socketId of room) {
    const s = io.sockets.sockets.get(socketId);
    if (s?.userId === userId) return s;
  }
  return null;
}

// 🔧 Utilidades para DataURL
function isHttpUrl(str) {
  return typeof str === "string" && /^https?:\/\//i.test(str);
}

function isDataUrl(str) {
  return typeof str === "string" && /^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(str);
}

function getMimeFromDataUrl(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,/.exec(dataUrl || "");
  return match ? match[1] : "image/jpeg";
}

function getBase64FromDataUrl(dataUrl) {
  const idx = (dataUrl || "").indexOf("base64,");
  return idx !== -1 ? dataUrl.substring(idx + 7) : null;
}

function isPTTRoomId(roomId) {
  const r = rooms.get(roomId);
  return (r && r.type === "ptt") || roomId === "handy";
}

async function uploadAvatarFromDataUrl(userId, dataUrl) {
  const mime = getMimeFromDataUrl(dataUrl);
  const ext = mime.split("/")[1] || "jpg";
  const base64 = getBase64FromDataUrl(dataUrl);
  if (!base64) throw new Error("Data URL inválida (sin base64)");

  const buffer = Buffer.from(base64, "base64");
  const filePath = `avatars/${userId}/${Date.now()}_${uuidv4()}.${ext}`;
  const file = bucket.file(filePath);
  
  console.log(`${colors.yellow}⬆️ Subiendo avatar → ${filePath} (${mime})${colors.reset}`);
  await file.save(buffer, { contentType: mime, resumable: false });
  await file.makePublic();
  
  const url = file.publicUrl();
  console.log(`${colors.green}✅ Avatar subido y público:${colors.reset} ${url}`);
  return url;
}

// ============================================================
// 🌐 Endpoints REST
// ============================================================
app.get("/health", (_, res) => res.status(200).send("Servidor operativo 🚀"));

app.get("/users", (_, res) =>
  res.json(
    Array.from(connectedUsers.values()).map((u) => ({
      ...u.userData,
      socketCount: u.sockets.size,
    }))
  )
);

app.get("/rooms", (_, res) => res.json(serializeRooms()));

// ============================================================
// 🔊 CONFIGURACIÓN PTT
// ============================================================
const TOKEN_TIMEOUT_MS = 10_000;

// ============================================================
// 🔌 Socket.IO - CONEXIÓN PRINCIPAL
// ============================================================
io.on("connection", (socket) => {
  console.log(`${colors.cyan}🔗 NUEVA CONEXIÓN SOCKET:${colors.reset} ${socket.id}`);

  // ============================================================
  // 🧩 Usuario conectado
  // ============================================================
  socket.on("user-connected", async (user, ack) => {
    console.log(`${colors.blue}📥 Evento → user-connected:${colors.reset}`, user);

    if (!user || !user.id || !user.username) {
      const msg = "⚠️ Datos de usuario inválidos";
      console.warn(`${colors.yellow}${msg}${colors.reset}`);
      ack?.({ success: false, message: msg });
      return;
    }

    const username = user.username;
    const userId = user.id;
    
    // ✅ Guardar en el socket
    socket.userId = userId;
    socket.username = username;
    socketToUserMap.set(socket.id, userId);

    // ✅ Inicializar estructuras del roomManager
    roomManager.socketRooms.set(socket.id, new Set(['salas']));
    if (!roomManager.userRooms.has(userId)) {
      roomManager.userRooms.set(userId, new Set(['salas']));
    }

    const existing = connectedUsers.get(userId);
    if (existing) {
      existing.sockets.add(socket.id);
      existing.userData = { ...existing.userData, ...user, isOnline: true };
    } else {
      connectedUsers.set(userId, { 
        userData: { ...user, isOnline: true }, 
        sockets: new Set([socket.id]) 
      });
    }

    // Unirse automáticamente al lobby 'salas'
    socket.join('salas');
    rooms.get('salas').users.add(userId);

    try {
      const userDoc = db.collection(USERS_COLLECTION).doc(userId);
      await userDoc.set({ ...user, isOnline: true, lastLogin: Date.now() }, { merge: true });
      console.log(`${colors.green}🔑 Usuario sincronizado con Firebase: ${username}${colors.reset}`);
    } catch (error) {
      console.error(`${colors.red}❌ Error al registrar usuario:${colors.reset}`, error);
    }

    // Emitir usuarios conectados globalmente
    io.emit(
      "connected_users",
      Array.from(connectedUsers.values()).map((u) => ({
        ...u.userData,
        socketCount: u.sockets.size,
      }))
    );

    socket.emit("room_list", serializeRooms());
    ack?.({ success: true });
    console.log(`${colors.green}✅ ACK → user-connected confirmado${colors.reset}`);
  });

  // ============================================================
  // 🚪 UNIÓN DE SALAS - CORREGIDO
  // ============================================================
  socket.on("join_room", async (data = {}, ack) => {
    console.log(`${colors.magenta}🚪 Evento → join_room:${colors.reset}`, data);

    const { roomId: targetRoom, userId, username } = data;
    
    // ✅ VALIDACIONES INICIALES
    if (!targetRoom || !userId || !username) {
      const error = "❌ Datos de unión incompletos";
      console.warn(`${colors.red}${error}${colors.reset}`);
      socket.emit("join_error", { message: error });
      return ack?.({ success: false, message: error });
    }

    if (!rooms.has(targetRoom)) {
      const error = `❌ Sala ${targetRoom} no existe`;
      console.warn(`${colors.red}${error}${colors.reset}`);
      socket.emit("join_error", { message: error });
      return ack?.({ success: false, message: error });
    }

    // 🔄 CAMBIO DE SALA PRINCIPAL
    try {
      const finalRoomId = await changeUserRoom(socket, targetRoom);
      
      // 📊 OBTENER USUARIOS ACTUALIZADOS
      const usersInRoom = getRoomUsers(finalRoomId);
      
      // 🎯 ENVÍO DE EVENTOS COHERENTES
      // Solo al usuario que se unió
      socket.emit("room_joined", {
        success: true,
        roomId: finalRoomId,
        userCount: usersInRoom.length,
        users: usersInRoom
      });

      // A todos en la sala (incluyéndolo)
      io.to(finalRoomId).emit("room_users_updated", {
        roomId: finalRoomId,
        users: usersInRoom,
        userCount: usersInRoom.length,
        action: 'user_joined',
        username: username
      });

      console.log(`${colors.green}✅ ${username} unido correctamente a ${finalRoomId}${colors.reset}`);
      
      ack?.({
        success: true,
        roomId: finalRoomId,
        userCount: usersInRoom.length,
        message: `Unido a ${finalRoomId}`
      });

    } catch (error) {
      console.error(`${colors.red}❌ Error en join_room:${colors.reset}`, error);
      socket.emit("join_error", { message: error.message });
      ack?.({ success: false, message: error.message });
    }
  });

  // ============================================================
  // 🚪 Salir de sala
  // ============================================================
  socket.on("leave_room", async (data = {}, ack) => {
    const { roomId, userId, username } = data || {};
    
    if (!roomId || !userId) {
      const msg = "⚠️ leave_room: datos inválidos";
      console.warn(`${colors.yellow}${msg}${colors.reset}`);
      return ack?.({ success: false, message: msg });
    }

    try {
      await leaveRoom(socket, roomId);
      socket.emit("left_room", { roomId: roomId });
      ack?.({ success: true, roomId: roomId });
      
      console.log(`${colors.green}✅ ${username || userId} salió exitosamente de ${roomId}${colors.reset}`);
    } catch (error) {
      console.error(`${colors.red}❌ Error en leave_room:${colors.reset}`, error);
      ack?.({ success: false, message: error.message });
    }
  });

  // ============================================================
  // 💬 Mensajes de texto
  // ============================================================
  socket.on("send_message", async (data = {}, ack) => {
    const { userId, username, roomId, text } = data;
    if (!userId || !username || !roomId || !text) {
      return ack?.({ success: false, message: "❌ Datos de mensaje inválidos" });
    }

    const message = { 
      id: uuidv4(), 
      userId, 
      username, 
      roomId, 
      text, 
      timestamp: Date.now() 
    };

    try {
      await db.collection(MESSAGES_COLLECTION).add(message);
      io.to(roomId).emit("new_message", message);
      socket.emit("message_sent", message);
      ack?.({ success: true, id: message.id });
      console.log(`${colors.green}💬 [OK] ${username} → [${roomId}]: ${text}${colors.reset}`);
    } catch (err) {
      ack?.({ success: false, message: "Error guardando mensaje" });
      console.error(`${colors.red}❌ Error al guardar mensaje:${colors.reset}`, err);
    }
  });

  // ============================================================
  // 🎧 Mensajes de audio
  // ============================================================
  socket.on("audio_message", async (data = {}, ack) => {
    const { userId, username, audioData, roomId } = data;

    if (!audioData || !userId || !roomId) {
      return ack?.({ success: false, message: "❌ Datos de audio inválidos" });
    }

    if (isPTTRoomId(roomId)) {
      socket.to(roomId).emit("ptt_audio_stream", {
        userId,
        username,
        roomId,
        chunkBase64: audioData,
        timestamp: Date.now(),
      });

      console.log(
        `${colors.cyan}📡 [PTT] Audio transmitido en tiempo real por ${username} en [${roomId}]${colors.reset}`
      );

      return ack?.({ success: true, message: "Audio transmitido en tiempo real (no guardado)" });
    }

    try {
      const buffer = Buffer.from(audioData, "base64");
      const filePath = `audios/${roomId}/${userId}_${Date.now()}_${uuidv4()}.m4a`;
      const file = bucket.file(filePath);

      await file.save(buffer, { contentType: "audio/m4a", resumable: false });
      await file.makePublic();
      const url = file.publicUrl();

      const audioMsg = {
        id: uuidv4(),
        userId,
        username,
        roomId,
        audioUrl: url,
        timestamp: Date.now(),
      };

      await db.collection(MESSAGES_COLLECTION).add(audioMsg);
      io.to(roomId).emit("new_message", audioMsg);
      socket.emit("message_sent", audioMsg);
      ack?.({ success: true, audioUrl: url });

      console.log(`${colors.green}🎤 Audio → ${username} en [${roomId}] → ${url}${colors.reset}`);
    } catch (err) {
      ack?.({ success: false, message: "Error subiendo audio" });
      console.error(`${colors.red}❌ Error al procesar audio:${colors.reset}`, err);
    }
  });

  // ============================================================
  // 📋 Obtener lista de usuarios conectados en una sala - CORREGIDO
  // ============================================================
  socket.on("get_users", (data = {}, ack) => {
    let { roomId } = data || {};
    console.log(`${colors.cyan}📥 Evento → get_users:${colors.reset}`, data);

    // 🎯 DETECCIÓN INTELIGENTE MEJORADA
    if (!roomId) {
      roomId = getUsersMainRoom(socket.userId);
      console.log(`${colors.yellow}🎯 Sala detectada automáticamente: '${roomId}'${colors.reset}`);
    }

    // 🆕 VERIFICAR que la sala existe
    if (!rooms.has(roomId)) {
      const msg = `❌ Sala '${roomId}' no existe`;
      console.warn(`${colors.red}${msg}${colors.reset}`);
      socket.emit("connected_users", []); // Enviar array vacío
      return ack?.({ 
        success: false, 
        message: msg,
        roomId: roomId,
        count: 0 
      });
    }

    const users = getRoomUsers(roomId);
    const username = socket.username || "Usuario";

    console.log(`${colors.green}📤 Enviando ${users.length} usuarios para sala '${roomId}' a ${username}${colors.reset}`);

    // 📤 RESPUESTA ESTANDARIZADA
    const response = {
      success: true,
      roomId: roomId,
      count: users.length,
      users: users,
      message: `Usuarios en ${roomId}: ${users.length}`
    };

    socket.emit("connected_users", response.users);
    ack?.(response);
    
    console.log(`${colors.blue}📋 Sala '${roomId}': ${users.length} usuarios enviados a ${username}${colors.reset}`);
  });

  // ============================================================
  // 👤 PERFIL: get_profile / update_profile
  // ============================================================
  socket.on("get_profile", async (data = {}, callback) => {
    try {
      const userId = data.userId;
      console.log(`${colors.cyan}📥 Evento → get_profile${colors.reset} desde socket ${socket.id}`, data);

      if (!userId) {
        console.warn(`${colors.yellow}⚠️ get_profile sin userId${colors.reset}`);
        return callback?.({ success: false, message: "userId requerido" });
      }

      const snap = await db.collection(USERS_COLLECTION).doc(userId).get();
      if (!snap.exists) {
        console.warn(`${colors.yellow}⚠️ Perfil no encontrado: ${userId}${colors.reset}`);
        return callback?.({ success: false, message: "Perfil no encontrado" });
      }

      const user = snap.data() || {};
      console.log(`${colors.green}📤 get_profile OK → ${user.username}${colors.reset}`);
      return callback?.({
        success: true,
        ...user,
      });
    } catch (e) {
      console.error(`${colors.red}❌ Error get_profile:${colors.reset}`, e);
      return callback?.({ success: false, message: e.message || "Error interno" });
    }
  });

  socket.on("update_profile", async (data = {}, callback) => {
    try {
      console.log(`${colors.cyan}📥 Evento → update_profile${colors.reset} desde socket ${socket.id}`, data);
      const {
        userId,
        fullName = "",
        username = "",
        email = "",
        phone = "",
        avatarUri = "",
      } = data;

      if (!userId) {
        console.warn(`${colors.yellow}⚠️ update_profile sin userId${colors.reset}`);
        return callback?.({ success: false, message: "userId requerido" });
      }

      let finalAvatar = avatarUri || "";
      if (isDataUrl(avatarUri)) {
        finalAvatar = await uploadAvatarFromDataUrl(userId, avatarUri);
      } else if (avatarUri && !isHttpUrl(avatarUri)) {
        console.warn(`${colors.yellow}⚠️ avatarUri no es URL ni DataURL, se ignora${colors.reset}`);
        finalAvatar = "";
      }

      const updatedUser = {
        id: userId,
        fullName,
        username,
        email,
        phone,
        avatarUri: finalAvatar,
        status: "Online",
        presence: "Available",
        updatedAt: Date.now(),
      };

      await db.collection(USERS_COLLECTION).doc(userId).set(updatedUser, { merge: true });

      const entry = connectedUsers.get(userId);
      if (entry) {
        entry.userData = { ...entry.userData, ...updatedUser };
      }

      console.log(`${colors.green}✅ Perfil actualizado para ${username}${colors.reset}`);
      io.emit("user_updated", updatedUser);

      return callback?.({
        success: true,
        message: "Perfil actualizado correctamente",
        user: updatedUser,
      });

    } catch (error) {
      console.error(`${colors.red}❌ Error en update_profile:${colors.reset}`, error);
      return callback?.({ success: false, message: error.message || "Error interno del servidor" });
    }
  });

  // ============================================================
  // 🎙️ Solicitud de token PTT
  // ============================================================
  socket.on("request_talk_token", (data = {}, ack) => {
    const { roomId, userId, username } = data;
    console.log(`${colors.cyan}📥 Evento → request_talk_token${colors.reset}`, data);

    if (!roomId || !userId) {
      const msg = "⚠️ request_talk_token: datos inválidos";
      console.warn(`${colors.yellow}${msg}${colors.reset}`);
      return ack?.({ success: false, message: msg });
    }

    const room = rooms.get(roomId);
    if (!room) {
      const msg = `❌ Sala no encontrada: ${roomId}`;
      console.warn(`${colors.red}${msg}${colors.reset}`);
      return ack?.({ success: false, message: msg });
    }

    if (pttState[roomId]?.locked) {
      return ack?.({ success: false, message: "Token en verificación, reintenta" });
    }
    pttState[roomId] = pttState[roomId] || {};
    pttState[roomId].locked = true;

    const now = Date.now();
    const current = pttState[roomId];

    if (!current.speakerId || now - (current.startedAt || 0) > TOKEN_TIMEOUT_MS) {
      pttState[roomId] = {
        speakerId: userId,
        speakerName: username,
        startedAt: now,
        socketId: socket.id,
      };

      console.log(`${colors.green}🎙️ Token concedido a ${username} (${userId}) en sala ${roomId}${colors.reset}`);
      io.to(roomId).emit("token_granted", { roomId, userId, username });
      io.to(roomId).emit("current_speaker_update", userId);

      clearTimeout(tokenTimers[roomId]);
      tokenTimers[roomId] = setTimeout(() => {
        if (pttState[roomId]?.speakerId === userId) {
          console.log(`${colors.magenta}⏳ Token auto-liberado — ${username}${colors.reset}`);
          delete pttState[roomId];
          io.to(roomId).emit("token_released", { roomId, currentSpeaker: null });
          io.to(roomId).emit("current_speaker_update", null);
        }
      }, TOKEN_TIMEOUT_MS);

      delete pttState[roomId].locked;
      return ack?.({
        success: true,
        roomId,
        userId,
        username,
        message: "Token concedido correctamente",
      });
    }

    const speaker = current.speakerName || current.speakerId;
    delete pttState[roomId].locked;
    console.log(`${colors.yellow}🚫 Token denegado a ${username}, ya habla ${speaker}${colors.reset}`);
    socket.emit("token_denied", {
      roomId,
      currentSpeaker: current.speakerId,
      speakerName: current.speakerName,
    });
    return ack?.({
      success: false,
      roomId,
      currentSpeaker: current.speakerId,
      message: `Ya está hablando ${speaker}`,
    });
  });

  // ============================================================
  // 🔓 Liberación manual del token
  // ============================================================
  socket.on("release_talk_token", (data = {}, ack) => {
    const { roomId, userId } = data;
    console.log(`${colors.cyan}📥 Evento → release_talk_token${colors.reset}`, data);

    if (!roomId || !userId) {
      const msg = "⚠️ release_talk_token: datos inválidos";
      console.warn(`${colors.yellow}${msg}${colors.reset}`);
      return ack?.({ success: false, message: msg });
    }

    const current = pttState[roomId];
    if (!current || current.speakerId !== userId) {
      const msg = "⚠️ No posees el token o no hay hablante activo";
      console.warn(`${colors.yellow}${msg}${colors.reset}`);
      return ack?.({ success: false, message: msg });
    }

    clearTimeout(tokenTimers[roomId]);
    pttState[roomId] = null;

    io.to(roomId).emit("token_released", { roomId, currentSpeaker: null });
    io.to(roomId).emit("current_speaker_update", null);

    console.log(`${colors.green}✅ Token liberado correctamente por ${userId}${colors.reset}`);
    return ack?.({
      success: true,
      roomId,
      userId,
      message: "Token liberado correctamente (ACK)",
    });
  });

  // ============================================================
  // 💓 Keep-Alive del cliente
  // ============================================================
  socket.on("ptt_keep_alive", (data = {}) => {
    const { roomId, userId } = data;
    const current = pttState[roomId];
    if (current && current.speakerId === userId) {
      clearTimeout(tokenTimers[roomId]);
      current.startedAt = Date.now();
      tokenTimers[roomId] = setTimeout(() => {
        if (pttState[roomId] && pttState[roomId].speakerId === userId) {
          console.log(`${colors.magenta}⏳ Token auto-liberado tras perder keep-alive — ${userId}${colors.reset}`);
          pttState[roomId] = null;
          io.to(roomId).emit("token_released", { roomId, currentSpeaker: null });
          io.to(roomId).emit("current_speaker_update", null);
        }
      }, TOKEN_TIMEOUT_MS);
      console.log(`${colors.gray}💓 Keep-alive recibido de ${userId} (${roomId})${colors.reset}`);
    }
  });

  // ============================================================
  // 🧹 Comando global de administrador — reset_all_ptt
  // ============================================================
  socket.on("reset_all_ptt", () => {
    console.log(`${colors.magenta}🧹 Comando → reset_all_ptt recibido. Liberando todos los tokens...${colors.reset}`);

    for (const roomId of Object.keys(pttState)) {
      clearTimeout(tokenTimers[roomId]);
      pttState[roomId] = null;
      io.to(roomId).emit("token_released", { roomId, currentSpeaker: null });
      io.to(roomId).emit("current_speaker_update", null);
    }

    console.log(`${colors.green}✅ Todos los tokens PTT fueron liberados correctamente.${colors.reset}`);
    io.emit("ptt_reset_done", { message: "Todos los micrófonos fueron liberados por el administrador." });
  });

  // ============================================================
  // 📋 Solicitudes de datos
  // ============================================================
  socket.on("get_rooms", (_, ack) => {
    const list = serializeRooms();
    socket.emit("room_list", list);
    ack?.({ success: true, rooms: list });
  });

  // ============================================================
  // 🛰️ WebRTC — Señalización dirigida
  // ============================================================
  socket.on("webrtc_offer", (data = {}) => {
    const { roomId, from, to, sdp, type } = data;
    if (!roomId || !sdp || !to) {
      return console.warn(`⚠️ webrtc_offer sin roomId, to o sdp`, data);
    }
    const target = findSocketByUserId(to, roomId);
    if (!target) return console.warn(`⚠️ Destino ${to} no está en sala ${roomId}`);
    console.log(`📡 webrtc_offer ${from} → ${to} (${roomId})`);
    target.emit("webrtc_offer", { from, sdp, type: type || "offer" });
  });

  socket.on("webrtc_answer", (data = {}) => {
    const { roomId, from, to, sdp, type } = data;
    if (!roomId || !sdp || !to) {
      return console.warn(`⚠️ webrtc_answer sin roomId, to o sdp`, data);
    }
    const target = findSocketByUserId(to, roomId);
    if (!target) return console.warn(`⚠️ Destino ${to} no está en sala ${roomId}`);
    console.log(`📡 webrtc_answer ${from} → ${to} (${roomId})`);
    target.emit("webrtc_answer", { from, sdp, type: type || "answer" });
  });

  socket.on("webrtc_ice_candidate", (data = {}) => {
    const { roomId, from, to, sdpMid, sdpMLineIndex, candidate } = data;
    if (!roomId || !candidate || !to) {
      return console.warn(`⚠️ webrtc_ice_candidate inválido`, data);
    }
    const candidateStr = candidate.candidate || candidate;
    const target = findSocketByUserId(to, roomId);
    if (!target) return console.warn(`⚠️ Destino ${to} no está en sala ${roomId}`);
    console.log(`📡 webrtc_ice_candidate ${from} → ${to} (${roomId})`);
    target.emit("webrtc_ice_candidate", { from, candidate: candidateStr, sdpMid, sdpMLineIndex });
  });

  // ============================================================
  // 🔄 (Opcional) Aviso de intento de reconexión del cliente
  // ============================================================
  socket.on("reconnect_attempt", () => {
    const userId = socketToUserMap.get(socket.id);
    const mainRoom = getUsersMainRoom(userId);
    console.log(`${colors.yellow}♻️ reconnect_attempt: user=${userId} mainRoom=${mainRoom}${colors.reset}`);
    if (mainRoom) socket.emit("join_success", { room: mainRoom, roomId: mainRoom });
  });

  // ============================================================
  // 🔴 Desconexión unificada - CORREGIDA
  // ============================================================
  socket.on("disconnect", (reason) => {
    const userId = socketToUserMap.get(socket.id);
    const username = socket.username;
    
    console.log(`${colors.red}🔌 Socket desconectado:${colors.reset} ${socket.id} (${reason}) - User: ${username}`);

    // 1️⃣ Liberar tokens PTT
    for (const [roomId, state] of Object.entries(pttState)) {
      if (state && state.socketId === socket.id) {
        console.log(`${colors.yellow}🎙️ Liberando token de ${roomId} por desconexión de ${state.speakerName}${colors.reset}`);
        clearTimeout(tokenTimers[roomId]);
        delete pttState[roomId];
        io.to(roomId).emit("token_released", { roomId: roomId, currentSpeaker: null });
        io.to(roomId).emit("current_speaker_update", null);
      }
    }

    // 2️⃣ Salir de todas las salas
    const socketRooms = roomManager.socketRooms.get(socket.id) || new Set();
    for (const roomId of socketRooms) {
      if (rooms.has(roomId)) {
        const room = rooms.get(roomId);
        
        // Verificar si hay otros sockets del mismo usuario en la sala
        const roomSockets = io.sockets.adapter.rooms.get(roomId) || new Set();
        const userStillInRoom = Array.from(roomSockets).some(socketId => {
          const s = io.sockets.sockets.get(socketId);
          return s?.userId === userId && socketId !== socket.id;
        });

        if (!userStillInRoom) {
          room.users.delete(userId);
          io.to(roomId).emit("user_left_room", { 
            roomId, 
            username: username, 
            userCount: room.users.size 
          });
        }
      }
    }

    // 3️⃣ Limpiar estructuras del usuario
    if (userId) {
      const entry = connectedUsers.get(userId);
      if (entry) {
        entry.sockets.delete(socket.id);
        if (entry.sockets.size === 0) {
          connectedUsers.delete(userId);
          console.log(`${colors.red}🔴 Usuario ${username} completamente desconectado.${colors.reset}`);
        }
      }
    }

    // 4️⃣ Limpiar roomManager
    roomManager.socketRooms.delete(socket.id);
    socketToUserMap.delete(socket.id);

    // 5️⃣ Actualizar lista global de usuarios
    io.emit(
      "connected_users",
      Array.from(connectedUsers.values()).map((u) => ({
        ...u.userData,
        socketCount: u.sockets.size,
      }))
    );

    console.log(`${colors.green}🧹 Limpieza de desconexión completada para ${username}${colors.reset}`);
  });
});

// ============================================================
// 🚀 Iniciar servidor
// ============================================================
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`${colors.green}🚀 Servidor de chat+PTT+WebRTC corriendo en puerto ${PORT}${colors.reset}`);
  console.log(`${colors.cyan}🌐 http://localhost:${PORT}${colors.reset}`);
  console.log(`${colors.magenta}🔄 Sistema de salas unificado ACTIVADO${colors.reset}`);
});