// ============================================================
// 🌐 Servidor Node.js con Socket.IO, Firebase Firestore y Storage
// 💬 Chat General + Sistema de Emergencia + Gestión de Vehículos
// ============================================================

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
// 🔧 CONFIGURACIÓN INICIAL
// ============================================================
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
  allowEIO3: true,
});

app.use(cors());
app.use(express.json({ limit: "25mb" }));

// ============================================================
// 🔥 CONFIGURACIÓN FIREBASE
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
  admin.firestore().settings({ ignoreUndefinedProperties: true });
  console.log(`${colors.green}✅ Firebase inicializado correctamente.${colors.reset}`);
} catch (err) {
  console.error(`${colors.red}❌ Error al inicializar Firebase:${colors.reset}`, err);
  process.exit(1);
}

const db = admin.firestore();
const bucket = admin.storage().bucket();
const messaging = admin.messaging();

// ============================================================
// 📦 COLECCIONES FIRESTORE
// ============================================================
const COLLECTIONS = {
  USERS: "users",
  MESSAGES: "messages",
  VEHICLES: "vehicles",
  EMERGENCIES: "emergencies"
};

// Firestore lock doc para controlar una emergencia a la vez
const LOCK_DOC = db.collection("LOCKS").doc("active_emergency");

// ============================================================
// 🗃️ ESTADO EN MEMORIA
// ============================================================
const state = {
  connectedUsers: new Map(),        // userId -> { userData, sockets }
  emergencyAlerts: new Map(),       // userId -> emergencyData
  emergencyHelpers: new Map(),      // emergencyUserId -> Set(helperUserIds)
  chatRooms: new Map(),             // roomId -> roomData
  emergencyUserRoom: new Map()      // userId -> emergencyRoomId
};

// ============================================================
// 🔒 FUNCIÓN PARA LIBERAR LOCK DE EMERGENCIA
// ============================================================
async function releaseEmergencyLock() {
  try {
    await LOCK_DOC.set({ active: false }, { merge: true });
    console.log(`${colors.green}✅ Lock liberado${colors.reset}`);
  } catch (e) {
    console.warn(`${colors.yellow}⚠️ No se pudo liberar lock:${colors.reset} ${e.message}`);
  }
}

// ============================================================
// 🧹 FUNCIÓN PARA LIMPIAR EMERGENCIA DE USUARIO DESCONECTADO (CORREGIDA)
// ============================================================
async function cleanupUserEmergency(userId, username, emergencyRoomId) {
  try {
    console.log(`${colors.red}🧹 LIMPIANDO EMERGENCIA DE USUARIO DESCONECTADO: ${username || userId}${colors.reset}`);
    
    // 🔍 1. VERIFICAR SI REALMENTE EXISTE UNA EMERGENCIA ACTIVA
    const hasActiveEmergency = state.emergencyAlerts.has(userId);
    const actualRoomId = state.emergencyUserRoom.get(userId) || emergencyRoomId;
    
    if (!hasActiveEmergency && !actualRoomId) {
      console.log(`${colors.yellow}⚠️ No hay emergencia activa para limpiar: ${userId}${colors.reset}`);
      return false;
    }
    
    // Usar el roomId correcto (el del estado interno tiene prioridad)
    const roomIdToClean = actualRoomId;
    
    // 2. LIMPIAR ESTADO INTERNO PRIMERO (IMPORTANTE: hacer esto primero)
    state.emergencyAlerts.delete(userId);
    state.emergencyHelpers.delete(userId);
    state.emergencyUserRoom.delete(userId);
    
    // 3. NOTIFICAR A TODOS ANTES DE LIMPIAR LA SALA
    io.emit("emergency_cancelled", { 
      userId, 
      username: username || 'Usuario desconocido',
      roomId: roomIdToClean,
      reason: "user_disconnected",
      timestamp: Date.now(),
      isActive: false
    });
    
    // 4. MANEJAR LA SALA DE EMERGENCIA SI EXISTE
    if (roomIdToClean) {
      console.log(`${colors.cyan}📝 Limpiando sala de emergencia: ${roomIdToClean}${colors.reset}`);
      
      // a) Notificar a todos en la sala
      io.to(roomIdToClean).emit("emergency_ended", {
        roomId: roomIdToClean,
        userId,
        username: username || 'Usuario',
        reason: "user_disconnected",
        message: `${username || 'El usuario'} se desconectó. Emergencia finalizada.`,
        timestamp: Date.now()
      });
      
      // b) Sacar a todos de la sala (incluyendo al socket.io)
      const socketsInRoom = io.sockets.adapter.rooms.get(roomIdToClean);
      if (socketsInRoom) {
        for (const socketId of socketsInRoom) {
          const socket = io.sockets.sockets.get(socketId);
          if (socket) {
            socket.leave(roomIdToClean);
            // Actualizar estado del socket
            if (socket.userId === userId) {
              socket.currentRoom = null;
            }
          }
        }
        
        // c) Eliminar la sala del adapter de Socket.io
        io.sockets.adapter.rooms.delete(roomIdToClean);
      }
      
      // d) Eliminar del estado de chatRooms si existe
      if (state.chatRooms.has(roomIdToClean)) {
        state.chatRooms.delete(roomIdToClean);
      }
      
      // e) Opcional: eliminar historial de chat
      try {
        await deleteEmergencyChatHistory(roomIdToClean);
        console.log(`${colors.green}🗑️ Historial de chat eliminado: ${roomIdToClean}${colors.reset}`);
      } catch (chatError) {
        console.warn(`${colors.yellow}⚠️ No se pudo eliminar historial de chat:${colors.reset}`, chatError.message);
      }
    }
    
    // 5. ACTUALIZAR FIRESTORE (2 documentos importantes)
    try {
      // a) Actualizar documento del USUARIO
      await db.collection(COLLECTIONS.USERS).doc(userId).update({
        hasActiveEmergency: false,
        emergencyRoomId: null,
        lastEmergencyEnded: Date.now(),
        isOnline: false, // Asegurar que esté offline
        lastSeen: Date.now()
      });
      
      // b) Actualizar o crear documento de EMERGENCIA
      const emergencyRef = db.collection(COLLECTIONS.EMERGENCIES).doc(userId);
      const emergencyDoc = await emergencyRef.get();
      
      if (emergencyDoc.exists) {
        await emergencyRef.update({
          status: "cancelled",
          endReason: "user_disconnected",
          endedAt: Date.now(),
          isActive: false,
          cleanedBySystem: true,
          cleanedAt: Date.now()
        });
      } else {
        // Crear registro si no existe (para tracking)
        await emergencyRef.set({
          userId,
          username: username || 'Desconocido',
          status: "cancelled",
          startReason: "unknown",
          endReason: "user_disconnected",
          startedAt: Date.now() - 60000, // Aprox 1 minuto atrás
          endedAt: Date.now(),
          isActive: false,
          roomId: roomIdToClean,
          cleanedBySystem: true,
          createdAt: Date.now()
        });
      }
      
      console.log(`${colors.green}✅ Firestore actualizado para usuario: ${userId}${colors.reset}`);
      
    } catch (firestoreError) {
      console.error(`${colors.red}❌ Error actualizando Firestore:${colors.reset}`, firestoreError.message);
      // No retornar false aquí, continuar con la limpieza
    }
    
    // 6. LIBERAR EL LOCK GLOBAL (si existe esa función)
    if (typeof releaseEmergencyLock === 'function') {
      try {
        await releaseEmergencyLock();
        console.log(`${colors.green}🔓 Lock de emergencia liberado${colors.reset}`);
      } catch (lockError) {
        console.warn(`${colors.yellow}⚠️ Error liberando lock:${colors.reset}`, lockError.message);
      }
    }
    
    // 7. NOTIFICAR CAMBIO DE ESTADO A TODOS LOS USUARIOS
    io.emit('user_status_changed', {
      userId,
      username: username || 'Usuario',
      isOnline: false,
      hasActiveEmergency: false,
      emergencyCleared: true,
      timestamp: Date.now()
    });
    
    // 8. ACTUALIZAR LISTA DE USUARIOS CONECTADOS
    const connectedUsersList = Array.from(state.connectedUsers.values()).map((u) => ({
      ...u.userData,
      socketCount: u.sockets.size,
    }));
    io.emit("connected_users", connectedUsersList);
    
    console.log(`${colors.green}✅ Emergencia COMPLETAMENTE limpiada para: ${username || userId}${colors.reset}`);
    
    return true;
    
  } catch (error) {
    console.error(`${colors.red}❌ ERROR CRÍTICO en cleanupUserEmergency:${colors.reset}`, error);
    
    // Intentar limpieza mínima en caso de error
    try {
      state.emergencyAlerts.delete(userId);
      state.emergencyHelpers.delete(userId);
      state.emergencyUserRoom.delete(userId);
    } catch (cleanupError) {
      console.error(`${colors.red}❌ Error incluso en limpieza mínima:${colors.reset}`, cleanupError);
    }
    
    return false;
  }
}

// ============================================================
// 🛠️ FUNCIONES UTILITARIAS
// ============================================================
const utils = {
  // Validación de URLs
  isHttpUrl: (str) => typeof str === "string" && /^https?:\/\//i.test(str),
  isDataUrl: (str) => typeof str === "string" && /^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(str),
  
  // Procesamiento de DataURL
  getMimeFromDataUrl: (dataUrl) => {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,/.exec(dataUrl || "");
    return match ? match[1] : "image/jpeg";
  },
  
  getBase64FromDataUrl: (dataUrl) => {
    const idx = (dataUrl || "").indexOf("base64,");
    return idx !== -1 ? dataUrl.substring(idx + 7) : null;
  },

  // Cálculo de distancias
  calculateDistance: (lat1, lon1, lat2, lon2) => {
    const R = 6371; // Radio de la Tierra en km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  },

  // Usuarios cercanos
  getNearbyUsers: (alertLat, alertLng, radiusKm = 50) => {
    const socketsWithin = [];
    
    console.log(`${colors.blue}📍 Buscando usuarios cercanos a:${colors.reset}`, { alertLat, alertLng, radiusKm });
    console.log(`${colors.blue}📊 Total de usuarios conectados:${colors.reset} ${state.connectedUsers.size}`);
    
    state.connectedUsers.forEach(({ userData, sockets }, userId) => {
      const loc = userData?.lastKnownLocation;
      console.log(`${colors.gray}👤 Usuario ${userId}:${colors.reset}`, {
        tieneUbicacion: !!loc,
        ubicacion: loc,
        sockets: Array.from(sockets || [])
      });
      
      if (loc && typeof loc.lat === "number" && typeof loc.lng === "number") {
        const d = utils.calculateDistance(alertLat, alertLng, loc.lat, loc.lng);
        console.log(`${colors.gray}   📏 Distancia: ${d.toFixed(2)}km${colors.reset}`);
        if (d <= radiusKm) {
          sockets.forEach((sid) => socketsWithin.push(sid));
          console.log(`${colors.green}   ✅ DENTRO del radio${colors.reset}`);
        } else {
          console.log(`${colors.yellow}   ❌ FUERA del radio${colors.reset}`);
        }
      } else {
        console.log(`${colors.yellow}   ⚠️ SIN ubicación válida${colors.reset}`);
      }
    });

    // Fallback: si no hay nadie con ubicación, notificar a todos
    if (socketsWithin.length === 0) {
      console.log(`${colors.yellow}⚠️ No hay usuarios con ubicación, notificando a TODOS${colors.reset}`);
      state.connectedUsers.forEach(({ sockets }) => {
        sockets.forEach((sid) => socketsWithin.push(sid));
      });
    }
    
    console.log(`${colors.blue}👥 Sockets a notificar:${colors.reset} ${socketsWithin.length}`);
    return socketsWithin;
  },

  // Verificar si usuario está presente en sala (CORREGIDO)
  isUserPresentInRoom: (userId, roomId) => {
    const entry = state.connectedUsers.get(userId);
    if (!entry) return false; // offline
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room) return false;
    for (const sid of entry.sockets) {
      if (room.has(sid)) return true;
    }
    return false;
  },

  // Emisión a usuarios
  emitToUser: (userId, event, payload) => {
    const entry = state.connectedUsers.get(userId);
    if (!entry) return 0;
    let count = 0;
    entry.sockets.forEach((sid) => {
      const s = io.sockets.sockets.get(sid);
      if (s) {
        s.emit(event, payload);
        count++;
      }
    });
    return count;
  },

  // Actualizar lista de usuarios en sala
  updateRoomUserList: (roomId) => {
    const room = state.chatRooms.get(roomId);
    if (!room) return;

    const usersInRoom = Array.from(room.users).map(userId => {
      const userInfo = state.connectedUsers.get(userId);
      return userInfo ? userInfo.userData : null;
    }).filter(Boolean);

    io.to(roomId).emit("room_users_updated", {
      roomId: roomId,
      users: usersInRoom,
      userCount: usersInRoom.length
    });
  }
};

// ============================================================
// 🚀 FUNCIÓN PARA ENVIAR NOTIFICACIONES PUSH (CORREGIDA)
// ============================================================
async function sendPushNotification(userId, title, body, data = {}) {
  try {
    const userDoc = await db.collection(COLLECTIONS.USERS).doc(userId).get();
    if (!userDoc.exists) {
      console.log(`${colors.yellow}⚠️ Usuario ${userId} no encontrado${colors.reset}`);
      return false;
    }

    const userData = userDoc.data();
    let token = null;
    
    // Intentar obtener token del array primero
    if (userData.fcmTokens && userData.fcmTokens.length > 0) {
      token = userData.fcmTokens[0]; // Tomar el más reciente
    } else if (userData.fcmToken) {
      token = userData.fcmToken; // Fallback al token único
    }
    
    if (!token) {
      console.log(`${colors.yellow}⚠️ Usuario ${userId} sin token FCM${colors.reset}`);
      return false;
    }

    const message = {
      token: token,
      notification: {
        title: title,
        body: body,
      },
      data: {
        ...data,
        type: data.type || 'chat',
        timestamp: Date.now().toString()
      },
      android: {
        priority: "high",
        notification: {
          sound: "default",
          channelId: "emergency_alerts"
        }
      },
      apns: {
        payload: {
          aps: {
            sound: "default",
            badge: 1
          }
        }
      }
    };

    const response = await messaging.send(message);
    console.log(`${colors.green}📱 Notificación enviada a ${userId}: ${response}${colors.reset}`);
    return true;
  } catch (error) {
    console.error(`${colors.red}❌ Error enviando notificación:${colors.reset}`, error);
    
    // Si el token es inválido, eliminarlo del array
    if (error.code === 'messaging/registration-token-not-registered') {
      try {
        await db.collection(COLLECTIONS.USERS).doc(userId).update({
          fcmTokens: admin.firestore.FieldValue.arrayRemove(token),
          fcmToken: admin.firestore.FieldValue.delete()
        });
        console.log(`${colors.yellow}🗑️ Token inválido eliminado de ${userId}${colors.reset}`);
      } catch (cleanupError) {
        console.error(`${colors.red}❌ Error limpiando token:${colors.reset}`, cleanupError);
      }
    }
    return false;
  }
}

// ============================================================
// 🗑️ FUNCIÓN PARA ELIMINAR HISTORIAL DE CHAT
// ============================================================
const deleteEmergencyChatHistory = async (emergencyRoomId) => {
  try {
    console.log(`${colors.blue}🗑️ Eliminando historial de chat para sala: ${emergencyRoomId}${colors.reset}`);
    
    const messagesSnapshot = await db.collection(COLLECTIONS.MESSAGES)
      .where("roomId", "==", emergencyRoomId)
      .get();
    
    const batch = db.batch();
    let deletedCount = 0;
    
    messagesSnapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
      deletedCount++;
    });
    
    if (deletedCount > 0) {
      await batch.commit();
      console.log(`${colors.green}✅ Eliminados ${deletedCount} mensajes de la sala ${emergencyRoomId}${colors.reset}`);
    } else {
      console.log(`${colors.gray}📭 No se encontraron mensajes para eliminar en ${emergencyRoomId}${colors.reset}`);
    }
    
    return deletedCount;
  } catch (error) {
    console.error(`${colors.red}❌ Error eliminando historial de chat:${colors.reset}`, error);
    throw error;
  }
};

// ============================================================
// 🗄️ MANEJO DE ARCHIVOS - STORAGE
// ============================================================
const storageService = {
  uploadAvatarFromDataUrl: async (userId, dataUrl) => {
    try {
      if (!utils.isDataUrl(dataUrl)) {
        throw new Error("Formato de imagen inválido (no es DataURL)");
      }

      const mime = utils.getMimeFromDataUrl(dataUrl);
      const ext = mime.split("/")[1] || "jpg";
      const base64 = utils.getBase64FromDataUrl(dataUrl);

      if (!base64) throw new Error("Data URL inválida (sin base64)");

      const buffer = Buffer.from(base64, "base64");
      const filePath = `avatars/${userId}/${Date.now()}_${uuidv4()}.${ext}`;
      const file = bucket.file(filePath);

      console.log(`${colors.yellow}⬆️ Subiendo avatar → ${filePath} (${mime})${colors.reset}`);

      await file.save(buffer, {
        contentType: mime,
        resumable: false,
        gzip: true,
        metadata: {
          cacheControl: "public, max-age=31536000",
          metadata: { userId },
        },
      });

      await file.makePublic();
      const publicUrl = file.publicUrl();

      console.log(`${colors.green}✅ Avatar subido:${colors.reset} ${publicUrl}`);

      try {
        const [files] = await bucket.getFiles({ prefix: `avatars/${userId}/` });
        const sorted = files.sort(
          (a, b) => b.metadata.timeCreated.localeCompare(a.metadata.timeCreated)
        );
        const oldFiles = sorted.slice(1);
        if (oldFiles.length > 0) {
          await Promise.allSettled(oldFiles.map((f) => f.delete()));
          console.log(`${colors.gray}🧹 ${oldFiles.length} avatares antiguos eliminados${colors.reset}`);
        }
      } catch (cleanupErr) {
        console.warn(`${colors.yellow}⚠️ No se pudieron limpiar avatares antiguos:${colors.reset} ${cleanupErr.message}`);
      }

      return publicUrl;
    } catch (error) {
      console.error(`${colors.red}❌ Error subiendo avatar:${colors.reset}`, error);
      throw error;
    }
  },

  uploadVehiclePhoto: async (userId, vehicleId, imageData) => {
    try {
      if (!utils.isDataUrl(imageData)) {
        throw new Error("Formato de imagen inválido");
      }

      const mime = utils.getMimeFromDataUrl(imageData);
      const ext = mime.split("/")[1] || "jpg";
      const base64 = utils.getBase64FromDataUrl(imageData);

      if (!base64) throw new Error("Data URL inválida");

      const buffer = Buffer.from(base64, "base64");
      const filePath = `vehicles/${userId}/${vehicleId}_${Date.now()}_${uuidv4()}.${ext}`;
      const file = bucket.file(filePath);

      console.log(`${colors.yellow}⬆️ Subiendo foto de vehículo → ${filePath}${colors.reset}`);

      await file.save(buffer, {
        contentType: mime,
        resumable: false,
        metadata: {
          cacheControl: 'public, max-age=31536000',
        }
      });

      await file.makePublic();
      const url = file.publicUrl();

      console.log(`${colors.green}✅ Foto de vehículo subida:${colors.reset} ${url}`);
      return url;
    } catch (error) {
      console.error(`${colors.red}❌ Error subiendo foto de vehículo:${colors.reset}`, error);
      throw error;
    }
  },

  saveBase64AudioToFirebase: async ({ base64, mime = "audio/mpeg", userId, roomId, ext }) => {
    try {
      const buffer = Buffer.from(base64, "base64");
      
      if (buffer.length > 20 * 1024 * 1024) {
        throw new Error("Archivo de audio demasiado grande (>20MB)");
      }

      let extension = ext;
      if (!extension) {
        if (mime.includes("mpeg") || mime.includes("mp3")) extension = "mp3";
        else if (mime.includes("mp4") || mime.includes("aac") || mime.includes("m4a")) extension = "m4a";
        else if (mime.includes("webm")) extension = "webm";
        else if (mime.includes("ogg") || mime.includes("opus")) extension = "ogg";
        else extension = "mp3";
      }

      const objectPath = `audios/${roomId}/${userId}/${Date.now()}_${uuidv4()}.${extension}`;
      const file = bucket.file(objectPath);

      await file.save(buffer, {
        contentType: mime,
        resumable: false,
        gzip: false,
        metadata: {
          cacheControl: "public, max-age=31536000",
          metadata: { userId, roomId },
        },
      });

      await file.makePublic();
      const url = file.publicUrl();
      
      console.log(`${colors.green}✅ Audio subido a Storage:${colors.reset} ${url}`);
      return url;
    } catch (error) {
      console.error(`${colors.red}❌ Error guardando audio:${colors.reset}`, error);
      throw error;
    }
  }
};

// ============================================================
// 🏗️ INICIALIZACIÓN DE SALAS
// ============================================================
function initializeDefaultRooms() {
  const defaultRooms = [
    { 
      id: "general", 
      name: "Chat General", 
      type: "public", 
      description: "Sala principal para conversaciones generales" 
    },
    { 
      id: "ayuda", 
      name: "Sala de Ayuda", 
      type: "public", 
      description: "Sala para pedir y ofrecer ayuda" 
    },
    { 
      id: "handy", 
      name: "Modo Handy", 
      type: "ptt", 
      description: "Sala para comunicación push-to-talk" 
    }
  ];

  defaultRooms.forEach(room => {
    state.chatRooms.set(room.id, {
      ...room,
      users: new Set(),
      createdAt: Date.now(),
      messageCount: 0
    });
  });

  console.log(`${colors.green}✅ Salas por defecto inicializadas:${colors.reset}`);
  defaultRooms.forEach(room => {
    console.log(`${colors.blue}   - ${room.name} (${room.id})${colors.reset}`);
  });
}

// ============================================================
// 🌐 ENDPOINTS REST - SALAS DE CHAT
// ============================================================
app.get("/health", (_, res) => res.status(200).send("Servidor operativo 🚀"));

app.get("/users", (_, res) =>
  res.json(
    Array.from(state.connectedUsers.values()).map((u) => ({
      ...u.userData,
      socketCount: u.sockets.size,
    }))
  )
);

app.get("/rooms", (req, res) => {
  try {
    const roomsArray = Array.from(state.chatRooms.values()).map(room => ({
      id: room.id,
      name: room.name,
      type: room.type,
      description: room.description,
      userCount: room.users.size,
      messageCount: room.messageCount,
      createdAt: room.createdAt
    }));

    res.json({
      success: true,
      rooms: roomsArray,
      total: roomsArray.length
    });
  } catch (error) {
    console.error(`${colors.red}❌ Error obteniendo salas:${colors.reset}`, error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/rooms/:roomId", (req, res) => {
  try {
    const { roomId } = req.params;
    const room = state.chatRooms.get(roomId);

    if (!room) {
      return res.status(404).json({ success: false, message: "Sala no encontrada" });
    }

    const roomInfo = {
      ...room,
      userCount: room.users.size,
      users: Array.from(room.users).map(userId => {
        const user = state.connectedUsers.get(userId);
        return user ? { 
          id: user.userData.id, 
          username: user.userData.username,
          avatarUri: user.userData.avatarUri 
        } : null;
      }).filter(Boolean)
    };

    res.json({ success: true, room: roomInfo });
  } catch (error) {
    console.error(`${colors.red}❌ Error obteniendo sala:${colors.reset}`, error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 🚨 ENDPOINTS PARA EMERGENCIAS
// ============================================================
app.get("/emergencies/active", async (req, res) => {
  try {
    console.log(`${colors.cyan}🚨 GET /emergencies/active${colors.reset}`);
    
    const emergenciesArray = Array.from(state.emergencyAlerts.entries()).map(([userId, alert]) => ({
      ...alert,
      helpersCount: state.emergencyHelpers.get(userId)?.size || 0
    }));
    
    res.json({ 
      success: true, 
      emergencies: emergenciesArray,
      total: emergenciesArray.length 
    });
  } catch (error) {
    console.error(`${colors.red}❌ Error obteniendo emergencias activas:${colors.reset}`, error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/emergencies/:userId/helpers", async (req, res) => {
  try {
    const { userId } = req.params;
    console.log(`${colors.cyan}👥 GET /emergencies/${userId}/helpers${colors.reset}`);

    const helpersSet = state.emergencyHelpers.get(userId) || new Set();
    const helpers = Array.from(helpersSet);
    
    res.json({ 
      success: true, 
      helpers,
      count: helpers.length 
    });
  } catch (error) {
    console.error(`${colors.red}❌ Error obteniendo ayudantes:${colors.reset}`, error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 🚗 ENDPOINTS PARA VEHÍCULOS
// ============================================================
app.get("/vehicles/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    console.log(`${colors.cyan}🚗 GET /vehicles/${userId}${colors.reset}`);

    const snapshot = await db.collection(COLLECTIONS.VEHICLES)
      .where("userId", "==", userId)
      .where("isActive", "==", true)
      .get();

    const vehicles = snapshot.empty ? [] : snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        type: data.type || data.tipo,
        name: data.name || data.nombre,
        brand: data.brand || data.marca,
        model: data.model || data.modelo,
        year: data.year,
        color: data.color,
        licensePlate: data.licensePlate || data.patente,
        photoUri: data.photoUri || data.fotoVehiculoUri,
        isPrimary: data.isPrimary,
        isActive: data.isActive,
        userId: data.userId,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        ...(data.type === 'CAR' && { doors: data.doors }),
        ...(data.type === 'MOTORCYCLE' && {
          cylinderCapacity: data.cylinderCapacity,
          mileage: data.mileage
        }),
        ...(data.type === 'BICYCLE' && {
          frameSerialNumber: data.frameSerialNumber,
          hasElectricMotor: data.hasElectricMotor,
          frameSize: data.frameSize
        })
      };
    });
    
    console.log(`${colors.green}✅ ${vehicles.length} vehículos encontrados para usuario ${userId}${colors.reset}`);
    res.json({ 
      success: true, 
      vehicles: vehicles,
      count: vehicles.length
    });
  } catch (error) {
    console.error(`${colors.red}❌ Error obteniendo vehículos:${colors.reset}`, error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/vehicles/:userId/:vehicleId", async (req, res) => {
  try {
    const { userId, vehicleId } = req.params;
    console.log(`${colors.cyan}🚗 GET /vehicles/${userId}/${vehicleId}${colors.reset}`);

    const doc = await db.collection(COLLECTIONS.VEHICLES).doc(vehicleId).get();

    if (!doc.exists) {
      return res.status(404).json({ 
        success: false, 
        message: "Vehículo no encontrado" 
      });
    }

    const data = doc.data();
    const vehicle = { 
      id: doc.id,
      type: data.type || data.tipo,
      name: data.name || data.nombre,
      brand: data.brand || data.marca,
      model: data.model || data.modelo,
      year: data.year,
      color: data.color,
      licensePlate: data.licensePlate || data.patente,
      photoUri: data.photoUri || data.fotoVehiculoUri,
      isPrimary: data.isPrimary,
      isActive: data.isActive,
      userId: data.userId,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      ...(data.type === 'CAR' && { doors: data.doors }),
      ...(data.type === 'MOTORCYCLE' && {
        cylinderCapacity: data.cylinderCapacity,
        mileage: data.mileage
      }),
      ...(data.type === 'BICYCLE' && {
        frameSerialNumber: data.frameSerialNumber,
        hasElectricMotor: data.hasElectricMotor,
        frameSize: data.frameSize
      })
    };
    
    if (vehicle.userId !== userId) {
      return res.status(403).json({ 
        success: false, 
        message: "No tienes permisos para acceder a este vehículo" 
      });
    }
    
    console.log(`${colors.green}✅ Vehículo encontrado: ${vehicle.name || vehicle.brand}${colors.reset}`);
    res.json({ success: true, vehicle });
  } catch (error) {
    console.error(`${colors.red}❌ Error obteniendo vehículo:${colors.reset}`, error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/vehicles", async (req, res) => {
  try {
    const vehicleData = req.body;
    console.log(`${colors.cyan}🚗 POST /vehicles${colors.reset}`, {
      userId: vehicleData.userId,
      type: vehicleData.type,
      name: vehicleData.name,
      brand: vehicleData.brand,
      model: vehicleData.model
    });

    if (!vehicleData.userId) {
      return res.status(400).json({ 
        success: false, 
        message: "userId es requerido" 
      });
    }

    if (!vehicleData.type || !['CAR', 'MOTORCYCLE', 'BICYCLE'].includes(vehicleData.type)) {
      return res.status(400).json({ 
        success: false, 
        message: "Tipo de vehículo inválido" 
      });
    }

    let result;
    const now = Date.now();

    if (vehicleData.id) {
      const existingDoc = await db.collection(COLLECTIONS.VEHICLES).doc(vehicleData.id).get();
      
      if (!existingDoc.exists) {
        return res.status(404).json({ 
          success: false, 
          message: "Vehículo no encontrado" 
        });
      }

      const existingData = existingDoc.data();
      
      if (existingData.userId !== vehicleData.userId) {
        return res.status(403).json({ 
          success: false, 
          message: "No tienes permisos para editar este vehículo" 
        });
      }

      const updateData = {
        ...vehicleData,
        updatedAt: now,
        createdAt: existingData.createdAt,
        isActive: vehicleData.isActive !== undefined ? vehicleData.isActive : existingData.isActive,
        isPrimary: vehicleData.isPrimary !== undefined ? vehicleData.isPrimary : existingData.isPrimary
      };

      await db.collection(COLLECTIONS.VEHICLES).doc(vehicleData.id).update(updateData);
      result = { id: vehicleData.id, ...updateData };
      
      console.log(`${colors.green}✅ Vehículo actualizado: ${vehicleData.name || vehicleData.brand}${colors.reset}`);

    } else {
      const userVehicles = await db.collection(COLLECTIONS.VEHICLES)
        .where("userId", "==", vehicleData.userId)
        .where("isActive", "==", true)
        .get();

      const newVehicle = {
        ...vehicleData,
        createdAt: now,
        updatedAt: now,
        isActive: true,
        isPrimary: userVehicles.empty
      };

      const docRef = await db.collection(COLLECTIONS.VEHICLES).add(newVehicle);
      result = { id: docRef.id, ...newVehicle };
      
      console.log(`${colors.green}✅ Nuevo vehículo creado: ${vehicleData.name || vehicleData.brand}${colors.reset}`);
    }

    res.json({ 
      success: true, 
      message: vehicleData.id ? "Vehículo actualizado" : "Vehículo creado",
      vehicle: result
    });
  } catch (error) {
    console.error(`${colors.red}❌ Error guardando vehículo:${colors.reset}`, error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete("/vehicles/:userId/:vehicleId", async (req, res) => {
  try {
    const { userId, vehicleId } = req.params;
    console.log(`${colors.cyan}🗑️ DELETE /vehicles/${userId}/${vehicleId}${colors.reset}`);

    const doc = await db.collection(COLLECTIONS.VEHICLES).doc(vehicleId).get();

    if (!doc.exists) {
      return res.status(404).json({ 
        success: false, 
        message: "Vehículo no encontrado" 
      });
    }

    const vehicle = doc.data();
    
    if (vehicle.userId !== userId) {
      return res.status(403).json({ 
        success: false, 
        message: "No tienes permisos para eliminar este vehículo" 
      });
    }

    await db.collection(COLLECTIONS.VEHICLES).doc(vehicleId).update({
      isActive: false,
      updatedAt: Date.now()
    });

    console.log(`${colors.green}✅ Vehículo eliminado: ${vehicle.name || vehicle.brand}${colors.reset}`);
    res.json({ 
      success: true, 
      message: "Vehículo eliminado correctamente" 
    });
  } catch (error) {
    console.error(`${colors.red}❌ Error eliminando vehículo:${colors.reset}`, error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/vehicles/:userId/primary", async (req, res) => {
  try {
    const { userId } = req.params;
    const { vehicleId } = req.body;
    
    console.log(`${colors.cyan}🎯 POST /vehicles/${userId}/primary${colors.reset}`, { vehicleId });

    if (!vehicleId) {
      return res.status(400).json({ 
        success: false, 
        message: "vehicleId es requerido" 
      });
    }

    const vehicleDoc = await db.collection(COLLECTIONS.VEHICLES).doc(vehicleId).get();
    
    if (!vehicleDoc.exists) {
      return res.status(404).json({ 
        success: false, 
        message: "Vehículo no encontrado" 
      });
    }

    const vehicle = vehicleDoc.data();
    if (vehicle.userId !== userId) {
      return res.status(403).json({ 
        success: false, 
        message: "No tienes permisos para este vehículo" 
      });
    }

    const batch = db.batch();

    const userVehicles = await db.collection(COLLECTIONS.VEHICLES)
      .where("userId", "==", userId)
      .where("isPrimary", "==", true)
      .where("isActive", "==", true)
      .get();

    userVehicles.docs.forEach(doc => {
      batch.update(doc.ref, { 
        isPrimary: false,
        updatedAt: Date.now()
      });
    });

    const newPrimaryRef = db.collection(COLLECTIONS.VEHICLES).doc(vehicleId);
    batch.update(newPrimaryRef, { 
      isPrimary: true,
      updatedAt: Date.now()
    });

    await batch.commit();

    console.log(`${colors.green}✅ Vehículo ${vehicleId} establecido como primario${colors.reset}`);
    res.json({ 
      success: true, 
      message: "Vehículo primario actualizado" 
    });
  } catch (error) {
    console.error(`${colors.red}❌ Error estableciendo vehículo primario:${colors.reset}`, error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/vehicles/photo", async (req, res) => {
  try {
    const { userId, vehicleId, imageData } = req.body;

    if (!userId || !vehicleId || !imageData || !utils.isDataUrl(imageData)) {
      return res.status(400).json({ 
        success: false, 
        message: "Datos inválidos: userId, vehicleId e imageData son requeridos" 
      });
    }

    console.log(`${colors.yellow}⬆️ Subiendo foto para vehículo ${vehicleId} de usuario ${userId}${colors.reset}`);

    const vehicleDoc = await db.collection(COLLECTIONS.VEHICLES).doc(vehicleId).get();
    
    if (!vehicleDoc.exists) {
      return res.status(404).json({ 
        success: false, 
        message: "Vehículo no encontrado" 
      });
    }

    const vehicle = vehicleDoc.data();
    if (vehicle.userId !== userId) {
      return res.status(403).json({ 
        success: false, 
        message: "No tienes permisos para este vehículo" 
      });
    }

    const url = await storageService.uploadVehiclePhoto(userId, vehicleId, imageData);

    await db.collection(COLLECTIONS.VEHICLES).doc(vehicleId).update({
      photoUri: url,
      updatedAt: Date.now()
    });

    console.log(`${colors.green}☁️ Vehículo actualizado con nueva foto${colors.reset}`);

    res.json({
      success: true,
      message: "Foto de vehículo subida correctamente",
      url: url
    });

  } catch (error) {
    console.error(`${colors.red}❌ Error subiendo foto de vehículo:${colors.reset}`, error);
    res.status(500).json({ 
      success: false, 
      message: `Error subiendo foto: ${error.message}` 
    });
  }
});

// ============================================================
// 🔌 SOCKET.IO - MANEJO DE CONEXIONES (CORREGIDO)
// ============================================================
io.on("connection", (socket) => {
  console.log(`${colors.cyan}🔗 NUEVA CONEXIÓN SOCKET:${colors.reset} ${socket.id}`);

  // ============================================================
  // 🔑 EVENTO: REGISTRAR TOKEN FCM (CORREGIDO)
  // ============================================================
  socket.on('register_fcm_token', async (data = {}, callback) => {
    try {
      const { userId, fcmToken } = data;
      
      if (!userId || !fcmToken) {
        return callback?.({ success: false, message: "userId y fcmToken requeridos" });
      }

      // Usar array de tokens (multi-dispositivo) en una sola operación
      await db.collection(COLLECTIONS.USERS).doc(userId).set({
        fcmTokens: admin.firestore.FieldValue.arrayUnion(fcmToken),
        fcmTokensUpdatedAt: Date.now(),
        devices: {
          [socket.id]: {
            token: fcmToken,
            platform: data.platform || 'android',
            lastActive: Date.now()
          }
        }
      }, { merge: true });

      console.log(`${colors.green}✅ Token FCM registrado para ${userId}${colors.reset}`);
      callback?.({ success: true, message: "Token registrado" });
      
    } catch (error) {
      console.error(`${colors.red}❌ Error registrando token:${colors.reset}`, error);
      callback?.({ success: false, message: error.message });
    }
  });

  // ============================================================
  // 👤 USUARIO CONECTADO AL CHAT
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
    const username = user.username;

    // Guardar en el socket
    socket.userId = userId;
    socket.username = username;

    // Unir automáticamente al chat general
    const defaultRoom = "general";
    socket.join(defaultRoom);
    socket.currentRoom = defaultRoom;

    // Agregar usuario a la sala en memoria
    const generalRoom = state.chatRooms.get(defaultRoom);
    if (generalRoom) {
      generalRoom.users.add(userId);
    }

    // Actualizar estado de usuarios conectados
    const now = Date.now();
    const incomingLoc = (typeof user.lat === "number" && typeof user.lng === "number")
      ? { lat: user.lat, lng: user.lng, ts: now }
      : undefined;

    const existing = state.connectedUsers.get(userId);
    if (existing) {
      existing.sockets.add(socket.id);
      existing.userData = {
        ...existing.userData,
        ...user,
        isOnline: true,
        currentRoom: defaultRoom,
        lastKnownLocation: incomingLoc || existing.userData.lastKnownLocation
      };
    } else {
      state.connectedUsers.set(userId, {
        userData: {
          ...user,
          isOnline: true,
          currentRoom: defaultRoom,
          lastKnownLocation: incomingLoc
        },
        sockets: new Set([socket.id])
      });
    }

    try {
      // Sincronizar con Firebase
      await db.collection(COLLECTIONS.USERS).doc(userId).set({
        ...user,
        isOnline: true,
        lastLogin: Date.now(),
        currentRoom: defaultRoom,
        socketIds: admin.firestore.FieldValue.arrayUnion(socket.id)
      }, { merge: true });
      console.log(`${colors.green}🔑 Usuario sincronizado con Firebase: ${username}${colors.reset}`);
    } catch (error) {
      console.error(`${colors.red}❌ Error al registrar usuario:${colors.reset}`, error);
    }

    // Notificar a todos los usuarios conectados
    io.emit(
      "connected_users",
      Array.from(state.connectedUsers.values()).map((u) => ({ 
        ...u.userData, 
        socketCount: u.sockets.size 
      }))
    );

    // Enviar información de salas disponibles
    socket.emit("available_rooms", 
      Array.from(state.chatRooms.values()).map(room => ({
        id: room.id,
        name: room.name,
        type: room.type,
        description: room.description,
        userCount: room.users.size,
        messageCount: room.messageCount
      }))
    );

    // Enviar mensaje de bienvenida
    socket.emit("join_success", { 
      room: "general", 
      message: `Bienvenido al chat general, ${username}!` 
    });

    // Notificar a la sala general
    socket.to(defaultRoom).emit("user_joined_room", {
      userId: userId,
      username: username,
      roomId: defaultRoom,
      message: `${username} se unió a la sala`,
      timestamp: Date.now()
    });

    // Actualizar lista de usuarios en la sala
    utils.updateRoomUserList(defaultRoom);

    ack?.({ success: true });
    console.log(`${colors.green}✅ ${username} conectado al chat general${colors.reset}`);
  });

  // ============================================================
  // 📍 ACTUALIZAR UBICACIÓN
  // ============================================================
  socket.on("update_location", (data = {}, ack) => {
    try {
      const { userId, lat, lng, timestamp } = data;
      if (!userId || typeof lat !== "number" || typeof lng !== "number") {
        return ack?.({ success: false, message: "Datos inválidos" });
      }
      const entry = state.connectedUsers.get(userId);
      if (entry) {
        entry.userData.lastKnownLocation = {
          lat,
          lng,
          ts: typeof timestamp === "number" ? timestamp : Date.now()
        };
        ack?.({ success: true });
      } else {
        ack?.({ success: false, message: "Usuario no conectado" });
      }
    } catch (e) {
      console.error("❌ update_location error:", e);
      ack?.({ success: false, message: e.message });
    }
  });

  // ============================================================
  // 🚪 MANEJO DE SALAS (CORREGIDO)
  // ============================================================
  socket.on("join_room", async (data = {}, ack) => {
    try {
      const { roomId, userId } = data;
      
      console.log(`${colors.blue}🚪 Evento → join_room:${colors.reset}`, {
        roomId,
        userId,
        socketId: socket.id,
      });

      if (!roomId || !userId) {
        ack?.({ success: false, message: "roomId y userId son requeridos" });
        return;
      }

      const targetRoom = state.chatRooms.get(roomId);
      if (!targetRoom) {
        ack?.({ success: false, message: `Sala ${roomId} no encontrada` });
        return;
      }

      // 1. Salir de sala anterior si existe
      if (socket.currentRoom && socket.currentRoom !== roomId) {
        const previousRoom = state.chatRooms.get(socket.currentRoom);
        if (previousRoom) {
          previousRoom.users.delete(userId);
        }

        socket.leave(socket.currentRoom);

        socket.to(socket.currentRoom).emit("user_left_room", {
          userId,
          username: socket.username,
          roomId: socket.currentRoom,
          message: `${socket.username} salió de la sala`,
          timestamp: Date.now()
        });

        utils.updateRoomUserList(socket.currentRoom);
      }

      // 2. Unirse a nueva sala
      socket.join(roomId);
      socket.currentRoom = roomId;
      targetRoom.users.add(userId);

      // 3. Actualizar en Firestore (OPCIONAL, para debug)
      await db.collection(COLLECTIONS.USERS).doc(userId).set({
        currentRoom: roomId,
        lastActive: Date.now()
      }, { merge: true });

      // 4. Enviar historial de mensajes
      try {
        const messagesSnapshot = await db.collection(COLLECTIONS.MESSAGES)
          .where("roomId", "==", roomId)
          .orderBy("timestamp", "desc")
          .limit(50)
          .get();

        const messages = messagesSnapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data(),
        })).reverse();

        socket.emit("room_messages", {
          roomId,
          messages,
        });
      } catch (dbError) {
        console.warn(`${colors.yellow}⚠️ No se pudo cargar historial de mensajes:${colors.reset}`, dbError.message);
      }

      // 5. Notificar a otros en la sala
      socket.to(roomId).emit("user_joined_room", {
        userId,
        username: socket.username,
        roomId,
        message: `${socket.username} se unió a la sala`,
        timestamp: Date.now(),
      });

      // 6. Actualizar lista de usuarios
      utils.updateRoomUserList(roomId);

      ack?.({
        success: true,
        roomId,
        message: `Unido a sala ${roomId}`,
      });

      console.log(`${colors.green}✅ ${socket.username} se unió a ${roomId}${colors.reset}`);

    } catch (err) {
      console.error("❌ Error en join_room:", err);
      ack?.({ success: false, message: "Error interno en join_room" });
    }
  });

  socket.on("leave_room", async (data = {}, ack) => {
    try {
      const { roomId, userId } = data;
      
      if (!roomId) {
        return ack?.({ success: false, message: "❌ Sala no especificada" });
      }

      console.log(`${colors.blue}🚪 Evento → leave_room:${colors.reset} ${socket.username} → ${roomId}`);

      const room = state.chatRooms.get(roomId);
      if (!room) {
        return ack?.({ success: false, message: "Sala no encontrada" });
      }

      socket.leave(roomId);
      room.users.delete(userId || socket.userId);
      
      if (socket.currentRoom === roomId) {
        socket.currentRoom = null;
      }

      const userInfo = state.connectedUsers.get(userId || socket.userId);
      if (userInfo && userInfo.userData.currentRoom === roomId) {
        userInfo.userData.currentRoom = null;
      }

      // Actualizar en Firestore (OPCIONAL)
      await db.collection(COLLECTIONS.USERS).doc(userId || socket.userId).set({
        currentRoom: null,
        lastActive: Date.now()
      }, { merge: true });

      socket.to(roomId).emit("user_left_room", {
        userId: userId || socket.userId,
        username: socket.username,
        roomId: roomId,
        message: `${socket.username} salió de la sala`,
        timestamp: Date.now()
      });

      utils.updateRoomUserList(roomId);

      ack?.({ success: true, message: `Salido de ${roomId}` });
      console.log(`${colors.yellow}↩️ ${socket.username} salió de: ${roomId}${colors.reset}`);

    } catch (error) {
      console.error(`${colors.red}❌ Error saliendo de sala:${colors.reset}`, error);
      ack?.({ success: false, message: "Error al salir de la sala" });
    }
  });

  // ============================================================
  // 💬 MENSAJES DE TEXTO (CORREGIDO - SIN NOTIFICACIONES FANTASMA)
  // ============================================================
  socket.on("send_message", async (data = {}, ack) => {
    const { userId, username, text, roomId = socket.currentRoom || "general" } = data;
    
    if (!userId || !username || !text) {
      return ack?.({ success: false, message: "❌ Datos de mensaje inválidos" });
    }

    if (!socket.currentRoom || !state.chatRooms.has(roomId)) {
      return ack?.({ success: false, message: "❌ No estás en una sala válida" });
    }

    const message = { 
      id: uuidv4(), 
      userId, 
      username, 
      roomId: roomId, 
      text, 
      type: "text",
      timestamp: Date.now() 
    };

    try {
      // 1. Guardar en Firestore
      await db.collection(COLLECTIONS.MESSAGES).add(message);
      
      const room = state.chatRooms.get(roomId);
      if (room) {
        room.messageCount++;
      }
      
      // 2. Enviar por socket a TODOS en la sala
      io.to(roomId).emit("new_message", message);
      socket.emit("message_sent", message);
      
      // 3. ENVIAR NOTIFICACIONES PUSH SOLO A USUARIOS NO PRESENTES
      // Obtener miembros de la sala (si es privada) o usuarios generales
      const roomUsers = room ? Array.from(room.users) : [];
      
      // Para sala general, enviar a todos los usuarios registrados
      // Para salas privadas, enviar solo a miembros de esa sala
      let usersToNotify = [];
      
      if (roomId === "general") {
        // Obtener todos los usuarios registrados
        const allUsersSnapshot = await db.collection(COLLECTIONS.USERS).get();
        usersToNotify = allUsersSnapshot.docs.map(doc => doc.id);
      } else {
        usersToNotify = roomUsers;
      }
      
      // Filtrar y enviar notificaciones
      for (const targetUserId of usersToNotify) {
        // No enviar notificación al remitente
        if (targetUserId === userId) continue;
        
        // Verificar si el usuario está presente en la sala
        const isPresent = utils.isUserPresentInRoom(targetUserId, roomId);
        
        if (!isPresent) {
          // Solo enviar push si NO está presente
          await sendPushNotification(
            targetUserId,
            `${username} dice:`,
            text.substring(0, 100),
            {
              type: "chat_message",
              roomId: roomId,
              messageId: message.id,
              senderId: userId
            }
          );
        }
      }
      
      ack?.({ success: true, id: message.id });

      if (roomId.startsWith("emergencia_")) {
        console.log(`${colors.red}🚨 ${username} → EMERGENCIA ${roomId}: ${text}${colors.reset}`);
      } else {
        console.log(`${colors.green}💬 ${username} → ${roomId}: ${text}${colors.reset}`);
      }

    } catch (err) {
      ack?.({ success: false, message: "Error guardando mensaje" });
      console.error(`${colors.red}❌ Error al guardar mensaje:${colors.reset}`, err);
    }
  });

  // ============================================================
  // 🎧 MENSAJES DE AUDIO
  // ============================================================
  socket.on("audio_message", async (data = {}, ack) => {
    try {
      const { userId, username } = data;
      let { roomId = socket.currentRoom || "general" } = data;

      console.log(`${colors.magenta}🎧 Evento → audio_message${colors.reset}`, {
        userId, username, roomId,
        hasAudioUrl: !!data.audioUrl,
        hasAudioData: !!data.audioData,
        hasAudioDataUrl: !!data.audioDataUrl
      });

      if (!userId || !username) {
        return ack?.({ success: false, message: "❌ userId/username inválidos" });
      }

      if (!state.chatRooms.has(roomId)) {
        return ack?.({ success: false, message: "❌ No estás en una sala válida" });
      }

      let finalAudioUrl = data.audioUrl || null;

      if (finalAudioUrl && /^https?:\/\//i.test(finalAudioUrl)) {
        console.log(`${colors.green}✅ audioUrl directo provisto${colors.reset}`);
      }
      else if (typeof data.audioDataUrl === "string" && data.audioDataUrl.startsWith("data:audio/")) {
        const mime = (data.audioDataUrl.match(/^data:(audio\/[a-zA-Z0-9.+-]+);base64,/) || [])[1] || "audio/mpeg";
        const base64 = data.audioDataUrl.split("base64,")[1] || "";
        finalAudioUrl = await storageService.saveBase64AudioToFirebase({ base64, mime, userId, roomId });
      }
      else if (typeof data.audioData === "string" && data.audioData.length > 0) {
        const mime = typeof data.mime === "string" && data.mime.startsWith("audio/") ? data.mime : "audio/mpeg";
        finalAudioUrl = await storageService.saveBase64AudioToFirebase({
          base64: data.audioData,
          mime,
          userId,
          roomId,
          ext: data.ext
        });
      }

      if (!finalAudioUrl) {
        return ack?.({ success: false, message: "❌ No se pudo obtener URL de audio" });
      }

      const message = {
        id: uuidv4(),
        userId,
        username,
        roomId,
        type: "audio",
        audioUrl: finalAudioUrl,
        content: "[Audio]",
        durationMs: typeof data.durationMs === "number" ? data.durationMs : undefined,
        timestamp: Date.now(),
      };

      await db.collection(COLLECTIONS.MESSAGES).add(message);

      const room = state.chatRooms.get(roomId);
      if (room) room.messageCount++;

      // 1. Enviar por socket a todos en la sala
      io.to(roomId).emit("audio_message", message);
      socket.emit("message_sent", { id: message.id, ...message });

      // 2. Enviar notificaciones push a usuarios no presentes
      const roomUsers = room ? Array.from(room.users) : [];
      
      for (const targetUserId of roomUsers) {
        if (targetUserId === userId) continue;
        
        const isPresent = utils.isUserPresentInRoom(targetUserId, roomId);
        
        if (!isPresent) {
          await sendPushNotification(
            targetUserId,
            `${username} envió un audio`,
            "Toca para escuchar",
            {
              type: "audio_message",
              roomId: roomId,
              messageId: message.id,
              senderId: userId,
              audioUrl: finalAudioUrl
            }
          );
        }
      }

      if (roomId.startsWith("emergencia_")) {
        console.log(`${colors.red}🚨 ${username} → EMERGENCIA ${roomId}: [Audio]${colors.reset}`);
      } else {
        console.log(`${colors.magenta}🎧 ${username} → ${roomId}: [Audio] URL=${finalAudioUrl}${colors.reset}`);
      }

      ack?.({ success: true, id: message.id, audioUrl: finalAudioUrl });

    } catch (err) {
      console.error(`${colors.red}❌ Error en audio_message:${colors.reset}`, err);
      ack?.({ success: false, message: "Error guardando mensaje de audio" });
    }
  });

  // ============================================================
  // 👤 GESTIÓN DE PERFILES
  // ============================================================
  socket.on("get_profile", async (data = {}, callback) => {
    try {
      const userId = data.userId;
      console.log(`${colors.cyan}📥 Evento → get_profile${colors.reset}`, data);

      if (!userId) {
        return callback?.({ success: false, message: "userId requerido" });
      }

      const snap = await db.collection(COLLECTIONS.USERS).doc(userId).get();
      if (!snap.exists) {
        return callback?.({ success: false, message: "Perfil no encontrado" });
      }

      const user = snap.data() || {};
      callback?.({
        success: true,
        ...user,
      });
    } catch (e) {
      console.error(`${colors.red}❌ Error get_profile:${colors.reset}`, e);
      callback?.({ success: false, message: e.message });
    }
  });

  socket.on("update_profile", async (data = {}, callback) => {
    try {
      console.log(`${colors.cyan}📥 Evento → update_profile${colors.reset}`, data);
      const {
        userId,
        fullName = "",
        username = "",
        email = "",
        phone = "",
        avatarUri = "",
      } = data;

      if (!userId) {
        return callback?.({ success: false, message: "userId requerido" });
      }

      const prevSnap = await db.collection(COLLECTIONS.USERS).doc(userId).get();
      const prevData = prevSnap.exists ? prevSnap.data() : {};
      let finalAvatar = prevData?.avatarUri || "";

      if (typeof avatarUri === "string" && avatarUri.trim() !== "") {
        if (utils.isDataUrl(avatarUri)) {
          finalAvatar = await storageService.uploadAvatarFromDataUrl(userId, avatarUri);
        } else if (utils.isHttpUrl(avatarUri)) {
          finalAvatar = avatarUri;
        } else {
          console.log(`${colors.gray}⚠️ URI local ignorada (${avatarUri})${colors.reset}`);
        }
      } else {
        console.log(`${colors.yellow}🟡 No llegó avatar nuevo, se mantiene el anterior${colors.reset}`);
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

      await db.collection(COLLECTIONS.USERS).doc(userId).set(updatedUser, { merge: true });

      const entry = state.connectedUsers.get(userId);
      if (entry) {
        entry.userData = { ...entry.userData, ...updatedUser };
      }

      console.log(`${colors.green}✅ Perfil actualizado para ${username}${colors.reset}`);
      io.emit("user_updated", updatedUser);

      callback?.({
        success: true,
        message: "Perfil actualizado correctamente",
        user: updatedUser,
      });

    } catch (error) {
      console.error(`${colors.red}❌ Error en update_profile:${colors.reset}`, error);
      callback?.({ success: false, message: error.message });
    }
  });

  socket.on("get_users", (data = {}, ack) => {
    const { roomId } = data;
    const room = state.chatRooms.get(roomId);
    if (!room) {
      ack?.({ success: false, message: "Sala no encontrada" });
      return;
    }

    const usersInRoom = Array.from(room.users).map(userId => {
      const userInfo = state.connectedUsers.get(userId);
      return userInfo ? userInfo.userData : null;
    }).filter(Boolean);

    ack?.({
      success: true,
      roomId,
      users: usersInRoom,
    });
  });

  // ============================================================
  // 🚨 SISTEMA DE EMERGENCIA (CORREGIDO - NOTIFICACIONES A NO PRESENTES)
  // ============================================================
  socket.on("emergency_alert", async (data = {}, ack) => {
    try {
      const {
        userId,
        userName,
        latitude,
        longitude,
        timestamp,
        emergencyType = "general",
      } = data;

      console.log(
        `${colors.red}🚨 Evento → emergency_alert:${colors.reset}`,
        { userId, userName, latitude, longitude, emergencyType }
      );

      if (!userId || !userName) {
        console.warn(`${colors.yellow}⚠️ Datos de usuario faltantes${colors.reset}`);
        return ack?.({ 
          success: false, 
          code: "INVALID_DATA", 
          message: "Datos de usuario inválidos" 
        });
      }

      if (typeof latitude !== "number" || typeof longitude !== "number") {
        console.warn(`${colors.yellow}⚠️ Coordenadas inválidas${colors.reset}`);
        return ack?.({ 
          success: false, 
          code: "INVALID_LOCATION", 
          message: "Ubicación inválida" 
        });
      }

      // RoomId de emergencia
      const emergencyRoomId = `emergencia_${userId}`;

      // 🔒 LOCK GLOBAL (1 emergencia a la vez)
      const lockResult = await db.runTransaction(async (tx) => {
        const snap = await tx.get(LOCK_DOC);
        const lock = snap.exists ? snap.data() : null;

        if (lock?.active === true) {
          return {
            allowed: false,
            activeEmergency: {
              userId: lock.userId || null,
              roomId: lock.roomId || null,
              startedAt: lock.startedAt || null,
            }
          };
        }

        tx.set(
          LOCK_DOC,
          {
            active: true,
            userId,
            roomId: emergencyRoomId,
            startedAt: Date.now(),
            emergencyType,
          },
          { merge: true }
        );

        return { allowed: true };
      });

      if (!lockResult.allowed) {
        return ack?.({
          success: false,
          code: "EMERGENCY_ALREADY_ACTIVE",
          message: "⚠️ Esta es una versión de prueba. Actualmente manejamos una emergencia a la vez, y ya hay una en curso. Volvé a intentarlo más tarde.",
          activeEmergency: lockResult.activeEmergency,
        });
      }

      // Obtener avatar
      let avatarUrl = null;
      try {
        const userDoc = await db.collection(COLLECTIONS.USERS).doc(userId).get();
        if (userDoc.exists) {
          const userData = userDoc.data();
          avatarUrl = userData?.avatarUrl || userData?.avatarUri || null;
        }
      } catch (e) {
        console.warn(`${colors.yellow}⚠️ Error obteniendo avatar:${colors.reset} ${e.message}`);
      }

      // Obtener vehículo primario
      let vehicleData = null;
      try {
        const vehiculoSnap = await db
          .collection(COLLECTIONS.VEHICLES)
          .where("userId", "==", userId)
          .where("isPrimary", "==", true)
          .where("isActive", "==", true)
          .limit(1)
          .get();

        if (!vehiculoSnap.empty) {
          const vehiculoDoc = vehiculoSnap.docs[0];
          const vehiculo = vehiculoDoc.data() || {};
          const typeRaw = vehiculo.type || vehiculo.tipo || null;

          vehicleData = {
            id: vehiculoDoc.id,
            type: typeRaw,
            name: vehiculo.name || vehiculo.nombre || null,
            brand: vehiculo.brand || vehiculo.marca || null,
            model: vehiculo.model || vehiculo.modelo || null,
            year: vehiculo.year || null,
            color: vehiculo.color || null,
            licensePlate: vehiculo.licensePlate || vehiculo.patente || null,
            photoUri: vehiculo.photoUri || vehiculo.fotoVehiculoUri || null,
            ...(typeRaw === "CAR" && { doors: vehiculo.doors }),
            ...(typeRaw === "MOTORCYCLE" && {
              cylinderCapacity: vehiculo.cylinderCapacity,
              mileage: vehiculo.mileage,
            }),
            ...(typeRaw === "BICYCLE" && {
              frameSerialNumber: vehiculo.frameSerialNumber,
              hasElectricMotor: vehiculo.hasElectricMotor,
              frameSize: vehiculo.frameSize,
            }),
          };
        }
      } catch (vehErr) {
        console.warn(`${colors.yellow}⚠️ Error obteniendo vehículo:${colors.reset} ${vehErr.message}`);
      }

      const emergencyData = {
        userId,
        userName,
        avatarUrl: avatarUrl,
        latitude,
        longitude,
        timestamp: timestamp || Date.now(),
        socketId: socket.id,
        emergencyType,
        status: "active",
        vehicleInfo: vehicleData,
      };

      state.emergencyAlerts.set(userId, emergencyData);
      if (!state.emergencyHelpers.has(userId)) {
        state.emergencyHelpers.set(userId, new Set());
      }

      // Guardar en Firestore
      try {
        await db
          .collection(COLLECTIONS.EMERGENCIES)
          .doc(userId)
          .set(
            {
              ...emergencyData,
              createdAt: Date.now(),
            },
            { merge: true }
          );
      } catch (fireErr) {
        console.error(`${colors.red}❌ Error guardando emergencia:${colors.reset}`, fireErr.message);
      }

      // Crear sala de emergencia
      const createdAt = Date.now();
      const emergencyRoom = {
        id: emergencyRoomId,
        name: `Emergencia ${userName}`,
        type: "emergency",
        description: `Sala de emergencia para ${userName}`,
        users: new Set([userId]),
        createdAt,
        messageCount: 0,
        emergencyData: emergencyData,
      };

      state.chatRooms.set(emergencyRoomId, emergencyRoom);
      state.emergencyUserRoom.set(userId, emergencyRoomId);

      socket.emit("emergency_room_created", {
        emergencyUserId: userId,
        emergencyRoomId,
      });

      io.emit("new_room_created", {
        id: emergencyRoom.id,
        name: emergencyRoom.name,
        type: emergencyRoom.type,
        description: emergencyRoom.description,
        userCount: emergencyRoom.users.size,
        messageCount: emergencyRoom.messageCount,
        createdAt: emergencyRoom.createdAt,
      });

      console.log(`${colors.red}🚨 Sala de emergencia creada: ${emergencyRoomId}${colors.reset}`);

      // Obtener usuarios cercanos (solo sockets)
      const nearbySockets = utils.getNearbyUsers(latitude, longitude, 50);
      
      // 1. ENVIAR POR SOCKET a usuarios cercanos y conectados
      let socketNotifications = 0;
      const notifiedUsers = new Set();
      
      nearbySockets.forEach((nearbySocketId) => {
        // Evitar enviar al mismo emisor
        if (nearbySocketId !== socket.id) {
          const targetSocket = io.sockets.sockets.get(nearbySocketId);
          if (targetSocket && targetSocket.userId) {
            notifiedUsers.add(targetSocket.userId);
            io.to(nearbySocketId).emit("emergency_alert", {
              ...emergencyData,
              emergencyRoomId,
            });
            socketNotifications++;
          }
        }
      });

      // 2. ENVIAR NOTIFICACIONES PUSH a usuarios cercanos NO conectados
      // Obtener todos los usuarios con ubicación de Firestore
      const usersSnapshot = await db.collection(COLLECTIONS.USERS).get();
      let pushNotifications = 0;
      
      for (const doc of usersSnapshot.docs) {
        const targetUserId = doc.id;
        const userData = doc.data();
        
        // Saltar al usuario que generó la emergencia
        if (targetUserId === userId) continue;
        
        // Si ya fue notificado por socket, saltar
        if (notifiedUsers.has(targetUserId)) continue;
        
        // Verificar si el usuario tiene ubicación y está dentro del radio
        if (userData.location && userData.location.lat && userData.location.lng) {
          const distance = utils.calculateDistance(
            latitude, longitude,
            userData.location.lat, userData.location.lng
          );
          
          if (distance <= 50) { // 50km radio
            // Enviar notificación push
            await sendPushNotification(
              targetUserId,
              "🚨 ¡EMERGENCIA CERCANA!",
              `${userName} necesita ayuda a ${Math.round(distance)}km de ti`,
              {
                type: "emergency",
                emergencyUserId: userId,
                latitude: latitude.toString(),
                longitude: longitude.toString(),
                distance: distance.toString(),
                emergencyRoomId: emergencyRoomId,
                avatarUrl: avatarUrl || "",
                emergencyType: emergencyType
              }
            );
            pushNotifications++;
          }
        }
      }

      console.log(`${colors.red}📢 ALERTA DIFUNDIDA:${colors.reset} ${userName}`);
      console.log(`${colors.blue}   → Sockets: ${socketNotifications} usuarios conectados${colors.reset}`);
      console.log(`${colors.magenta}   → Push: ${pushNotifications} usuarios no conectados${colors.reset}`);

      // Respuesta al cliente que originó la emergencia
      ack?.({
        success: true,
        message: "Alerta de emergencia enviada correctamente",
        vehicle: vehicleData,
        avatarUrl: avatarUrl,
        socketNotifications: socketNotifications,
        pushNotifications: pushNotifications,
        emergencyRoomId,
      });
    } catch (error) {
      console.error(`${colors.red}❌ Error en emergency_alert:${colors.reset}`, error);
      ack?.({
        success: false,
        code: "SERVER_ERROR",
        message: "Error procesando alerta de emergencia",
      });
    }
  });

  // ============================================================
  // ✅ EVENTOS DE EMERGENCIA RESTANTES (sin cambios significativos)
  // ============================================================
  socket.on("emergency_resolve", async (data = {}, ack) => {
    try {
      const { userId } = data;
      console.log(`${colors.green}✅ Evento → emergency_resolve:${colors.reset}`, { userId });

      if (!userId) {
        return ack?.({ success: false, message: "userId requerido" });
      }

      await releaseEmergencyLock();
      const emergencyRoomId = state.emergencyUserRoom.get(userId);

      if (emergencyRoomId && state.chatRooms.has(emergencyRoomId)) {
        io.to(emergencyRoomId).emit("emergency_resolved", {
          roomId: emergencyRoomId,
          message: "Emergencia resuelta"
        });

        try {
          await deleteEmergencyChatHistory(emergencyRoomId);
        } catch (deleteError) {
          console.warn(`${colors.yellow}⚠️ No se pudo eliminar el historial:${colors.reset}`, deleteError.message);
        }

        const room = state.chatRooms.get(emergencyRoomId);
        if (room) {
          room.users.forEach(roomUserId => {
            const entry = state.connectedUsers.get(roomUserId);
            if (entry) {
              entry.sockets.forEach(socketId => {
                io.sockets.sockets.get(socketId)?.leave(emergencyRoomId);
              });
            }
            const entry2 = state.connectedUsers.get(roomUserId);
            if (entry2 && entry2.userData?.currentRoom === emergencyRoomId) {
              entry2.userData.currentRoom = null;
            }
          });
        }

        state.chatRooms.delete(emergencyRoomId);
        state.emergencyUserRoom.delete(userId);
      }

      state.emergencyAlerts.delete(userId);
      state.emergencyHelpers.delete(userId);

      await db.collection(COLLECTIONS.EMERGENCIES).doc(userId).set({
        status: "resolved",
        resolvedAt: Date.now()
      }, { merge: true });

      io.emit("emergency_resolved", { userId });

      console.log(`${colors.green}✅ Emergencia resuelta para usuario: ${userId}${colors.reset}`);
      
      ack?.({
        success: true,
        message: "Emergencia resuelta correctamente",
        emergencyRoomId: emergencyRoomId,
        chatHistoryDeleted: true
      });
    } catch (error) {
      console.error(`${colors.red}❌ Error en emergency_resolve:${colors.reset}`, error);
      ack?.({ success: false, message: error.message });
    }
  });

  // ============================================================
  // 🔴 DESCONEXIÓN (MEJORADA - LIMPIA EMERGENCIA AUTOMÁTICAMENTE)
  // ============================================================
  socket.on("disconnect", async (reason) => {
    const userId = socket.userId;
    const username = socket.username;
    const currentRoom = socket.currentRoom;
    
    console.log(`${colors.red}🔌 Socket desconectado:${colors.reset} ${username || socket.id} (${reason})`);

    // 🔍 1. VERIFICAR SI EL USUARIO TIENE UNA EMERGENCIA ACTIVA
    const hasActiveEmergency = state.emergencyAlerts.has(userId);
    const emergencyRoomId = state.emergencyUserRoom.get(userId);
    
    if (userId) {
      const entry = state.connectedUsers.get(userId);
      if (entry) {
        entry.sockets.delete(socket.id);
        
        // 🔍 2. DETERMINAR SI ES LA ÚLTIMA CONEXIÓN DEL USUARIO
        const isLastConnection = entry.sockets.size === 0;
        
        // Actualizar en Firestore (remover socketId)
        try {
          await db.collection(COLLECTIONS.USERS).doc(userId).update({
            socketIds: admin.firestore.FieldValue.arrayRemove(socket.id),
            lastSeen: Date.now(),
            // Si es la última conexión, marcar como offline
            ...(isLastConnection && { isOnline: false })
          });
        } catch (error) {
          console.warn(`${colors.yellow}⚠️ Error actualizando Firestore en desconexión:${colors.reset}`, error.message);
        }
        
        if (isLastConnection) {
          // Usuario completamente offline
          entry.userData.isOnline = false;
          state.connectedUsers.delete(userId);
          
          // 🚨 3. SI TIENE EMERGENCIA ACTIVA Y SE DESCONECTÓ COMPLETAMENTE, LIMPIARLA
          if (hasActiveEmergency) {
            console.log(`${colors.red}🚨 USUARIO CON EMERGENCIA ACTIVA SE DESCONECTÓ: ${username}${colors.reset}`);
            await cleanupUserEmergency(userId, username, emergencyRoomId);
          }
          
          // Notificar a otros usuarios
          io.emit('user_status_changed', {
            userId,
            username,
            isOnline: false,
            emergencyCleared: hasActiveEmergency // Informar si se limpió emergencia
          });
          
          console.log(`${colors.red}🔴 Usuario ${username} completamente desconectado. ${hasActiveEmergency ? '(Emergencia limpiada)' : ''}${colors.reset}`);
        } else {
          // El usuario tiene otras conexiones activas
          console.log(`${colors.yellow}⚠️ Usuario ${username} tiene ${entry.sockets.size} conexiones restantes${colors.reset}`);
        }
      } else if (hasActiveEmergency) {
        // Caso especial: usuario tenía emergencia pero no estaba en connectedUsers
        console.log(`${colors.red}🚨 USUARIO NO ENCONTRADO PERO CON EMERGENCIA ACTIVA: ${userId}${colors.reset}`);
        await cleanupUserEmergency(userId, username, emergencyRoomId);
      }

      // Notificar salida de sala
      if (currentRoom) {
        socket.to(currentRoom).emit("user_left_room", {
          userId: userId,
          username: username,
          roomId: currentRoom,
          message: `${username} se desconectó`,
          timestamp: Date.now(),
          hadEmergency: hasActiveEmergency
        });

        utils.updateRoomUserList(currentRoom);
      }
    }

    // Actualizar lista de usuarios conectados
    io.emit(
      "connected_users",
      Array.from(state.connectedUsers.values()).map((u) => ({
        ...u.userData,
        socketCount: u.sockets.size,
      }))
    );
  });
});

// ============================================================
// 🚀 INICIALIZACIÓN Y INICIO DEL SERVIDOR
// ============================================================
initializeDefaultRooms();

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`${colors.green}🚀 Servidor de chat corriendo en puerto ${PORT}${colors.reset}`);
  console.log(`${colors.cyan}🌐 http://localhost:${PORT}${colors.reset}`);
  console.log(`${colors.blue}💬 Sistema de salas activo${colors.reset}`);
  console.log(`${colors.red}🚨 Sistema de Emergencia activo${colors.reset}`);
  console.log(`${colors.yellow}🔒 Sistema de LOCK global (1 emergencia a la vez)${colors.reset}`);
  console.log(`${colors.green}✅ Sistema de notificaciones push configurado${colors.reset}`);
  console.log(`${colors.magenta}📱 Notificaciones solo a usuarios NO presentes${colors.reset}`);
  console.log(`${colors.red}🧹 Sistema de limpieza automática de emergencias activo${colors.reset}`);
});