// ============================================================
// 🌐 Servidor Node.js con Socket.IO, Firebase Firestore y Storage + PTT
// 💬 Compatible con tu app Android (SocketRepository, ChatViewModel, PTTManager)
// 🪲 Modo DEBUG EXTREMO: Logs detallados para cada paso de unión, envío y token
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
  transports: ["websocket", "polling"],  // ✅ Acepta ambos tipos
  allowEIO3: true,                        // ✅ Permite clientes antiguos (como el tuyo v2.1.0)
  maxHttpBufferSize: 1e8,                 // ✅ Mantiene el tamaño de audio
});

app.use(cors());
app.use(express.json({ limit: "25mb" })); // por si te llega dataURL base64 grande

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
// 📦 Estado en memoria
// ============================================================
const connectedUsers = new Map();
const socketToUserMap = new Map();
const rooms = new Map();
const userToRoomMap = new Map();

// 🆕 Estado PTT: 1 solo hablante por sala
const pttState = {}; // { roomId: { speakerId, speakerName, startedAt } }

// ============================================================
// 🚪 Salas base
// ============================================================
function createRoom(id, name, description, type) {
  return { id, name, description, users: new Set(), type, isPrivate: false };
}

rooms.set("salas", createRoom("salas", "Lobby de Salas", "Pantalla principal", "lobby"));
rooms.set("general", createRoom("general", "Chat General", "Sala pública", "general"));
rooms.set("handy", createRoom("handy", "Radio Handy (PTT)", "Simulación de radio", "ptt"));

// ============================================================
// 🔧 Helpers
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
  if (!room) return [];
  return Array.from(room.users).map((id) => connectedUsers.get(id)).filter(Boolean);
}

// 🧰 Helpers avatar
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

async function uploadAvatarFromDataUrl(userId, dataUrl) {
  try {
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
  } catch (e) {
    console.error(`${colors.red}❌ Error subiendo avatar:${colors.reset}`, e);
    throw e;
  }
}

// ============================================================
// 🌐 Endpoints REST
// ============================================================
app.get("/health", (_, res) => res.status(200).send("Servidor operativo 🚀"));
app.get("/users", (_, res) => res.json(Array.from(connectedUsers.values())));
app.get("/rooms", (_, res) => res.json(serializeRooms()));

// ============================================================
// 🔌 Socket.IO
// ============================================================
io.on("connection", (socket) => {
  console.log(`${colors.cyan}🔗 NUEVA CONEXIÓN SOCKET:${colors.reset} ${socket.id}`);

  // ============================================================
  // 🧩 Usuario conectado
  // ============================================================
 // ============================================================
// 🌐 Servidor Node.js con Socket.IO, Firebase Firestore y Storage + PTT
// 💬 Compatible con tu app Android (SocketRepository, ChatViewModel, PTTManager)
// 🪲 Modo DEBUG EXTREMO: Logs detallados para cada paso de unión, envío y token
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
  transports: ["websocket", "polling"],  // ✅ Acepta ambos tipos
  allowEIO3: true,                        // ✅ Permite clientes antiguos (como el tuyo v2.1.0)
  maxHttpBufferSize: 1e8,                 // ✅ Mantiene el tamaño de audio
});

app.use(cors());
app.use(express.json({ limit: "25mb" })); // por si te llega dataURL base64 grande

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
// 📦 Estado en memoria
// ============================================================
const connectedUsers = new Map();
const socketToUserMap = new Map();
const rooms = new Map();
const userToRoomMap = new Map();

// 🆕 Estado PTT: 1 solo hablante por sala
const pttState = {}; // { roomId: { speakerId, speakerName, startedAt } }

// ============================================================
// 🚪 Salas base
// ============================================================
function createRoom(id, name, description, type) {
  return { id, name, description, users: new Set(), type, isPrivate: false };
}

rooms.set("salas", createRoom("salas", "Lobby de Salas", "Pantalla principal", "lobby"));
rooms.set("general", createRoom("general", "Chat General", "Sala pública", "general"));
rooms.set("handy", createRoom("handy", "Radio Handy (PTT)", "Simulación de radio", "ptt"));

// ============================================================
// 🔧 Helpers
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
  if (!room) return [];
  return Array.from(room.users).map((id) => connectedUsers.get(id)).filter(Boolean);
}

// 🧰 Helpers avatar
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

async function uploadAvatarFromDataUrl(userId, dataUrl) {
  try {
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
  } catch (e) {
    console.error(`${colors.red}❌ Error subiendo avatar:${colors.reset}`, e);
    throw e;
  }
}

// ============================================================
// 🌐 Endpoints REST
// ============================================================
app.get("/health", (_, res) => res.status(200).send("Servidor operativo 🚀"));
app.get("/users", (_, res) => res.json(Array.from(connectedUsers.values())));
app.get("/rooms", (_, res) => res.json(serializeRooms()));

// ============================================================
// 🔌 Socket.IO
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

    socketToUserMap.set(socket.id, user.id);
    connectedUsers.set(user.id, { ...user, socketId: socket.id, isOnline: true });

    try {
      const userDoc = db.collection(USERS_COLLECTION).doc(user.id);
      const snapshot = await userDoc.get();
      if (snapshot.exists) {
        await userDoc.update({ ...user, isOnline: true, lastLogin: Date.now() });
      } else {
        await userDoc.set({ ...user, isOnline: true, createdAt: Date.now() });
      }
      console.log(`${colors.green}🔑 Usuario sincronizado con Firebase: ${user.username}${colors.reset}`);
    } catch (error) {
      console.error(`${colors.red}❌ Error al registrar usuario:${colors.reset}`, error);
    }

    io.emit("connected_users", Array.from(connectedUsers.values()));
    socket.emit("room_list", serializeRooms());
    ack?.({ success: true });
    console.log(`${colors.green}✅ ACK → user-connected confirmado${colors.reset}`);
  });

  // ============================================================
  // 🚪 Unión de salas
  // ============================================================
  socket.on("join_room", (data = {}, ack) => {
    console.log(`${colors.magenta}🚪 Evento → join_room:${colors.reset}`, data);

    const roomName = data.room || data.roomId || "salas";
    const { userId, username } = data;

    if (!roomName || !userId || !username) {
      const msg = "❌ Datos de unión incompletos";
      socket.emit("join_error", { message: msg });
      ack?.({ success: false, message: msg });
      return;
    }

    if (!rooms.has(roomName)) {
      const msg = `❌ Sala ${roomName} no existe`;
      socket.emit("join_error", { message: msg });
      ack?.({ success: false, message: msg });
      return;
    }

    const room = rooms.get(roomName);
    const prevRoomId = userToRoomMap.get(userId);
    if (prevRoomId && rooms.has(prevRoomId)) {
      const prev = rooms.get(prevRoomId);
      prev.users.delete(userId);
      socket.leave(prevRoomId);
      io.to(prevRoomId).emit("user-left-room", { roomId: prevRoomId, userCount: prev.users.size });
    }

    socket.join(roomName);
    room.users.add(userId);
    userToRoomMap.set(userId, roomName);

    const users = getRoomUsers(roomName);
    socket.emit("room_joined", { roomId: roomName, username, userCount: users.length });
    io.to(roomName).emit("user-joined-room", { roomId: roomName, username, userCount: users.length });

    console.log(`${colors.green}✅ ${username} se unió correctamente a ${roomName}${colors.reset}`);
    ack?.({ success: true, roomId: roomName, message: `Te uniste a ${roomName}` });
  });

  // ============================================================
  // 💬 Mensajes de texto
  // ============================================================
  socket.on("send_message", async (data = {}, ack) => {
    const { userId, username, roomId, text } = data;
    if (!userId || !username || !roomId || !text)
      return ack?.({ success: false, message: "❌ Datos de mensaje inválidos" });

    const message = { id: uuidv4(), userId, username, roomId, text, timestamp: Date.now() };

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
    if (!audioData || !userId || !roomId)
      return ack?.({ success: false, message: "❌ Datos de audio inválidos" });

    try {
      const buffer = Buffer.from(audioData, "base64");
      const filePath = `audios/${roomId}/${userId}_${Date.now()}_${uuidv4()}.m4a`;
      const file = bucket.file(filePath);
      await file.save(buffer, { contentType: "audio/m4a", resumable: false });
      await file.makePublic();
      const url = file.publicUrl();

      const audioMsg = { id: uuidv4(), userId, username, roomId, audioUrl: url, timestamp: Date.now() };
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
  // 👤 PERFIL: get_profile / update_profile (incluye avatar)
  // ============================================================
  socket.on("get_profile", async (data = {}, callback) => {
    try {
      const userId = data.userId;
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
        ...user, // para compatibilidad si tu cliente esperaba llano
        // o si preferís:
        // user
      });
    } catch (e) {
      console.error(`${colors.red}❌ Error get_profile:${colors.reset}`, e);
      return callback?.({ success: false, message: e.message || "Error interno" });
    }
  });

  socket.on("update_profile", async (data = {}, callback) => {
    try {
      const {
        userId,
        fullName = "",
        username = "",
        email = "",
        phone = "",
        avatarUri = ""
      } = data;

      console.log(`${colors.blue}📥 Evento → update_profile:${colors.reset}`, {
        userId, fullName, username, email, phone,
        avatarUri: avatarUri ? (isHttpUrl(avatarUri) ? "http-url" : (isDataUrl(avatarUri) ? "data-url" : "otro")) : "vacío"
      });

      if (!userId) {
        console.warn(`${colors.yellow}⚠️ update_profile sin userId${colors.reset}`);
        return callback?.({ success: false, message: "userId requerido" });
      }

      let finalAvatar = avatarUri || "";
      if (isDataUrl(avatarUri)) {
        // subir y obtener URL pública
        finalAvatar = await uploadAvatarFromDataUrl(userId, avatarUri);
      } else if (avatarUri && !isHttpUrl(avatarUri)) {
        // si llega algo raro, lo ignoramos para no romper
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
        status: "Online",      // puedes conservar estos defaults si tu app los usa
        presence: "Available",
        updatedAt: Date.now()
      };

      await db.collection(USERS_COLLECTION).doc(userId).set(updatedUser, { merge: true });
      connectedUsers.set(userId, { ...(connectedUsers.get(userId) || {}), ...updatedUser, socketId: socket.id, isOnline: true });

      console.log(`${colors.green}✅ Perfil actualizado para ${username}${colors.reset}`);
      io.emit("user_updated", updatedUser); // opcional: broadcast para UI en vivo

      return callback?.({
        success: true,
        message: "Perfil actualizado correctamente",
        user: updatedUser
      });

    } catch (error) {
      console.error(`${colors.red}❌ Error en update_profile:${colors.reset}`, error);
      return callback?.({ success: false, message: error.message || "Error interno del servidor" });
    }
  });

  // ============================================================
  // 🔊 FUNCIONALIDAD PTT (Push-To-Talk)
  // ============================================================
  socket.on("request_talk_token", (data = {}) => {
    const { roomId, userId, username } = data;
    if (!roomId || !userId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    if (!pttState[roomId] || !pttState[roomId].speakerId) {
      // Nadie hablando → concede token
      pttState[roomId] = { speakerId: userId, speakerName: username, startedAt: Date.now() };
      socket.emit("token_granted", { roomId, userId, username });
      io.to(roomId).emit("current_speaker_update", userId);
      console.log(`${colors.green}🎙️ Token concedido a ${username} (${userId}) en ${roomId}${colors.reset}`);
    } else {
      // Ya hay alguien hablando
      socket.emit("token_denied", {
        roomId,
        currentSpeaker: pttState[roomId].speakerId,
      });
      console.log(`${colors.yellow}🚫 Token denegado a ${username}, ya habla ${pttState[roomId].speakerName}${colors.reset}`);
    }
  });

  socket.on("release_talk_token", (data = {}) => {
    const { roomId, userId } = data;
    const state = pttState[roomId];
    if (!state || state.speakerId !== userId) return;

    console.log(`${colors.gray}🔓 Token liberado por ${userId} en ${roomId}${colors.reset}`);
    pttState[roomId] = null;
    io.to(roomId).emit("token_released", { roomId, currentSpeaker: null });
    io.to(roomId).emit("current_speaker_update", null);
  });

  // ============================================================
  // 📋 Solicitudes de datos
  // ============================================================
  socket.on("get_rooms", (_, ack) => {
    const list = serializeRooms();
    socket.emit("room_list", list);
    ack?.({ success: true, rooms: list });
  });

  socket.on("get_users", (data = {}, ack) => {
    const { roomId } = data;
    const users = getRoomUsers(roomId || "general");
    socket.emit("connected_users", users);
    ack?.({ success: true, users });
  });

  // ============================================================
  // 🔴 Desconexión
  // ============================================================
socket.on("disconnect", () => {
  const userId = socketToUserMap.get(socket.id);
  if (!userId) return;

  const userData = connectedUsers.get(userId);
  if (!userData) return;

  userData.sockets.delete(socket.id);
  socketToUserMap.delete(socket.id);

  if (userData.sockets.size === 0) {
    connectedUsers.delete(userId);
    userToRoomMap.delete(userId);
    io.emit("connected_users", Array.from(connectedUsers.values()));
    console.log(`🔴 ${userId} se desconectó completamente`);
  } else {
    console.log(`⚪ ${userId} cerró una sesión (${userData.sockets.size} restantes)`);
  }
});


// ============================================================
// 🚀 Iniciar servidor
// ============================================================
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`${colors.green}🚀 Servidor de chat+PTT corriendo en puerto ${PORT}${colors.reset}`);
  console.log(`${colors.cyan}🌐 http://localhost:${PORT}${colors.reset}`);
});


  // ============================================================
  // 🚪 Unión de salas
  // ============================================================
  socket.on("join_room", (data = {}, ack) => {
    console.log(`${colors.magenta}🚪 Evento → join_room:${colors.reset}`, data);

    const roomName = data.room || data.roomId || "salas";
    const { userId, username } = data;

    if (!roomName || !userId || !username) {
      const msg = "❌ Datos de unión incompletos";
      socket.emit("join_error", { message: msg });
      ack?.({ success: false, message: msg });
      return;
    }

    if (!rooms.has(roomName)) {
      const msg = `❌ Sala ${roomName} no existe`;
      socket.emit("join_error", { message: msg });
      ack?.({ success: false, message: msg });
      return;
    }

    const room = rooms.get(roomName);
    const prevRoomId = userToRoomMap.get(userId);
    if (prevRoomId && rooms.has(prevRoomId)) {
      const prev = rooms.get(prevRoomId);
      prev.users.delete(userId);
      socket.leave(prevRoomId);
      io.to(prevRoomId).emit("user-left-room", { roomId: prevRoomId, userCount: prev.users.size });
    }

    socket.join(roomName);
    room.users.add(userId);
    userToRoomMap.set(userId, roomName);

    const users = getRoomUsers(roomName);
    socket.emit("room_joined", { roomId: roomName, username, userCount: users.length });
    io.to(roomName).emit("user-joined-room", { roomId: roomName, username, userCount: users.length });

    console.log(`${colors.green}✅ ${username} se unió correctamente a ${roomName}${colors.reset}`);
    ack?.({ success: true, roomId: roomName, message: `Te uniste a ${roomName}` });
  });

  // ============================================================
  // 💬 Mensajes de texto
  // ============================================================
  socket.on("send_message", async (data = {}, ack) => {
    const { userId, username, roomId, text } = data;
    if (!userId || !username || !roomId || !text)
      return ack?.({ success: false, message: "❌ Datos de mensaje inválidos" });

    const message = { id: uuidv4(), userId, username, roomId, text, timestamp: Date.now() };

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
    if (!audioData || !userId || !roomId)
      return ack?.({ success: false, message: "❌ Datos de audio inválidos" });

    try {
      const buffer = Buffer.from(audioData, "base64");
      const filePath = `audios/${roomId}/${userId}_${Date.now()}_${uuidv4()}.m4a`;
      const file = bucket.file(filePath);
      await file.save(buffer, { contentType: "audio/m4a", resumable: false });
      await file.makePublic();
      const url = file.publicUrl();

      const audioMsg = { id: uuidv4(), userId, username, roomId, audioUrl: url, timestamp: Date.now() };
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
  // 👤 PERFIL: get_profile / update_profile (incluye avatar)
  // ============================================================
  socket.on("get_profile", async (data = {}, callback) => {
    try {
      const userId = data.userId;
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
        ...user, // para compatibilidad si tu cliente esperaba llano
        // o si preferís:
        // user
      });
    } catch (e) {
      console.error(`${colors.red}❌ Error get_profile:${colors.reset}`, e);
      return callback?.({ success: false, message: e.message || "Error interno" });
    }
  });

  socket.on("update_profile", async (data = {}, callback) => {
    try {
      const {
        userId,
        fullName = "",
        username = "",
        email = "",
        phone = "",
        avatarUri = ""
      } = data;

      console.log(`${colors.blue}📥 Evento → update_profile:${colors.reset}`, {
        userId, fullName, username, email, phone,
        avatarUri: avatarUri ? (isHttpUrl(avatarUri) ? "http-url" : (isDataUrl(avatarUri) ? "data-url" : "otro")) : "vacío"
      });

      if (!userId) {
        console.warn(`${colors.yellow}⚠️ update_profile sin userId${colors.reset}`);
        return callback?.({ success: false, message: "userId requerido" });
      }

      let finalAvatar = avatarUri || "";
      if (isDataUrl(avatarUri)) {
        // subir y obtener URL pública
        finalAvatar = await uploadAvatarFromDataUrl(userId, avatarUri);
      } else if (avatarUri && !isHttpUrl(avatarUri)) {
        // si llega algo raro, lo ignoramos para no romper
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
        status: "Online",      // puedes conservar estos defaults si tu app los usa
        presence: "Available",
        updatedAt: Date.now()
      };

      await db.collection(USERS_COLLECTION).doc(userId).set(updatedUser, { merge: true });
      connectedUsers.set(userId, { ...(connectedUsers.get(userId) || {}), ...updatedUser, socketId: socket.id, isOnline: true });

      console.log(`${colors.green}✅ Perfil actualizado para ${username}${colors.reset}`);
      io.emit("user_updated", updatedUser); // opcional: broadcast para UI en vivo

      return callback?.({
        success: true,
        message: "Perfil actualizado correctamente",
        user: updatedUser
      });

    } catch (error) {
      console.error(`${colors.red}❌ Error en update_profile:${colors.reset}`, error);
      return callback?.({ success: false, message: error.message || "Error interno del servidor" });
    }
  });

  // ============================================================
  // 🔊 FUNCIONALIDAD PTT (Push-To-Talk)
  // ============================================================
  socket.on("request_talk_token", (data = {}) => {
    const { roomId, userId, username } = data;
    if (!roomId || !userId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    if (!pttState[roomId] || !pttState[roomId].speakerId) {
      // Nadie hablando → concede token
      pttState[roomId] = { speakerId: userId, speakerName: username, startedAt: Date.now() };
      socket.emit("token_granted", { roomId, userId, username });
      io.to(roomId).emit("current_speaker_update", userId);
      console.log(`${colors.green}🎙️ Token concedido a ${username} (${userId}) en ${roomId}${colors.reset}`);
    } else {
      // Ya hay alguien hablando
      socket.emit("token_denied", {
        roomId,
        currentSpeaker: pttState[roomId].speakerId,
      });
      console.log(`${colors.yellow}🚫 Token denegado a ${username}, ya habla ${pttState[roomId].speakerName}${colors.reset}`);
    }
  });

  socket.on("release_talk_token", (data = {}) => {
    const { roomId, userId } = data;
    const state = pttState[roomId];
    if (!state || state.speakerId !== userId) return;

    console.log(`${colors.gray}🔓 Token liberado por ${userId} en ${roomId}${colors.reset}`);
    pttState[roomId] = null;
    io.to(roomId).emit("token_released", { roomId, currentSpeaker: null });
    io.to(roomId).emit("current_speaker_update", null);
  });

  // ============================================================
  // 📋 Solicitudes de datos
  // ============================================================
  socket.on("get_rooms", (_, ack) => {
    const list = serializeRooms();
    socket.emit("room_list", list);
    ack?.({ success: true, rooms: list });
  });

  socket.on("get_users", (data = {}, ack) => {
    const { roomId } = data;
    const users = getRoomUsers(roomId || "general");
    socket.emit("connected_users", users);
    ack?.({ success: true, users });
  });

  // ============================================================
  // 🔴 Desconexión
  // ============================================================
  socket.on("disconnect", () => {
    const userId = socketToUserMap.get(socket.id);
    if (userId) {
      const prevRoom = userToRoomMap.get(userId);
      if (prevRoom && rooms.has(prevRoom)) {
        const r = rooms.get(prevRoom);
        r.users.delete(userId);
        io.to(prevRoom).emit("user-left-room", { roomId: prevRoom, userCount: r.users.size });

        // Si el usuario era el hablante PTT, liberar token
        if (pttState[prevRoom] && pttState[prevRoom].speakerId === userId) {
          pttState[prevRoom] = null;
          io.to(prevRoom).emit("token_released", { roomId: prevRoom, currentSpeaker: null });
          io.to(prevRoom).emit("current_speaker_update", null);
          console.log(`${colors.red}🎙️ Token liberado por desconexión de ${userId}${colors.reset}`);
        }
      }
      connectedUsers.delete(userId);
      userToRoomMap.delete(userId);
      socketToUserMap.delete(socket.id);
      io.emit("connected_users", Array.from(connectedUsers.values()));
    }
  });
});

// ============================================================
// 🚀 Iniciar servidor
// ============================================================
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`${colors.green}🚀 Servidor de chat+PTT corriendo en puerto ${PORT}${colors.reset}`);
  console.log(`${colors.cyan}🌐 http://localhost:${PORT}${colors.reset}`);
});
