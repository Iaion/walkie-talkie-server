// ============================================================
// 🌐 Servidor Node.js con Socket.IO, Firebase Firestore y Storage + PTT + WebRTC
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
// 📦 Estado en memoria
// ============================================================
const connectedUsers = new Map();
const socketToUserMap = new Map();
const socketToRoomMap = new Map();
const userToRoomMap = new Map();
const rooms = new Map();
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
  return Array.from(room.users)
    .map((userId) => {
      const entry = connectedUsers.get(userId);
      return entry ? { ...entry.userData, isOnline: true } : null;
    })
    .filter(Boolean);
}

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
// 🔊 FUNCIONALIDAD PTT (Push-To-Talk) con ACK, Keep-Alive, desconexión segura y reset global
// ============================================================

const TOKEN_TIMEOUT_MS = 10_000;
const tokenTimers = {};

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

   
  const username = user.username;
  const userId = user.id;
  // ✅ MUY IMPORTANTE: guardar en el propio socket
  socket.userId = userId;
  socket.username = user.username;

  socketToUserMap.set(socket.id, userId);

  const existing = connectedUsers.get(userId);
  if (existing) {
    existing.sockets.add(socket.id);
    existing.userData = { ...existing.userData, ...user, isOnline: true };
  } else {
    connectedUsers.set(userId, { userData: { ...user, isOnline: true }, sockets: new Set([socket.id]) });
  }

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
  // 🚪 Unión de salas (multi-room, sin expulsar la anterior)
// ============================================================
// 🚪 Unión de salas (multi-room, sin expulsar la anterior)
// ============================================================
socket.on("join_room", (data = {}, ack) => {
  console.log(`${colors.magenta}🚪 Evento → join_room:${colors.reset}`, data);

  const roomName = data.room || data.roomId || "salas";
  const { userId, username } = data;

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

  // ✅ Guardar userId y username en el socket (IMPORTANTE para WebRTC)
  socket.userId = userId;
  socket.username = username;

  // 🧭 Guardar la última sala unida del socket (para inferRoomIdFromSocket)
  socket.lastJoinedRoom = roomName;

  // Ya está este socket en la sala?
  const roomSet = io.sockets.adapter.rooms.get(roomName);
  if (roomSet && roomSet.has(socket.id)) {
    console.warn(
      `${colors.yellow}⚠️ ${username} ya está en ${roomName}, ignorando join duplicado.${colors.reset}`
    );
    return ack?.({ success: true, message: "Ya estás en esta sala" });
  }

  // ✅ Join SIN dejar otras salas
  socket.join(roomName);

  // Mantené tus estructuras auxiliares
  const userEntry = connectedUsers.get(userId);
  rooms.get(roomName).users.add(userId);
  socketToRoomMap.set(socket.id, roomName); // 🔥 trackear la sala actual del socket

  if (userEntry) {
    // opcional: trackear rooms por usuario
    userEntry.rooms = userEntry.rooms || new Set();
    userEntry.rooms.add(roomName);
  }

  // ============================================================
  // 📋 Enviar la lista actualizada de usuarios SOLO de esa sala
  // ============================================================
  const users = getRoomUsers(roomName);

  // Enviar la lista actualizada al socket que se unió
  socket.emit("connected_users", users); // 👈 llena el panel Handy correctamente

  // 🔄 Notificar a todos los usuarios en la sala
  io.to(roomName).emit("user-joined-room", {
    roomId: roomName,
    username,
    userCount: users.length,
  });

  console.log(
    `${colors.green}✅ ${username} se unió correctamente a ${roomName}${colors.reset}`
  );

  // ============================================================
  // 📤 Confirmación al cliente
  // ============================================================
  ack?.({
    success: true,
    room: roomName,
    roomId: roomName,
    message: `Te uniste a ${roomName}`,
    userCount: users.length,
  });

  // ============================================================
  // 🆕 (Opcional pero útil) — Empujar la lista completa a todos
  // ============================================================
  io.to(roomName).emit("connected_users", users);
});



  // ============================================================
  // 🚪 Salir de sala
  // ============================================================
 socket.on("leave_room", (data = {}, ack) => {
  const { roomId, userId, username } = data || {};
  const targetRoom = roomId; // ya viene de data; no usamos socketToRoomMap único

  if (!targetRoom || !rooms.has(targetRoom) || !userId) {
    const msg = "⚠️ leave_room: datos inválidos";
    ack?.({ success: false, message: msg });
    return;
  }

  socket.leave(targetRoom);

  // ¿Queda otro socket del mismo user en esa sala?
  const roomSet = io.sockets.adapter.rooms.get(targetRoom);
  const stillInRoom = roomSet
    ? Array.from(roomSet).some((sid) => {
        const s = io.sockets.sockets.get(sid);
        return s?.userId === userId && sid !== socket.id;
      })
    : false;

  if (!stillInRoom) {
    const r = rooms.get(targetRoom);
    r.users.delete(userId);

    if (pttState[targetRoom] && pttState[targetRoom].speakerId === userId) {
      pttState[targetRoom] = null;
      io.to(targetRoom).emit("token_released", { roomId: targetRoom, currentSpeaker: null });
      io.to(targetRoom).emit("current_speaker_update", null);
      console.log(`${colors.red}🎙️ Token liberado (leave_room) por ${userId}${colors.reset}`);
    }

    io.to(targetRoom).emit("user-left-room", { roomId: targetRoom, username, userCount: r.users.size });
  }

  socket.emit("left_room", { roomId: targetRoom });
  ack?.({ success: true, roomId: targetRoom });
  console.log(`${colors.gray}👋 ${username || userId} salió de ${targetRoom}${colors.reset}`);
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
// 🧭 Helper MEJORADO para detectar automáticamente la sala de un socket
// ============================================================
function inferRoomIdFromSocket(socket) {
  const joinedRooms = Array.from(socket.rooms || []).filter((r) => r !== socket.id);
  
  // 🆕 PRIORIDAD: handy > general > otras salas
  if (joinedRooms.includes("handy")) return "handy";
  if (joinedRooms.includes("general")) return "general";
  
  // 🆕 Buscar cualquier sala que no sea el lobby "salas"
  const nonLobbyRooms = joinedRooms.filter(room => room !== "salas");
  if (nonLobbyRooms.length > 0) return nonLobbyRooms[0];
  
  // 🆕 Último recurso: si solo está en "salas", usar general
  if (joinedRooms.includes("salas")) return "general";
  
  // Fallback absoluto
  return "general";
}


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
// 📋 Obtener lista de usuarios conectados en una sala
// ============================================================

socket.on("get_users", (data = {}, ack) => {
  let { roomId } = data || {};
  console.log(`${colors.red}🔍 DEBUG GET_USERS - DATOS RECIBIDOS:${colors.reset}`, JSON.stringify(data, null, 2));
  console.log(`${colors.cyan}📥 Evento → get_users:${colors.reset}`, data);

  // 🆕 DETECCIÓN INTELIGENTE: Si no hay roomId, buscar la sala MÁS PROBABLE
  if (!roomId) {
    // Prioridad: 1. handy, 2. general, 3. primera sala disponible
    const joinedRooms = Array.from(socket.rooms || []).filter((r) => r !== socket.id);
    
    if (joinedRooms.includes("handy")) {
      roomId = "handy";
    } else if (joinedRooms.includes("general")) {
      roomId = "general";
    } else if (joinedRooms.length > 0) {
      roomId = joinedRooms[0]; // Primera sala disponible
    } else {
      roomId = "general"; // Fallback seguro
    }
    
    console.log(`${colors.yellow}⚠️ get_users sin roomId, detectado automáticamente: '${roomId}'${colors.reset}`);
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
  const username = connectedUsers.get(socketToUserMap.get(socket.id))?.userData?.username || socket.id;

  console.log(`${colors.green}📤 Enviando ${users.length} usuarios para sala '${roomId}' a ${username}${colors.reset}`);

  // 🆕 ENVIAR SIEMPRE la lista, incluso si está vacía
  socket.emit("connected_users", users);

  // 🆕 ACK detallado para debugging
  ack?.({
    success: true,
    roomId: roomId,
    count: users.length,
    message: `Usuarios en ${roomId}: ${users.length}`,
    users: users.map(u => ({ id: u.id, username: u.username })) // 🆕 Solo datos básicos para debug
  });

  // 🆕 LOG detallado
  console.log(`${colors.blue}📋 Sala '${roomId}': ${users.length} usuarios${colors.reset}`);
  if (users.length > 0) {
    users.forEach(user => {
      console.log(`${colors.gray}   👤 ${user.username} (${user.id})${colors.reset}`);
    });
  } else {
    console.log(`${colors.gray}   💡 Sala vacía${colors.reset}`);
  }
});


// ============================================================
// 🛰️ WebRTC — Señalización dirigida (no broadcast)
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
  const candidateStr = candidate.candidate || candidate; // aceptar string u objeto
  // (Si querés filtrar, hacelo acá; si no, reenviá directo)
  const target = findSocketByUserId(to, roomId);
  if (!target) return console.warn(`⚠️ Destino ${to} no está en sala ${roomId}`);
  console.log(`📡 webrtc_ice_candidate ${from} → ${to} (${roomId})`);
  target.emit("webrtc_ice_candidate", { from, candidate: candidateStr, sdpMid, sdpMLineIndex });
});

// Helper: buscar la socket de un userId dentro de una sala
function findSocketByUserId(userId, roomId) {
  const room = io.sockets.adapter.rooms.get(roomId);
  if (!room) return null;
  for (const socketId of room) {
    const s = io.sockets.sockets.get(socketId);
    if (s?.userId === userId) return s;
  }
  return null;
}



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
  // 🔴 Desconexión unificada
  // ============================================================
  socket.on("disconnect", (reason) => {
    const userId = socketToUserMap.get(socket.id);
    const roomId = socketToRoomMap.get(socket.id);
    console.log(`${colors.red}🔌 Socket desconectado:${colors.reset} ${socket.id} (${reason})`);

    for (const [rid, state] of Object.entries(pttState)) {
      if (state && state.socketId === socket.id) {
        console.log(`${colors.yellow}🎙️ Liberando token de ${rid} por desconexión de ${state.speakerName}${colors.reset}`);
        clearTimeout(tokenTimers[rid]);
        delete pttState[rid];
        io.to(rid).emit("token_released", { roomId: rid, currentSpeaker: null });
        io.to(rid).emit("current_speaker_update", null);
      }
    }

    if (userId && roomId && rooms.has(roomId)) {
      const stillConnected = Array.from(connectedUsers.get(userId)?.sockets || []).some(
        (sid) => sid !== socket.id && socketToRoomMap.get(sid) === roomId
      );

      if (!stillConnected) {
        const room = rooms.get(roomId);
        room.users.delete(userId);
        io.to(roomId).emit("user-left-room", { roomId, userCount: room.users.size });
      }
    }

    if (userId) {
      const entry = connectedUsers.get(userId);
      if (entry) {
        entry.sockets.delete(socket.id);
        if (entry.sockets.size === 0) {
          connectedUsers.delete(userId);
          console.log(`${colors.red}🔴 Usuario ${userId} completamente desconectado.${colors.reset}`);
        }
      }
    }

    socketToRoomMap.delete(socket.id);
    socketToUserMap.delete(socket.id);

    io.emit(
      "connected_users",
      Array.from(connectedUsers.values()).map((u) => ({
        ...u.userData,
        socketCount: u.sockets.size,
      }))
    );
  });
});

// ============================================================
// 🚀 Iniciar servidor
// ============================================================
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`${colors.green}🚀 Servidor de chat+PTT+WebRTC corriendo en puerto ${PORT}${colors.reset}`);
  console.log(`${colors.cyan}🌐 http://localhost:${PORT}${colors.reset}`);
});