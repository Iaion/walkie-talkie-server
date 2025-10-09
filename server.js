// ============================================================
// 🌐 Servidor Node.js con Socket.IO, Firebase Firestore y Storage
// 💬 Compatible con tu app Android (SocketRepository + ChatViewModel actual)
// 🪲 Modo DEBUG EXTREMO: Logs detallados para cada paso de envío, unión y ACK
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
      console.warn(`${colors.red}${msg}${colors.reset}`);
      return;
    }

    if (!rooms.has(roomName)) {
      const msg = `❌ Sala ${roomName} no existe`;
      socket.emit("join_error", { message: msg });
      ack?.({ success: false, message: msg });
      console.warn(`${colors.red}${msg}${colors.reset}`);
      return;
    }

    const room = rooms.get(roomName);
    const current = userToRoomMap.get(userId);

    if (current === roomName) {
      const msg = `ℹ️ ${username} ya estaba en ${roomName}`;
      console.log(`${colors.yellow}${msg}${colors.reset}`);
      ack?.({ success: true, roomId: roomName, message: msg });
      return;
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

    console.log(`${colors.green}✅ ${username} se unió correctamente a ${roomName}${colors.reset}`);
    ack?.({ success: true, roomId: roomName, message: `Te uniste a ${roomName}` });
    console.log(`${colors.green}✅ ACK → join_room confirmado (${roomName})${colors.reset}`);
  });

  // ============================================================
  // 💬 Mensajes de texto - CON LOGS MEJORADOS
  // ============================================================
  socket.on("send_message", async (data = {}, ack) => {
    const timestamp = new Date().toISOString();
    console.log(`\n${colors.cyan}╔═══════════════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.cyan}║ 💬 [${timestamp}] MENSAJE RECIBIDO${colors.reset}`);
    console.log(`${colors.cyan}╠═══════════════════════════════════════════════════${colors.reset}`);
    
    // 📊 LOG DETALLADO DE LA INFORMACIÓN DEL MENSAJE
    console.log(`${colors.cyan}║ 📋 INFORMACIÓN DEL USUARIO:${colors.reset}`);
    console.log(`${colors.cyan}║    👤 User ID: ${colors.yellow}${data.userId || 'NO PROPORCIONADO'}${colors.reset}`);
    console.log(`${colors.cyan}║    🏷️  Username: ${colors.yellow}${data.username || 'NO PROPORCIONADO'}${colors.reset}`);
    console.log(`${colors.cyan}║    🆔 Socket ID: ${colors.yellow}${socket.id}${colors.reset}`);
    
    console.log(`${colors.cyan}║ 📍 INFORMACIÓN DE LA SALA:${colors.reset}`);
    console.log(`${colors.cyan}║    🏠 Room ID: ${colors.yellow}${data.roomId || 'NO PROPORCIONADO'}${colors.reset}`);
    const room = rooms.get(data.roomId);
    console.log(`${colors.cyan}║    👥 Usuarios en sala: ${colors.yellow}${room ? room.users.size : 'SALA NO ENCONTRADA'}${colors.reset}`);
    
    console.log(`${colors.cyan}║ 💭 CONTENIDO DEL MENSAJE:${colors.reset}`);
    console.log(`${colors.cyan}║    📝 Texto: ${colors.yellow}${data.text || 'NO PROPORCIONADO'}${colors.reset}`);
    console.log(`${colors.cyan}║    📏 Longitud: ${colors.yellow}${data.text ? data.text.length : 0} caracteres${colors.reset}`);
    
    console.log(`${colors.cyan}╠═══════════════════════════════════════════════════${colors.reset}`);

    const { userId, username, roomId, text } = data;
    if (!userId || !username || !roomId || !text) {
      const msg = "❌ Datos de mensaje inválidos";
      console.log(`${colors.cyan}║ ❌ ERROR: ${colors.red}${msg}${colors.reset}`);
      console.log(`${colors.cyan}╚═══════════════════════════════════════════════════${colors.reset}\n`);
      return ack?.({ success: false, message: msg });
    }

    const message = { id: uuidv4(), userId, username, roomId, text, timestamp: Date.now() };

    try {
      console.log(`${colors.cyan}║ 🗂️  Guardando mensaje en Firestore...${colors.reset}`);
      await db.collection(MESSAGES_COLLECTION).add(message);
      console.log(`${colors.cyan}║ ✅ Mensaje guardado correctamente en Firestore${colors.reset}`);
      console.log(`${colors.cyan}║ 🆔 ID del mensaje: ${colors.yellow}${message.id}${colors.reset}`);

      // 📤 Emitir mensaje a la sala
      const clientsInRoom = io.sockets.adapter.rooms.get(roomId)?.size || 0;
      console.log(`${colors.cyan}║ 📤 Enviando mensaje a la sala:${colors.reset}`);
      console.log(`${colors.cyan}║    🏠 Sala: ${colors.yellow}${roomId}${colors.reset}`);
      console.log(`${colors.cyan}║    👥 Clientes en sala: ${colors.yellow}${clientsInRoom}${colors.reset}`);
      
      io.to(roomId).emit("new_message", message);
      socket.emit("message_sent", message);
      
      console.log(`${colors.cyan}║ ✅ Mensaje emitido correctamente${colors.reset}`);
      console.log(`${colors.cyan}║ 💬 Resumen: ${colors.green}${username} → [${roomId}]: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}${colors.reset}`);
      
      ack?.({ success: true, message: "Mensaje entregado", id: message.id });
      console.log(`${colors.cyan}║ ✅ ACK enviado al cliente${colors.reset}`);
      
    } catch (err) {
      console.error(`${colors.cyan}║ ❌ Error al procesar mensaje:${colors.red}`, err);
      ack?.({ success: false, message: "Error guardando mensaje" });
    }
    
    console.log(`${colors.cyan}╚═══════════════════════════════════════════════════${colors.reset}\n`);
  });

  // ============================================================
  // 🎧 Mensajes de audio
  // ============================================================
  socket.on("audio_message", async (data = {}, ack) => {
    console.log(`${colors.blue}🎧 [RECV] → audio_message recibido${colors.reset}`, data.roomId);

    const { userId, username, audioData, roomId } = data;
    if (!audioData || !userId || !roomId) {
      const msg = "❌ Datos de audio inválidos";
      console.warn(`${colors.red}${msg}${colors.reset}`);
      return ack?.({ success: false, message: msg });
    }

    try {
      console.log(`${colors.yellow}⬆️ Subiendo archivo a Firebase Storage...${colors.reset}`);
      const buffer = Buffer.from(audioData, "base64");
      const filePath = `audios/${roomId}/${userId}_${Date.now()}_${uuidv4()}.m4a`;
      const file = bucket.file(filePath);
      await file.save(buffer, { contentType: "audio/m4a", resumable: false });
      console.log(`${colors.green}✅ Archivo subido: ${filePath}${colors.reset}`);

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
      console.log(`${colors.green}🗂️ Audio registrado en Firestore.${colors.reset}`);

      io.to(roomId).emit("new_message", audioMsg);
      socket.emit("message_sent", audioMsg);

      console.log(`${colors.green}🎤 [OK] Audio de ${username} emitido a [${roomId}] → ${url}${colors.reset}`);
      ack?.({ success: true, message: "Audio enviado correctamente", audioUrl: url });
      console.log(`${colors.green}✅ ACK → audio_message confirmado (${roomId})${colors.reset}`);
    } catch (err) {
      console.error(`${colors.red}❌ Error al procesar audio:${colors.reset}`, err);
      ack?.({ success: false, message: "Error subiendo audio" });
    }
  });

  // ============================================================
  // 📋 Solicitudes de datos
  // ============================================================
  socket.on("get_rooms", (_, ack) => {
    const list = serializeRooms();
    console.log(`${colors.gray}📋 [RECV] get_rooms solicitado.${colors.reset}`);
    socket.emit("room_list", list);
    ack?.({ success: true, rooms: list });
  });

  socket.on("get_users", (data = {}, ack) => {
    const { roomId } = data;
    const users = getRoomUsers(roomId || "general");
    console.log(`${colors.gray}👥 [RECV] get_users → sala:${roomId}${colors.reset}`);
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