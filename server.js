// ============================================================
// 🌐 Servidor Node.js con Socket.IO, Firebase Firestore y Storage
// 💬 Compatible con tu app Android (SocketRepository + ChatViewModel actual)
// 🎨 Logs con colores y emojis para depuración
// ============================================================

const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const admin = require("firebase-admin");
const { Buffer } = require("buffer");

// 🎨 ANSI colors
const colors = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
};

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e8, // Permite audios grandes
});

app.use(cors());
app.use(express.json());

// ============================================================
// 🔥 Inicialización de Firebase
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
const connectedUsers = new Map(); // userId -> { id, username, socketId }
const socketToUserMap = new Map(); // socket.id -> userId
const rooms = new Map(); // roomId -> { id, name, users:Set }
const userToRoomMap = new Map(); // userId -> roomId

// ============================================================
// 🚪 Salas base
// ============================================================
const SALAS_ROOM_ID = "salas";
const GENERAL_ROOM_ID = "general";
const HANDY_ROOM_ID = "handy";

function createRoom(id, name, description, type) {
  return {
    id,
    name,
    description,
    users: new Set(),
    type,
    isPrivate: false,
  };
}

rooms.set(SALAS_ROOM_ID, createRoom("salas", "Lobby de Salas", "Pantalla de selección de salas", "lobby"));
rooms.set(GENERAL_ROOM_ID, createRoom("general", "Chat General", "Sala de chat público", "general"));
rooms.set(HANDY_ROOM_ID, createRoom("handy", "Radio Handy (PTT)", "Simulación de radio PTT", "ptt"));

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
  console.log(`${colors.cyan}✅ Nuevo socket conectado: ${socket.id}${colors.reset}`);

  // ============================================================
  // 🧩 Usuario conectado
  // ============================================================
  socket.on("user-connected", async (user) => {
    if (!user || !user.id || !user.username) {
      console.warn(`${colors.yellow}⚠️ Datos de usuario inválidos.${colors.reset}`);
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
      console.log(`${colors.green}🔑 Usuario sincronizado: ${user.username}${colors.reset}`);
    } catch (error) {
      console.error(`${colors.red}❌ Error registrando usuario en Firebase:${colors.reset}`, error);
    }

    io.emit("connected_users", Array.from(connectedUsers.values()));
    socket.emit("room_list", serializeRooms());
  });

  // ============================================================
  // 🚪 Unión de salas con ACK
  // ============================================================
  socket.on("join_room", (data = {}, ack) => {
    const roomName = data.room || data.roomId;
    const { userId, username } = data;

    console.log(`${colors.magenta}📥 join_room:${colors.reset}`, data);

    if (!roomName || !userId || !username) {
      const msg = "❌ Datos de unión incompletos";
      socket.emit("join_error", { message: msg });
      if (ack) ack({ success: false, message: msg });
      return;
    }

    if (!rooms.has(roomName)) {
      const msg = `❌ Sala ${roomName} no existe`;
      socket.emit("join_error", { message: msg });
      if (ack) ack({ success: false, message: msg });
      return;
    }

    const room = rooms.get(roomName);
    const current = userToRoomMap.get(userId);

    if (current === roomName) {
      const msg = `ℹ️ ${username} ya estaba en ${roomName}`;
      socket.emit("room_joined", { roomId: roomName, username, userCount: room.users.size });
      if (ack) ack({ success: true, roomId: roomName, message: msg });
      console.log(`${colors.yellow}${msg}${colors.reset}`);
      return;
    }

    // Salir de sala anterior
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
    io.to(roomName).emit("user-joined-room", { roomId: roomName, userCount: users.length });

    console.log(`${colors.green}✅ ${username} se unió a ${roomName}${colors.reset}`);
    if (ack) ack({ success: true, roomId: roomName, message: `Te has unido a ${roomName}` });
  });

  // ============================================================
  // 💬 Mensajes de texto
  // ============================================================
  socket.on("send_message", async (data = {}, ack) => {
    const { userId, username, roomId, text } = data;
    if (!userId || !username || !roomId || !text) {
      if (ack) ack({ success: false, message: "Datos de mensaje inválidos" });
      return;
    }

    const message = {
      id: uuidv4(),
      userId,
      username,
      roomId,
      text,
      timestamp: Date.now(),
    };

    try {
      await db.collection(MESSAGES_COLLECTION).add(message);
      io.to(roomId).emit("new_message", message);
      if (ack) ack({ success: true, message: "Mensaje entregado" });
      socket.emit("message_sent", message);
      console.log(`${colors.green}💬 ${username} → [${roomId}] ${colors.reset}${text}`);
    } catch (err) {
      console.error(`${colors.red}❌ Error guardando mensaje:${colors.reset}`, err);
      if (ack) ack({ success: false, message: "Error guardando mensaje" });
    }
  });

  // ============================================================
  // 🎧 Mensajes de audio
  // ============================================================
  socket.on("audio_message", async (data = {}) => {
    const { userId, username, audioData, roomId } = data;
    if (!audioData || !userId || !roomId) return;

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
      console.log(`${colors.green}🎤 Audio subido por ${username} (${roomId})${colors.reset}`);
    } catch (err) {
      console.error(`${colors.red}❌ Error subiendo audio:${colors.reset}`, err);
    }
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
      }
      connectedUsers.delete(userId);
      userToRoomMap.delete(userId);
      io.emit("connected_users", Array.from(connectedUsers.values()));
      socketToUserMap.delete(socket.id);
    }
    console.log(`${colors.red}🔴 Socket desconectado:${colors.reset} ${socket.id}`);
  });
});

// ============================================================
// 🚀 Iniciar servidor
// ============================================================
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`${colors.green}🚀 Servidor corriendo en puerto ${PORT}${colors.reset}`);
  console.log(`${colors.cyan}🌐 http://localhost:${PORT}${colors.reset}`);
});
