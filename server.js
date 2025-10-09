// ============================================================
// 🌐 Servidor Node.js con Socket.IO, Firebase Firestore y Storage
// 💬 Compatible con tu app Android (SocketRepository + ChatViewModel actual)
// 🪲 DEBUG EXTREMO: Logs detallados en unión, mensajes, audio y perfil
// ============================================================

const BUILD_VERSION = "v2025-10-09_15-10"; // ⬅️ cambia esto en cada deploy

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
  maxHttpBufferSize: 1e8,
});

app.use(cors());
app.use(express.json({ limit: "50mb" }));

// ============================================================
// 🔥 Firebase
// ============================================================
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS || !process.env.FIREBASE_STORAGE_BUCKET) {
  console.error(`${colors.red}❌ Falta GOOGLE_APPLICATION_CREDENTIALS o FIREBASE_STORAGE_BUCKET${colors.reset}`);
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
const connectedUsers = new Map();   // userId -> {user}
const socketToUserMap = new Map();  // socketId -> userId
const rooms = new Map();            // roomId -> {id, name, ... , users:Set<userId>}
const userToRoomMap = new Map();    // userId -> roomId

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
const serializeRoom = (room) => ({
  id: room.id,
  name: room.name,
  description: room.description,
  userCount: room.users.size,
  maxUsers: 50,
  type: room.type,
  isPrivate: !!room.isPrivate,
});
const serializeRooms = () => Array.from(rooms.values()).map(serializeRoom);
const getRoomUsers = (roomId) => {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.users).map((id) => connectedUsers.get(id)).filter(Boolean);
};

// ============================================================
// 🌐 Endpoints REST
// ============================================================
app.get("/health", (_, res) => res.status(200).send("OK 🚀"));
app.get("/version", (_, res) =>
  res.json({ version: BUILD_VERSION, startedAt: new Date().toISOString() })
);
app.get("/users", (_, res) => res.json(Array.from(connectedUsers.values())));
app.get("/rooms", (_, res) => res.json(serializeRooms()));

// ============================================================
// 🔌 Socket.IO
// ============================================================
io.on("connection", (socket) => {
  console.log(`${colors.cyan}🔗 NUEVA CONEXIÓN:${colors.reset} ${socket.id}`);

  // ============================================================
  // 🧩 Usuario conectado
  // ============================================================
  socket.on("user-connected", async (user, ack) => {
    console.log(`${colors.blue}📥 user-connected:${colors.reset}`, user);
    try {
      if (!user || !user.id || !user.username) {
        const msg = "⚠️ Datos de usuario inválidos";
        console.warn(`${colors.yellow}${msg}${colors.reset}`);
        return ack?.({ success: false, message: msg });
      }

      socketToUserMap.set(socket.id, user.id);
      connectedUsers.set(user.id, { ...user, socketId: socket.id, isOnline: true });

      const userDoc = db.collection(USERS_COLLECTION).doc(user.id);
      const snapshot = await userDoc.get();
      if (snapshot.exists) {
        await userDoc.update({ ...user, isOnline: true, lastLogin: Date.now() });
      } else {
        await userDoc.set({ ...user, isOnline: true, createdAt: Date.now() });
      }
      console.log(`${colors.green}🔑 Usuario sincronizado en Firebase: ${user.username}${colors.reset}`);

      io.emit("connected_users", Array.from(connectedUsers.values()));
      socket.emit("room_list", serializeRooms());
      ack?.({ success: true });
      console.log(`${colors.green}✅ ACK user-connected${colors.reset}`);
    } catch (error) {
      console.error(`${colors.red}❌ user-connected error:${colors.reset}`, error);
      ack?.({ success: false, message: error.message || "internal_error" });
    }
  });

  // ============================================================
  // 🚪 Unirse a sala
  // ============================================================
  socket.on("join_room", (data = {}, ack) => {
    console.log(`${colors.magenta}🚪 join_room:${colors.reset}`, data);

    const roomName = data.room || data.roomId || "salas";
    const { userId, username } = data;

    if (!roomName || !userId || !username) {
      const message = "❌ Datos de unión incompletos";
      socket.emit("join_error", { message });
      ack?.({ success: false, message });
      console.warn(`${colors.red}${message}${colors.reset}`);
      return;
    }

    if (!rooms.has(roomName)) {
      const message = `❌ Sala ${roomName} no existe`;
      socket.emit("join_error", { message });
      ack?.({ success: false, message });
      console.warn(`${colors.red}${message}${colors.reset}`);
      return;
    }

    const current = userToRoomMap.get(userId);
    if (current === roomName) {
      const message = `ℹ️ ${username} ya estaba en ${roomName}`;
      socket.emit("join_success", { success: true, roomId: roomName, message });
      ack?.({ success: true, roomId: roomName, message });
      console.log(`${colors.yellow}${message}${colors.reset}`);
      return;
    }

    // 👋 Salir de la sala anterior si corresponde
    const prevRoomId = userToRoomMap.get(userId);
    if (prevRoomId && rooms.has(prevRoomId)) {
      const prev = rooms.get(prevRoomId);
      prev.users.delete(userId);
      socket.leave(prevRoomId);
      io.to(prevRoomId).emit("user-left-room", { roomId: prevRoomId, userCount: prev.users.size });
      console.log(`${colors.gray}👋 ${username} salió de ${prevRoomId}${colors.reset}`);
    }

    // 🚪 Unirse a nueva sala
    const room = rooms.get(roomName);
    socket.join(roomName);
    room.users.add(userId);
    userToRoomMap.set(userId, roomName);

    const users = getRoomUsers(roomName);
    io.to(roomName).emit("user-joined-room", { roomId: roomName, username, userCount: users.length });

    const ok = { success: true, roomId: roomName, message: `Te uniste a ${roomName}` };
    socket.emit("join_success", ok);
    ack?.(ok);

    console.log(`${colors.green}✅ ${username} se unió a ${roomName}${colors.reset}`);
    console.log(`${colors.green}✅ ACK join_room (${roomName})${colors.reset}`);
  });

  // ============================================================
  // 🚪 Salir de sala (soporte para SocketRepository.leaveRoom)
  // ============================================================
  socket.on("leave_room", (data = {}, ack) => {
    console.log(`${colors.magenta}🚪 leave_room:${colors.reset}`, data);
    const { userId, roomId, username } = data || {};
    if (!userId || !roomId) {
      const message = "❌ Datos inválidos en leave_room";
      ack?.({ success: false, message });
      console.warn(`${colors.red}${message}${colors.reset}`);
      return;
    }

    const cur = userToRoomMap.get(userId);
    if (cur === roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.users.delete(userId);
      socket.leave(roomId);
      userToRoomMap.delete(userId);
      io.to(roomId).emit("user-left-room", { roomId, userCount: room.users.size });
      io.to(socket.id).emit("left_room", { roomId });
      console.log(`${colors.gray}👋 ${username || userId} dejó ${roomId}${colors.reset}`);
    } else {
      console.log(`${colors.yellow}ℹ️ leave_room ignorado: el usuario no estaba en ${roomId}${colors.reset}`);
    }
    ack?.({ success: true, roomId });
  });

  // ============================================================
  // 👤 Perfil: get_profile
  // ============================================================
  socket.on("get_profile", async (data = {}, ack) => {
    console.log(`${colors.cyan}👤 get_profile:${colors.reset}`, data);
    try {
      const { userId } = data || {};
      if (!userId) return ack?.({ success: false, message: "userId requerido" });

      const snap = await db.collection(USERS_COLLECTION).doc(userId).get();
      if (!snap.exists) return ack?.({ success: false, message: "Usuario no encontrado" });

      const user = snap.data();
      ack?.({ success: true, ...user }); // tu Android espera un JSONObject "user" o plano; dejamos plano + success
      console.log(`${colors.green}✅ ACK get_profile (${userId})${colors.reset}`);
    } catch (err) {
      console.error(`${colors.red}❌ get_profile error:${colors.reset}`, err);
      ack?.({ success: false, message: err.message || "internal_error" });
    }
  });

  // ============================================================
  // 👤 Perfil: update_profile
  // ============================================================
  socket.on("update_profile", async (data = {}, ack) => {
    console.log(`${colors.cyan}📝 update_profile:${colors.reset}`, data);
    try {
      const { userId } = data || {};
      if (!userId) return ack?.({ success: false, message: "userId requerido" });

      await db.collection(USERS_COLLECTION).doc(userId).set(data, { merge: true });
      ack?.({ success: true, user: data });
      console.log(`${colors.green}✅ ACK update_profile (${userId})${colors.reset}`);
    } catch (err) {
      console.error(`${colors.red}❌ update_profile error:${colors.reset}`, err);
      ack?.({ success: false, message: err.message || "internal_error" });
    }
  });

  // ============================================================
  // 👤 Perfil: update_status (estado/presencia)
  // ============================================================
  socket.on("update_status", async (data = {}, ack) => {
    console.log(`${colors.cyan}🟢 update_status:${colors.reset}`, data);
    try {
      const { userId, status, presence } = data || {};
      if (!userId) return ack?.({ success: false, message: "userId requerido" });

      await db.collection(USERS_COLLECTION).doc(userId).set(
        { status: status || "Online", presence: presence || "Available", updatedAt: Date.now() },
        { merge: true }
      );
      ack?.({ success: true });
      console.log(`${colors.green}✅ ACK update_status (${userId})${colors.reset}`);
    } catch (err) {
      console.error(`${colors.red}❌ update_status error:${colors.reset}`, err);
      ack?.({ success: false, message: err.message || "internal_error" });
    }
  });

  // ============================================================
  // 💬 Mensajes de texto
  // ============================================================
  socket.on("send_message", async (data = {}, ack) => {
    console.log(`${colors.cyan}💬 [RECV] send_message:${colors.reset}`, data);

    const { userId, username, roomId, text } = data || {};
    if (!userId || !username || !roomId || !text) {
      const message = "❌ Datos de mensaje inválidos";
      console.warn(`${colors.red}${message}${colors.reset}`);
      return ack?.({ success: false, message });
    }

    const message = { id: uuidv4(), userId, username, roomId, text, timestamp: Date.now() };

    try {
      console.log(`${colors.yellow}🗂️ Guardando mensaje en Firestore...${colors.reset}`);
      await db.collection(MESSAGES_COLLECTION).add(message);
      console.log(`${colors.green}✅ Mensaje guardado (${message.id}).${colors.reset}`);

      io.to(roomId).emit("new_message", message);
      socket.emit("message_sent", message);
      ack?.({ success: true, message: "Mensaje entregado", id: message.id });

      console.log(`${colors.green}💬 OK ${username} → [${roomId}]: ${text}${colors.reset}`);
      console.log(`${colors.green}✅ ACK send_message (${message.id})${colors.reset}`);
    } catch (err) {
      console.error(`${colors.red}❌ Error guardando mensaje:${colors.reset}`, err);
      ack?.({ success: false, message: "Error guardando mensaje" });
    }
  });

  // ============================================================
  // 🎧 Mensajes de audio
  // ============================================================
  socket.on("audio_message", async (data = {}, ack) => {
    console.log(`${colors.blue}🎧 [RECV] audio_message:${colors.reset}`, { roomId: data?.roomId, userId: data?.userId });

    const { userId, username, audioData, roomId } = data || {};
    if (!audioData || !userId || !roomId) {
      const message = "❌ Datos de audio inválidos";
      console.warn(`${colors.red}${message}${colors.reset}`);
      return ack?.({ success: false, message });
    }

    try {
      const buffer = Buffer.from(audioData, "base64");
      const filePath = `audios/${roomId}/${userId}_${Date.now()}_${uuidv4()}.m4a`;
      const file = bucket.file(filePath);

      console.log(`${colors.yellow}⬆️ Subiendo a Storage: ${filePath}${colors.reset}`);
      await file.save(buffer, { contentType: "audio/m4a", resumable: false });

      // ✅ Mejor: URL firmada (evita permisos públicos)
      const [signedUrl] = await file.getSignedUrl({
        action: "read",
        expires: Date.now() + 1000 * 60 * 60 * 24 * 7, // 7 días
      });

      // Si querés hacerlo público (no recomendado en prod):
      // await file.makePublic();
      // const signedUrl = file.publicUrl();

      const audioMsg = {
        id: uuidv4(),
        userId,
        username,
        roomId,
        audioUrl: signedUrl,
        timestamp: Date.now(),
      };

      await db.collection(MESSAGES_COLLECTION).add(audioMsg);
      console.log(`${colors.green}🗂️ Audio registrado en Firestore.${colors.reset}`);

      io.to(roomId).emit("new_message", audioMsg);
      socket.emit("message_sent", audioMsg);
      ack?.({ success: true, message: "Audio enviado correctamente", audioUrl: signedUrl });

      console.log(`${colors.green}🎤 OK Audio de ${username || userId} → [${roomId}]${colors.reset}`);
      console.log(`${colors.green}✅ ACK audio_message (${roomId})${colors.reset}`);
    } catch (err) {
      console.error(`${colors.red}❌ Error subiendo audio:${colors.reset}`, err);
      ack?.({ success: false, message: err.message || "Error subiendo audio" });
    }
  });

  // ============================================================
  // 📋 Datos auxiliares
  // ============================================================
  socket.on("get_rooms", (_, ack) => {
    const list = serializeRooms();
    console.log(`${colors.gray}📋 get_rooms solicitado.${colors.reset}`);
    socket.emit("room_list", list);
    ack?.({ success: true, rooms: list });
  });

  socket.on("get_users", (data = {}, ack) => {
    const { roomId } = data || {};
    const users = getRoomUsers(roomId || "general");
    console.log(`${colors.gray}👥 get_users sala=${roomId}${colors.reset}`);
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
      }
      connectedUsers.delete(userId);
      userToRoomMap.delete(userId);
      socketToUserMap.delete(socket.id);
      io.emit("connected_users", Array.from(connectedUsers.values()));
      console.log(`${colors.red}🔴 Usuario desconectado:${colors.reset} ${userId}`);
    } else {
      console.log(`${colors.red}🔴 Socket desconectado sin usuario:${colors.reset} ${socket.id}`);
    }
  });
});

// ============================================================
// 🚀 Iniciar servidor
// ============================================================
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`${colors.green}🚀 Servidor corriendo en puerto ${PORT}${colors.reset}`);
  console.log(`${colors.cyan}🌐 http://localhost:${PORT}${colors.reset}`);
  console.log(`${colors.yellow}🧩 Versión:${colors.reset} ${BUILD_VERSION}`);
});
