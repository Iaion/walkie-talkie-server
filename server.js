// ============================================================
// 🌐 Servidor Node.js con Socket.IO, Firebase Firestore y Storage
// 💬 Compatible con tu app Android (SocketRepository + ChatViewModel actual)
// 🎨 Logs detallados con emojis, colores y seguimiento completo
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
};

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e8,
});

app.use(cors());
app.use(express.json());

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
  console.log(`${colors.cyan}✅ Nuevo socket conectado:${colors.reset} ${socket.id}`);

  // ============================================================
  // 🧩 Usuario conectado
  // ============================================================
  socket.on("user-connected", async (user, ack) => {
    console.log(`${colors.blue}📥 user-connected:${colors.reset}`, user);
    if (!user || !user.id || !user.username) {
      const msg = "⚠️ Datos de usuario inválidos";
      console.warn(`${colors.yellow}${msg}${colors.reset}`);
      return ack?.({ success: false, message: msg });
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
      console.log(`${colors.green}🔑 Usuario sincronizado en Firebase: ${user.username}${colors.reset}`);
    } catch (error) {
      console.error(`${colors.red}❌ Error registrando usuario en Firebase:${colors.reset}`, error);
    }

    io.emit("connected_users", Array.from(connectedUsers.values()));
    socket.emit("room_list", serializeRooms());
    ack?.({ success: true });
  });

  // ============================================================
  // 🚪 Unión de salas
  // ============================================================
  socket.on("join_room", (data = {}, ack) => {
    const roomName = data.room || data.roomId || "salas";
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
      const msg = `ℹ️ ${username} ya estaba en ${roomName}`;
      socket.emit("room_joined", { roomId: roomName, username, userCount: room.users.size });
      console.log(`${colors.yellow}${msg}${colors.reset}`);
      return ack?.({ success: true, roomId: roomName, message: msg });
    }

    // 👋 Salir de sala anterior
    const prevRoomId = userToRoomMap.get(userId);
    if (prevRoomId && rooms.has(prevRoomId)) {
      const prev = rooms.get(prevRoomId);
      prev.users.delete(userId);
      socket.leave(prevRoomId);
      io.to(prevRoomId).emit("user-left-room", { roomId: prevRoomId, userCount: prev.users.size });
      console.log(`${colors.gray}👋 ${username} salió de ${prevRoomId}${colors.reset}`);
    }

    // 🚪 Unirse a nueva sala
    socket.join(roomName);
    room.users.add(userId);
    userToRoomMap.set(userId, roomName);

    const users = getRoomUsers(roomName);
    socket.emit("room_joined", { roomId: roomName, username, userCount: users.length });
    io.to(roomName).emit("user-joined-room", { roomId: roomName, username, userCount: users.length });

    console.log(`${colors.green}✅ ${username} se unió a ${roomName}${colors.reset}`);
    ack?.({ success: true, roomId: roomName, message: `Te uniste a ${roomName}` });
  });

  socket.on("get_profile", (data, ack) => {
  const userId = data.userId;
  // Obtener perfil desde Firestore:
  db.collection("users").doc(userId).get().then(doc => {
    if (!doc.exists) return ack({ success: false, message: "Usuario no encontrado" });
    ack({ success: true, user: doc.data() });
  }).catch(err => ack({ success: false, message: err.message }));
});

socket.on("update_profile", (data, ack) => {
  const userId = data.userId;
  db.collection("users").doc(userId).update(data)
    .then(() => ack({ success: true, user: data }))
    .catch(err => ack({ success: false, message: err.message }));
});

socket.on("update_status", (data, ack) => {
  const userId = data.userId;
  db.collection("users").doc(userId).update({
    status: data.status,
    presence: data.presence
  }).then(() => ack({ success: true }))
    .catch(err => ack({ success: false, message: err.message }));
});


  // ============================================================
  // 💬 Mensajes de texto
  // ============================================================
  socket.on("send_message", async (data = {}, ack) => {
    const { userId, username, roomId, text } = data;
    console.log(`${colors.cyan}💬 send_message:${colors.reset}`, data);

    if (!userId || !username || !roomId || !text) {
      const msg = "❌ Datos de mensaje inválidos";
      return ack?.({ success: false, message: msg });
    }

    const message = { id: uuidv4(), userId, username, roomId, text, timestamp: Date.now() };

    try {
      await db.collection(MESSAGES_COLLECTION).add(message);
      io.to(roomId).emit("new_message", message);
      socket.emit("message_sent", message);
      console.log(`${colors.green}💬 ${username} → [${roomId}]: ${text}${colors.reset}`);
      ack?.({ success: true, message: "Mensaje entregado" });
    } catch (err) {
      console.error(`${colors.red}❌ Error guardando mensaje:${colors.reset}`, err);
      ack?.({ success: false, message: "Error guardando mensaje" });
    }
  });

  // ============================================================
  // 🎧 Mensajes de audio
  // ============================================================
  socket.on("audio_message", async (data = {}, ack) => {
    const { userId, username, audioData, roomId } = data;
    console.log(`${colors.blue}🎧 audio_message:${colors.reset}`, roomId);
    if (!audioData || !userId || !roomId) {
      return ack?.({ success: false, message: "Datos de audio inválidos" });
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
      console.log(`${colors.green}🎤 Audio de ${username} en [${roomId}] guardado.${colors.reset}`);
      ack?.({ success: true, message: "Audio enviado correctamente", audioUrl: url });
    } catch (err) {
      console.error(`${colors.red}❌ Error subiendo audio:${colors.reset}`, err);
      ack?.({ success: false, message: "Error subiendo audio" });
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
  console.log(`${colors.green}🚀 Servidor de chat corriendo en puerto ${PORT}${colors.reset}`);
  console.log(`${colors.cyan}🌐 http://localhost:${PORT}${colors.reset}`);
});
