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
// 📦 Estado en memoria (robusto, multi-socket)
// ============================================================
// userId -> { userData, sockets: Set<socketId> }
const connectedUsers = new Map();
// socketId -> userId
const socketToUserMap = new Map();
// socketId -> roomId (sala por socket, evita “patearse” entre dispositivos)
const socketToRoomMap = new Map();
// userId -> lastRoomId (para rejoin automático)
const userToRoomMap = new Map();

const rooms = new Map();

// 🆕 Estado PTT: 1 solo hablante por sala
// { roomId: { speakerId, speakerName, startedAt } }
const pttState = {};

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
  // Devolvemos info de usuario (una sola vez por userId), independientemente de la cantidad de sockets
  return Array.from(room.users)
    .map((userId) => {
      const entry = connectedUsers.get(userId);
      return entry ? { ...entry.userData, isOnline: true } : null;
    })
    .filter(Boolean);
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

    // 👥 Multi-socket por usuario
    const existing = connectedUsers.get(userId);
    if (existing) {
      existing.sockets.add(socket.id);
      existing.userData = { ...existing.userData, ...user, isOnline: true };
    } else {
      connectedUsers.set(userId, { userData: { ...user, isOnline: true }, sockets: new Set([socket.id]) });
    }

    // 🆕 Reasociar a última sala si existe
    const lastRoom = userToRoomMap.get(userId);
    if (lastRoom && rooms.has(lastRoom)) {
      socket.join(lastRoom);
      socketToRoomMap.set(socket.id, lastRoom);
      rooms.get(lastRoom).users.add(userId);

      // Enviar doble confirmación para tu cliente (ACK + evento)
      socket.emit("join_success", { room: lastRoom, roomId: lastRoom, message: "Reingreso automático" });
      console.log(`${colors.green}🔁 ${user.username} reingresó a ${lastRoom}${colors.reset}`);
    }

    // 🔥 Firebase
    try {
      const userDoc = db.collection(USERS_COLLECTION).doc(userId);
      await userDoc.set({ ...user, isOnline: true, lastLogin: Date.now() }, { merge: true });
      console.log(`${colors.green}🔑 Usuario sincronizado con Firebase: ${user.username}${colors.reset}`);
    } catch (error) {
      console.error(`${colors.red}❌ Error al registrar usuario:${colors.reset}`, error);
    }

    io.emit(
      "connected_users",
      Array.from(connectedUsers.values()).map((u) => ({ ...u.userData, socketCount: u.sockets.size }))
    );
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

    // ⚠️ OJO: mapeamos la sala por *socket*, no por usuario (para multi-dispositivo)
    const prevRoomId = socketToRoomMap.get(socket.id);
    if (prevRoomId && rooms.has(prevRoomId)) {
      const prev = rooms.get(prevRoomId);
      socket.leave(prevRoomId);
      // Si no quedan otros sockets del mismo usuario en esa sala, quitar userId del Set
      const stillInPrev = Array.from(connectedUsers.get(userId)?.sockets || []).some(
        (sid) => socketToRoomMap.get(sid) === prevRoomId && sid !== socket.id
      );
      if (!stillInPrev) {
        prev.users.delete(userId);
        io.to(prevRoomId).emit("user-left-room", { roomId: prevRoomId, userCount: prev.users.size });
      }
    }

    socket.join(roomName);
    socketToRoomMap.set(socket.id, roomName);
    userToRoomMap.set(userId, roomName); // última sala conocida (para rejoin automático)
    rooms.get(roomName).users.add(userId);

    const users = getRoomUsers(roomName);
    // Doble confirmación: evento + ACK
    socket.emit("join_success", { room: roomName, roomId: roomName, userCount: users.length });
    io.to(roomName).emit("user-joined-room", { roomId: roomName, username, userCount: users.length });

    console.log(`${colors.green}✅ ${username} se unió correctamente a ${roomName}${colors.reset}`);
    ack?.({ success: true, room: roomName, roomId: roomName, message: `Te uniste a ${roomName}` });
  });

  // ============================================================
  // 🚪 Salir de sala (tu app lo emite)
  // ============================================================
  socket.on("leave_room", (data = {}, ack) => {
    const { roomId, userId, username } = data || {};
    const currentRoom = socketToRoomMap.get(socket.id) || roomId;

    if (!currentRoom || !rooms.has(currentRoom) || !userId) {
      const msg = "⚠️ leave_room: datos inválidos";
      ack?.({ success: false, message: msg });
      return;
    }

    socket.leave(currentRoom);
    socketToRoomMap.delete(socket.id);

    // ¿Queda otro socket de este usuario en la misma sala?
    const hasAnotherSocketInRoom = Array.from(connectedUsers.get(userId)?.sockets || []).some(
      (sid) => socketToRoomMap.get(sid) === currentRoom
    );

    if (!hasAnotherSocketInRoom) {
      const r = rooms.get(currentRoom);
      r.users.delete(userId);

      // Si era el hablante PTT, liberar token
      if (pttState[currentRoom] && pttState[currentRoom].speakerId === userId) {
        pttState[currentRoom] = null;
        io.to(currentRoom).emit("token_released", { roomId: currentRoom, currentSpeaker: null });
        io.to(currentRoom).emit("current_speaker_update", null);
        console.log(`${colors.red}🎙️ Token liberado (leave_room) por ${userId}${colors.reset}`);
      }

      io.to(currentRoom).emit("user-left-room", { roomId: currentRoom, username, userCount: r.users.size });
    }

    socket.emit("left_room", { roomId: currentRoom });
    ack?.({ success: true, roomId: currentRoom });
    console.log(`${colors.gray}👋 ${username || userId} salió de ${currentRoom}${colors.reset}`);
  });

  // ============================================================
  // 💬 Mensajes de texto
  // ============================================================
  socket.on("send_message", async (data = {}, ack) => {
    const { userId, username, roomId, text } = data;
    if (!userId || !username || !roomId || !text) {
      return ack?.({ success: false, message: "❌ Datos de mensaje inválidos" });
    }

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
  // 🎧 Mensajes de audio (base64 -> Storage)
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
        ...user,
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
        avatarUri = "",
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
// 👤 PERFIL: get_profile / update_profile (incluye avatar)
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
// 🔊 FUNCIONALIDAD PTT (Push-To-Talk)
// ============================================================
// ============================================================
// 🔊 FUNCIONALIDAD PTT (Push-To-Talk) con ACK extendido y expiración automática
// ============================================================

const TOKEN_TIMEOUT_MS = 10_000; // 10 segundos de inactividad
const tokenTimers = {}; // { roomId: timeoutId }

socket.on("request_talk_token", (data = {}, ack) => {
  const { roomId, userId, username } = data;

  console.log(`${colors.cyan}📥 Evento → request_talk_token${colors.reset} desde socket ${socket.id}`, data);
  console.log(`${colors.gray}📦 Salas del socket:${colors.reset}`, Array.from(socket.rooms));
  console.log(`${colors.gray}📊 pttState actual:${colors.reset}`, JSON.stringify(pttState, null, 2));

  if (!roomId || !userId) {
    const msg = "⚠️ request_talk_token: datos inválidos";
    console.warn(`${colors.yellow}${msg}${colors.reset}`, data);
    return ack?.({ success: false, message: msg });
  }

  // 🔄 Reasignación de seguridad (por si el socket perdió la sala)
  if (!socket.rooms.has(roomId)) {
    socket.join(roomId);
    console.log(`${colors.yellow}⚠️ Usuario ${userId} re-asignado a sala ${roomId} (recovery)${colors.reset}`);
  }

  const room = rooms.get(roomId);
  if (!room) {
    const msg = `❌ Sala no encontrada (${roomId})`;
    console.warn(`${colors.red}${msg}${colors.reset}`);
    return ack?.({ success: false, message: msg });
  }

  const current = pttState[roomId];
  const now = Date.now();

  // 🕐 Si el token está activo pero vencido, liberarlo automáticamente
  if (current && current.startedAt && now - current.startedAt > TOKEN_TIMEOUT_MS) {
    console.log(`${colors.yellow}⏳ Token expirado (${((now - current.startedAt) / 1000).toFixed(1)}s) — liberando automáticamente${colors.reset}`);
    clearTimeout(tokenTimers[roomId]);
    pttState[roomId] = null;
  }

  // 🔓 No hay hablante activo → conceder token
  if (!pttState[roomId] || !pttState[roomId].speakerId) {
    pttState[roomId] = { speakerId: userId, speakerName: username, startedAt: now };

    console.log(`${colors.green}🎙️ Token concedido a ${username} (${userId}) en sala ${roomId}${colors.reset}`);
    io.to(roomId).emit("token_granted", { roomId, userId, username });
    io.to(roomId).emit("current_speaker_update", userId);

    // ⏱️ Programar expiración automática
    clearTimeout(tokenTimers[roomId]);
    tokenTimers[roomId] = setTimeout(() => {
      const current = pttState[roomId];
      if (current && current.speakerId === userId) {
        console.log(`${colors.magenta}⏰ Token auto-liberado por timeout (${TOKEN_TIMEOUT_MS / 1000}s) — ${username}${colors.reset}`);
        pttState[roomId] = null;
        io.to(roomId).emit("token_released", { roomId, currentSpeaker: null });
        io.to(roomId).emit("current_speaker_update", null);
      }
    }, TOKEN_TIMEOUT_MS);

    // ✅ Enviar confirmación inmediata también por ACK
    return ack?.({
      success: true,
      roomId,
      userId,
      username,
      message: "Token concedido correctamente (ACK)",
    });
  }

  // 🚫 Ya hay alguien hablando
  const speaker = current?.speakerName || current?.speakerId;
  console.log(`${colors.yellow}🚫 Token denegado a ${username}, ya habla ${speaker}${colors.reset}`);

  socket.emit("token_denied", {
    roomId,
    currentSpeaker: current?.speakerId,
    speakerName: current?.speakerName,
  });

  return ack?.({
    success: false,
    roomId,
    currentSpeaker: current?.speakerId,
    message: `Ya está hablando ${speaker}`,
  });
});

// ============================================================
// 🔓 Liberación manual o automática del token
// ============================================================
socket.on("release_talk_token", (data = {}, ack) => {
  const { roomId, userId } = data;
  console.log(`${colors.cyan}📥 Evento → release_talk_token${colors.reset} desde socket ${socket.id}`, data);

  if (!roomId || !userId) {
    const msg = "⚠️ release_talk_token: datos inválidos";
    console.warn(`${colors.yellow}${msg}${colors.reset}`, data);
    return ack?.({ success: false, message: msg });
  }

  const state = pttState[roomId];
  if (!state || state.speakerId !== userId) {
    const msg = "⚠️ No posees el token o no hay hablante activo";
    console.warn(`${colors.yellow}${msg}${colors.reset}`);
    return ack?.({ success: false, message: msg });
  }

  // 🔓 Liberar token
  clearTimeout(tokenTimers[roomId]);
  pttState[roomId] = null;

  io.to(roomId).emit("token_released", { roomId, currentSpeaker: null });
  io.to(roomId).emit("current_speaker_update", null);

  console.log(`${colors.green}✅ Token liberado correctamente por ${userId} (${roomId})${colors.reset}`);
  console.log(`${colors.gray}📊 pttState actualizado:${colors.reset}`, JSON.stringify(pttState, null, 2));

  return ack?.({
    success: true,
    roomId,
    userId,
    message: "Token liberado correctamente (ACK)",
  });
});

// ============================================================
// 🔁 Mecanismo opcional de Keep-Alive PTT
// ============================================================
socket.on("ptt_keep_alive", (data = {}) => {
  const { roomId, userId } = data;
  const current = pttState[roomId];
  if (current && current.speakerId === userId) {
    current.startedAt = Date.now();
    clearTimeout(tokenTimers[roomId]);
    tokenTimers[roomId] = setTimeout(() => {
      if (pttState[roomId] && pttState[roomId].speakerId === userId) {
        console.log(`${colors.magenta}⏰ Token auto-liberado por inactividad — ${userId}${colors.reset}`);
        pttState[roomId] = null;
        io.to(roomId).emit("token_released", { roomId, currentSpeaker: null });
      }
    }, TOKEN_TIMEOUT_MS);
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
  // 🔄 (Opcional) Aviso de intento de reconexión del cliente
  // ============================================================
  socket.on("reconnect_attempt", () => {
    const userId = socketToUserMap.get(socket.id);
    const roomId = socketToRoomMap.get(socket.id);
    console.log(`${colors.yellow}♻️ reconnect_attempt: user=${userId} room=${roomId || "-"}${colors.reset}`);
    if (roomId) socket.emit("join_success", { room: roomId, roomId });
  });

  // ============================================================
  // 🔴 Desconexión (multi-socket segura)
  // ============================================================
  socket.on("disconnect", () => {
    const userId = socketToUserMap.get(socket.id);
    const roomId = socketToRoomMap.get(socket.id);

    if (roomId && rooms.has(roomId) && userId) {
      // ¿Queda otro socket del mismo user en la sala?
      const stillInRoom = Array.from(connectedUsers.get(userId)?.sockets || []).some(
        (sid) => sid !== socket.id && socketToRoomMap.get(sid) === roomId
      );
      if (!stillInRoom) {
        const r = rooms.get(roomId);
        r.users.delete(userId);

        // Si era el hablante PTT, liberar token
        if (pttState[roomId] && pttState[roomId].speakerId === userId) {
          pttState[roomId] = null;
          io.to(roomId).emit("token_released", { roomId, currentSpeaker: null });
          io.to(roomId).emit("current_speaker_update", null);
          console.log(`${colors.red}🎙️ Token liberado por desconexión de ${userId}${colors.reset}`);
        }

        io.to(roomId).emit("user-left-room", { roomId, userCount: r.users.size });
      }
    }

    if (userId) {
      const entry = connectedUsers.get(userId);
      if (entry) {
        entry.sockets.delete(socket.id);
        if (entry.sockets.size === 0) {
          connectedUsers.delete(userId);
          console.log(`${colors.red}🔴 Usuario ${userId} sin sesiones activas, eliminado.${colors.reset}`);
        } else {
          console.log(`${colors.yellow}⚪ Usuario ${userId} cerró una sesión (${entry.sockets.size} restantes).${colors.reset}`);
        }
      }
    }

    socketToRoomMap.delete(socket.id);
    socketToUserMap.delete(socket.id);

    io.emit(
      "connected_users",
      Array.from(connectedUsers.values()).map((u) => ({ ...u.userData, socketCount: u.sockets.size }))
    );
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
