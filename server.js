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
  transports: ["websocket", "polling"], // ✅ Acepta ambos tipos
  allowEIO3: true, // ✅ Permite clientes antiguos (como el tuyo v2.1.0)
  maxHttpBufferSize: 1e8, // ✅ Mantiene el tamaño de audio
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
// 📦 Estado en memoria (multi-socket compatible)
// ============================================================
const connectedUsers = new Map(); // userId -> {userData, sockets: Set()}
const socketToUserMap = new Map(); // socketId -> userId
const rooms = new Map();
const userToRoomMap = new Map();
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
  return Array.from(room.users).map((id) => {
    const u = connectedUsers.get(id);
    return u ? { ...u.userData, isOnline: true } : null;
  }).filter(Boolean);
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
app.get("/users", (_, res) => {
  const users = Array.from(connectedUsers.values()).map(u => ({
    ...u.userData,
    socketCount: u.sockets.size
  }));
  res.json(users);
});
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

    const userId = user.id;
    socketToUserMap.set(socket.id, userId);

    // 👥 Permitir múltiples conexiones por usuario
    const existing = connectedUsers.get(userId);
    if (existing) {
      existing.sockets.add(socket.id);
      existing.userData = { ...existing.userData, ...user, isOnline: true };
    } else {
      connectedUsers.set(userId, { userData: { ...user, isOnline: true }, sockets: new Set([socket.id]) });
    }

    // 🔥 Firebase sync
    try {
      const userDoc = db.collection(USERS_COLLECTION).doc(userId);
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

    io.emit("connected_users", Array.from(connectedUsers.values()).map(u => ({
      ...u.userData,
      socketCount: u.sockets.size
    })));

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
  // 🔴 Desconexión (multi-socket segura)
  // ============================================================
  socket.on("disconnect", () => {
    const userId = socketToUserMap.get(socket.id);
    if (!userId) return;

    const entry = connectedUsers.get(userId);
    if (!entry) return;

    entry.sockets.delete(socket.id);
    socketToUserMap.delete(socket.id);

    if (entry.sockets.size === 0) {
      connectedUsers.delete(userId);
      userToRoomMap.delete(userId);
      console.log(`${colors.red}🔴 Usuario ${userId} sin sesiones activas, eliminado.${colors.reset}`);
    } else {
      console.log(`${colors.yellow}⚪ Usuario ${userId} cerró una sesión (${entry.sockets.size} restantes).${colors.reset}`);
    }

    io.emit("connected_users", Array.from(connectedUsers.values()).map(u => ({
      ...u.userData,
      socketCount: u.sockets.size
    })));
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
