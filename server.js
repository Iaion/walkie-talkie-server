// ============================================================
// 🌐 Servidor Node.js de Chat en Tiempo Real
// 💬 Soporta texto, audio, archivos, escritura, presencia, ACKs
// 🔥 Conectado a Firebase Firestore + Storage
// ============================================================

require("dotenv").config();

const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const admin = require("firebase-admin");
const { Buffer } = require("buffer");

// 🎨 Colores ANSI para logs
const colors = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
};

// ============================================================
// 🚀 Inicialización básica
// ============================================================
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e8, // 100MB para audio/archivos
});

app.use(cors());
app.use(express.json({ limit: "100mb" }));

// ============================================================
// 🔥 Configurar Firebase
// ============================================================
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || !process.env.FIREBASE_STORAGE_BUCKET) {
  console.error(`${colors.red}❌ Falta configuración de Firebase (GOOGLE_APPLICATION_CREDENTIALS_JSON / FIREBASE_STORAGE_BUCKET)${colors.reset}`);
  process.exit(1);
}

try {
  const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
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
// 🧠 Estado en memoria
// ============================================================
const connectedUsers = new Map(); // userId -> { id, username, socketId }
const socketToUserMap = new Map(); // socket.id -> userId
const userToRoomMap = new Map(); // userId -> roomId
const rooms = new Map();

// Crear salas iniciales
function createRoom(id, name, description, type) {
  return { id, name, description, type, users: new Set(), isPrivate: false, currentSpeaker: null };
}

rooms.set("general", createRoom("general", "Chat General", "Sala principal", "general"));
rooms.set("handy", createRoom("handy", "Radio Handy", "PTT", "ptt"));
rooms.set("salas", createRoom("salas", "Lobby", "Selección de salas", "lobby"));

// ============================================================
// 🔧 Helpers
// ============================================================
function serializeRoom(room) {
  return {
    id: room.id,
    name: room.name,
    description: room.description,
    userCount: room.users.size,
    maxUsers: 200,
    type: room.type,
    isPrivate: room.isPrivate,
    currentSpeakerId: room.currentSpeaker || null,
  };
}

function getRoomUsers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.users).map((id) => connectedUsers.get(id)).filter(Boolean);
}

async function saveMessageToFirestore(message) {
  try {
    await db.collection(MESSAGES_COLLECTION).add(message);
  } catch (err) {
    console.error(`${colors.red}❌ Error guardando mensaje en Firestore:${colors.reset}`, err);
  }
}

// ============================================================
// 🌐 Endpoints REST
// ============================================================
app.get("/health", (_, res) => res.status(200).send("Servidor de chat operativo 🚀"));
app.get("/rooms", (_, res) => res.json(Array.from(rooms.values()).map(serializeRoom)));
app.get("/users", (_, res) => res.json(Array.from(connectedUsers.values())));

// ✅ Devuelve mensajes de una sala (historial)
app.get("/messages/:roomId", async (req, res) => {
  try {
    const { roomId } = req.params;
    const snapshot = await db
      .collection(MESSAGES_COLLECTION)
      .where("roomId", "==", roomId)
      .orderBy("timestamp", "asc")
      .limit(200)
      .get();
    const messages = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 🔌 Lógica principal de chat (Socket.IO)
// ============================================================
io.on("connection", (socket) => {
  console.log(`${colors.cyan}✅ Nuevo cliente conectado:${colors.reset} ${socket.id}`);

  // 🧩 Usuario conectado
  socket.on("user-connected", async (user) => {
    try {
      if (!user || !user.id || !user.username) {
        console.warn(`${colors.yellow}⚠️ user-connected inválido${colors.reset}`);
        return;
      }
      socketToUserMap.set(socket.id, user.id);
      connectedUsers.set(user.id, { ...user, socketId: socket.id, isOnline: true });

      await db.collection(USERS_COLLECTION).doc(user.id).set(
        { ...user, isOnline: true, lastLogin: Date.now() },
        { merge: true }
      );

      io.emit("connected_users", Array.from(connectedUsers.values()));
      socket.emit("room_list", Array.from(rooms.values()).map(serializeRoom));
      console.log(`${colors.green}👤 Usuario conectado:${colors.reset} ${user.username}`);
    } catch (error) {
      console.error(`${colors.red}❌ Error en user-connected:${colors.reset}`, error);
    }
  });

  // Aux: dejar sala actual
  const leaveCurrentRoom = (userId, s) => {
    const prev = userToRoomMap.get(userId);
    if (prev && rooms.has(prev)) {
      const room = rooms.get(prev);
      room.users.delete(userId);
      s.leave(prev);
      io.to(prev).emit("user-left-room", { roomId: prev, userCount: room.users.size });
      console.log(`${colors.yellow}👋 ${userId} salió de ${prev}${colors.reset}`);
    }
  };

  // 🚪 Unirse a una sala (con ACK)
  socket.on("join_room", (data = {}, ack) => {
    const roomName = data.room || data.roomId;
    const { userId, username } = data;
    console.log(`${colors.magenta}📥 join_room:${colors.reset}`, data);

    if (!roomName || !userId || !username) {
      const msg = "❌ Datos de unión incompletos";
      socket.emit("join_error", { message: msg });
      return ack?.({ success: false, message: msg });
    }
    if (!rooms.has(roomName)) {
      const msg = `❌ Sala ${roomName} no existe`;
      socket.emit("join_error", { message: msg });
      return ack?.({ success: false, message: msg });
    }

    const room = rooms.get(roomName);
    const current = userToRoomMap.get(userId);

    if (current === roomName) {
      socket.emit("room_joined", { roomId: roomName, username, userCount: room.users.size });
      console.log(`${colors.yellow}ℹ️ ${username} ya estaba en ${roomName}${colors.reset}`);
      return ack?.({ success: true, roomId: roomName, message: "Ya estabas en la sala" });
    }

    leaveCurrentRoom(userId, socket);
    socket.join(roomName);
    room.users.add(userId);
    userToRoomMap.set(userId, roomName);

    const users = getRoomUsers(roomName);

    socket.emit("room_joined", { roomId: roomName, username, userCount: users.length });
    io.to(roomName).emit("user-joined-room", { roomId: roomName, userCount: users.length });
    console.log(`${colors.green}✅ ${username} se unió a ${roomName}${colors.reset}`);

    return ack?.({ success: true, roomId: roomName, message: `Te uniste a ${roomName}` });
  });

  // ✍️ Estado de escritura
  socket.on("typing", (data = {}) => {
    const { roomId, username, isTyping } = data;
    if (!roomId || !username) return;
    socket.to(roomId).emit("user_typing", { roomId, username, isTyping: !!isTyping });
  });

  // 💬 Enviar mensaje de texto (con ACK + persistencia)
  socket.on("send_message", async (data = {}, ack) => {
    try {
      const { userId, username, roomId, text } = data;
      if (!userId || !roomId || !text) {
        return ack?.({ success: false, message: "Datos de mensaje inválidos" });
      }

      const message = {
        id: uuidv4(),
        userId,
        username,
        roomId,
        text,
        timestamp: Date.now(),
        type: "text",
        status: "sent",
      };

      await saveMessageToFirestore(message);

      io.to(roomId).emit("new_message", message);
      socket.emit("message_sent", message);
      console.log(`${colors.green}💬 [${roomId}] ${username}:${colors.reset} ${text}`);

      return ack?.({ success: true, message: "Mensaje entregado", data: message });
    } catch (err) {
      console.error(`${colors.red}❌ Error en send_message:${colors.reset}`, err);
      return ack?.({ success: false, message: "Error interno" });
    }
  });

  // 🎧 Enviar mensaje de audio (base64 → Storage) con ACK
  socket.on("audio_message", async (data = {}, ack) => {
    try {
      const { userId, username, roomId, audioData } = data;
      if (!audioData || !userId || !roomId) {
        return ack?.({ success: false, message: "Datos de audio inválidos" });
      }

      const buffer = Buffer.from(audioData, "base64");
      const filePath = `audios/${roomId}/${userId}_${Date.now()}_${uuidv4()}.m4a`;
      const file = bucket.file(filePath);
      await file.save(buffer, { contentType: "audio/m4a", resumable: false });
      await file.makePublic();
      const url = file.publicUrl();

      const message = {
        id: uuidv4(),
        userId,
        username,
        roomId,
        audioUrl: url,
        timestamp: Date.now(),
        type: "audio",
        status: "sent",
      };

      await saveMessageToFirestore(message);
      io.to(roomId).emit("new_message", message);
      socket.emit("message_sent", message);
      console.log(`${colors.green}🎤 [${roomId}] Audio de ${username}${colors.reset}`);

      return ack?.({ success: true, message: "Audio entregado", data: message });
    } catch (err) {
      console.error(`${colors.red}❌ Error subiendo audio:${colors.reset}`, err);
      return ack?.({ success: false, message: "Error subiendo audio" });
    }
  });

  // 📎 Enviar archivos genéricos (base64) con ACK
  socket.on("file_message", async (data = {}, ack) => {
    try {
      const { userId, username, roomId, fileName, fileData, mimeType } = data;
      if (!fileData || !roomId) {
        return ack?.({ success: false, message: "Datos de archivo inválidos" });
      }

      const buffer = Buffer.from(fileData, "base64");
      const safeName = (fileName || "file").replace(/[^\w.\-]/g, "_");
      const filePath = `files/${roomId}/${Date.now()}_${safeName}`;
      const file = bucket.file(filePath);
      await file.save(buffer, { contentType: mimeType || "application/octet-stream", resumable: false });
      await file.makePublic();
      const url = file.publicUrl();

      const message = {
        id: uuidv4(),
        userId,
        username,
        roomId,
        fileUrl: url,
        fileName: safeName,
        mimeType: mimeType || "application/octet-stream",
        timestamp: Date.now(),
        type: "file",
        status: "sent",
      };

      await saveMessageToFirestore(message);
      io.to(roomId).emit("new_message", message);
      socket.emit("message_sent", message);
      console.log(`${colors.blue}📎 [${roomId}] Archivo ${safeName} de ${username}${colors.reset}`);

      return ack?.({ success: true, message: "Archivo enviado", data: message });
    } catch (err) {
      console.error(`${colors.red}❌ Error subiendo archivo:${colors.reset}`, err);
      return ack?.({ success: false, message: "Error subiendo archivo" });
    }
  });

  // 👀 Confirmación de lectura
  socket.on("message_read", (data = {}) => {
    const { messageId, roomId, userId } = data;
    if (!messageId || !roomId || !userId) return;
    io.to(roomId).emit("message_read_update", { messageId, roomId, userId, readAt: Date.now() });
  });

  // ❌ Desconexión
  socket.on("disconnect", () => {
    const userId = socketToUserMap.get(socket.id);
    if (userId) {
      const room = userToRoomMap.get(userId);
      if (room && rooms.has(room)) {
        rooms.get(room).users.delete(userId);
        io.to(room).emit("user-left-room", { roomId: room, userId });
      }
      connectedUsers.delete(userId);
      socketToUserMap.delete(socket.id);
      userToRoomMap.delete(userId);
      io.emit("connected_users", Array.from(connectedUsers.values()));
      console.log(`${colors.red}🔴 Usuario desconectado:${colors.reset} ${userId}`);
    } else {
      console.log(`${colors.red}🔴 Socket desconectado sin userId:${colors.reset} ${socket.id}`);
    }
  });
});

// ============================================================
// 🚀 Iniciar servidor
// ============================================================
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`${colors.green}🚀 Servidor de chat corriendo en puerto ${PORT}${colors.reset}`);
  console.log(`${colors.cyan}🌐 http://localhost:${PORT}${colors.reset}`);
});
