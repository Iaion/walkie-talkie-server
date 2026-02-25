// ============================================================
// 🌐 Servidor Node.js con Socket.IO, Firebase Firestore y Storage
// 💬 Chat General + Sistema de Emergencia + Gestión de Vehículos
// 🔥 CON MEJORAS PARA TOKENS FCM - VERSIÓN CORREGIDA
// ============================================================

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

// ============================================================
// 🔒 CONFIGURACIÓN DE LOCKS
// ============================================================
const LOCK_REF = db.collection("LOCKS").doc("active_emergency");
const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutos (ajustable)

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
// 🔒 ADQUIRIR LOCK DE EMERGENCIA (LOCKS/active_emergency) - ROBUSTO
// ============================================================
async function acquireEmergencyLock(
  { userId, roomId, emergencyType = "general", reason = "create_emergency" } = {}
) {
  if (!userId) throw new Error("acquireEmergencyLock: userId requerido");

  const now = Date.now();
  const normalizedRoomId = roomId || `emergencia_${userId}`;

  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(LOCK_REF);

    // ✅ Si no existe, lo creamos como ACTIVO
    if (!snap.exists) {
      tx.set(LOCK_REF, {
        active: true,
        userId,
        roomId: normalizedRoomId,
        emergencyType,
        startedAt: now,
        acquiredAt: now,
        acquireReason: reason,
        releasedAt: null,
        releaseReason: null,
        replacedStaleLock: false,
        previousLock: null,
      });
      return { ok: true, staleReplaced: false, created: true };
    }

    const lock = snap.data() || {};
    const isActive = lock.active === true;

    const startedAt =
      typeof lock.startedAt === "number" && lock.startedAt > 0 ? lock.startedAt : 0;

    // ✅ Si está activo pero NO tiene startedAt válido → tratar como stale
    const staleByMissingStartedAt = isActive && startedAt === 0;

    const staleByTTL =
      isActive && startedAt > 0 && (now - startedAt) > LOCK_TTL_MS;

    const stale = staleByMissingStartedAt || staleByTTL;

    // ✅ Idempotente: si el lock activo ya es del MISMO userId, lo "renovamos"
    if (isActive && !stale && lock.userId === userId) {
      tx.update(LOCK_REF, {
        active: true,
        userId,
        roomId: normalizedRoomId,
        emergencyType,
        startedAt: startedAt || now,
        acquiredAt: lock.acquiredAt || now,
        lastTouchAt: now,
        acquireReason: reason,
      });

      return {
        ok: true,
        staleReplaced: false,
        alreadyOwned: true,
        lock: { ...lock, roomId: normalizedRoomId },
      };
    }

    // ❌ Lock activo y NO stale => bloquear
    if (isActive && !stale) {
      return {
        ok: false,
        code: "LOCK_ACTIVE",
        message: `Ya hay una emergencia activa (userId=${lock.userId || "?"})`,
        lock,
      };
    }

    // ✅ Stale: reemplazarlo
    tx.update(LOCK_REF, {
      active: true,
      userId,
      roomId: normalizedRoomId,
      emergencyType,
      startedAt: now,
      acquiredAt: now,
      lastTouchAt: now,
      acquireReason: reason,
      releasedAt: null,
      releaseReason: null,
      replacedStaleLock: true,
      previousLock: {
        ...lock,
        replacedAt: now,
        replacedBy: userId,
        replacedRoomId: normalizedRoomId,
        staleByMissingStartedAt,
        staleByTTL,
      },
    });

    return {
      ok: true,
      staleReplaced: true,
      staleByMissingStartedAt,
      staleByTTL,
      previousLockUserId: lock.userId || null,
    };
  });
}

// ============================================================
// 🔓 LIBERAR LOCK DE EMERGENCIA (LOCKS/active_emergency)
// ============================================================
async function releaseEmergencyLock(
  { userId = null, roomId = null, reason = "manual_or_system", force = false } = {}
) {
  const now = Date.now();

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(LOCK_REF);

      // ✅ Si no existe, lo creamos liberado (auto-heal)
      if (!snap.exists) {
        tx.set(LOCK_REF, {
          active: false,
          releasedAt: now,
          releaseReason: reason,
          userId: null,
          roomId: null,
          emergencyType: "general",
          previousLock: null,
          createdAt: now,
        });
        return { ok: true, created: true };
      }

      const lock = snap.data() || {};
      const isActive = lock.active === true;

      // ✅ Idempotente: si ya está liberado
      if (!isActive) {
        return { ok: true, alreadyReleased: true, current: lock };
      }

      // ✅ Seguridad: si lock pertenece a otro userId, no liberar salvo force
      if (!force && userId && lock.userId && lock.userId !== userId) {
        console.log(
          `${colors.yellow}⚠️ releaseEmergencyLock: NO libero (lock de otro usuario). lockUser=${lock.userId} userId=${userId}${colors.reset}`
        );
        return { ok: false, code: "LOCK_OTHER_USER", lockUserId: lock.userId, current: lock };
      }

      const previous = {
        active: true,
        userId: lock.userId || null,
        roomId: lock.roomId || null,
        emergencyType: lock.emergencyType || "general",
        startedAt: lock.startedAt || null,
        replacedStaleLock: lock.replacedStaleLock || false,
        releasedAt: lock.releasedAt || null,
        releaseReason: lock.releaseReason || null,
      };

      tx.update(LOCK_REF, {
        active: false, // ✅ CLAVE
        releasedAt: now,
        releaseReason: reason,
        releasedBy: userId || null,
        releasedRoomId: roomId || null,
        userId: null,
        roomId: null,
        emergencyType: "general",
        previousLock: {
          ...previous,
          releasedAt: now,
          releaseReason: reason,
          releasedBy: userId || null,
          releasedRoomId: roomId || null,
        },
      });

      return { ok: true, updated: true, previous };
    });

    if (result?.ok && result?.updated) {
      console.log(`${colors.green}🔓 Lock liberado (active=false)${colors.reset}`, {
        reason,
        force,
        userId,
        roomId,
      });
    } else if (result?.ok && result?.alreadyReleased) {
      console.log(`${colors.gray}ℹ️ Lock ya estaba liberado${colors.reset}`, {
        reason,
        userId,
        roomId,
      });
    }

    return result;
  } catch (e) {
    console.error(`${colors.red}❌ releaseEmergencyLock falló:${colors.reset}`, e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

// ============================================================
// 🧹 FUNCIÓN PARA LIMPIAR EMERGENCIA (MEJORADA - SEGURA CON TOKENS)
// ============================================================
async function cleanupUserEmergency(userId, username, emergencyRoomId, reason = "user_disconnected") {
  try {
    console.log(
      `${colors.red}🧹 LIMPIANDO EMERGENCIA DE USUARIO: ${username || userId}${colors.reset}`
    );

    // 🔍 1. VERIFICAR SI REALMENTE EXISTE UNA EMERGENCIA ACTIVA
    const hasActiveEmergency = state.emergencyAlerts.has(userId);
    const actualRoomId = state.emergencyUserRoom.get(userId) || emergencyRoomId;

    if (!hasActiveEmergency && !actualRoomId) {
      console.log(`${colors.yellow}⚠️ No hay emergencia activa para limpiar: ${userId}${colors.reset}`);
      return false;
    }

    const roomIdToClean = actualRoomId;
    const safeUserName = username || state.emergencyAlerts.get(userId)?.userName || "Usuario desconocido";

    // 2. LIMPIAR ESTADO INTERNO PRIMERO
    state.emergencyAlerts.delete(userId);
    state.emergencyHelpers.delete(userId);
    state.emergencyUserRoom.delete(userId);

    // 3. NOTIFICAR A TODOS ANTES DE LIMPIAR LA SALA
    io.emit("emergency_cancelled", {
      userId,
      userName: safeUserName,
      username: safeUserName,
      roomId: roomIdToClean,
      reason,
      timestamp: Date.now(),
      isActive: false,
    });

    // 4. MANEJAR LA SALA DE EMERGENCIA SI EXISTE
    if (roomIdToClean) {
      console.log(`${colors.cyan}📝 Limpiando sala de emergencia: ${roomIdToClean}${colors.reset}`);

      // a) Notificar a todos en la sala
      io.to(roomIdToClean).emit("emergency_ended", {
        roomId: roomIdToClean,
        userId,
        username: safeUserName,
        reason,
        message: `${safeUserName} finalizó la emergencia.`,
        timestamp: Date.now(),
      });

      // b) Sacar a todos de la sala
      const socketsInRoom = io.sockets.adapter.rooms.get(roomIdToClean);
      if (socketsInRoom) {
        for (const socketId of socketsInRoom) {
          const socket = io.sockets.sockets.get(socketId);
          if (socket) {
            socket.leave(roomIdToClean);
            if (socket.userId === userId) {
              socket.currentRoom = null;
            }
          }
        }
      }

      // c) Eliminar del estado de chatRooms si existe
      if (state.chatRooms.has(roomIdToClean)) {
        state.chatRooms.delete(roomIdToClean);
      }

      // d) Opcional: eliminar historial de chat
      try {
        await deleteEmergencyChatHistory(roomIdToClean);
        console.log(`${colors.green}🗑️ Historial de chat eliminado: ${roomIdToClean}${colors.reset}`);
      } catch (chatError) {
        console.warn(
          `${colors.yellow}⚠️ No se pudo eliminar historial de chat:${colors.reset}`,
          chatError.message
        );
      }
    }

    // 5. ACTUALIZAR FIRESTORE - USANDO UPDATE() PARA SEGURIDAD
    try {
      const userRef = db.collection(COLLECTIONS.USERS).doc(userId);
      
      // Usar update() en lugar de set() para no sobrescribir tokens
      await userRef.update({
        hasActiveEmergency: false,
        emergencyRoomId: null,
        lastEmergencyEnded: Date.now(),
        lastSeen: Date.now(),
      });
      
      console.log(`${colors.green}✅ Firestore actualizado (Update seguro) para usuario: ${userId}${colors.reset}`);
      
    } catch (firestoreError) {
      console.error(
        `${colors.red}❌ Error actualizando Firestore:${colors.reset}`,
        firestoreError.message
      );
    }

    // 6. ACTUALIZAR DOCUMENTO DE EMERGENCIA
    try {
      const emergencyRef = db.collection(COLLECTIONS.EMERGENCIES).doc(userId);
      const emergencyDoc = await emergencyRef.get();

      const endedPayload = {
        status: "cancelled",
        endReason: reason,
        endedAt: Date.now(),
        isActive: false,
        cleanedBySystem: true,
        cleanedAt: Date.now(),
        roomId: roomIdToClean || null,
      };

      if (emergencyDoc.exists) {
        await emergencyRef.update(endedPayload);
      } else {
        await emergencyRef.set({
          userId,
          username: safeUserName,
          startReason: "unknown",
          startedAt: Date.now() - 60000,
          createdAt: Date.now(),
          ...endedPayload,
        });
      }

      console.log(`${colors.green}✅ Documento de emergencia actualizado${colors.reset}`);
    } catch (emergencyError) {
      console.warn(
        `${colors.yellow}⚠️ Error actualizando documento de emergencia:${colors.reset}`,
        emergencyError.message
      );
    }

    // 7. ✅ LIBERAR EL LOCK GLOBAL
    try {
      await releaseEmergencyLock({
        userId,
        roomId: roomIdToClean,
        reason,
        force: false,
      });

      console.log(`${colors.green}🔓 Lock de emergencia liberado${colors.reset}`);
    } catch (lockError) {
      console.warn(`${colors.yellow}⚠️ Error liberando lock:${colors.reset}`, lockError.message);
    }

    // 8. NOTIFICAR CAMBIO DE ESTADO A TODOS LOS USUARIOS
    io.emit("user_status_changed", {
      userId,
      username: safeUserName,
      hasActiveEmergency: false,
      emergencyCleared: true,
      timestamp: Date.now(),
    });

    // 9. ACTUALIZAR LISTA DE USUARIOS CONECTADOS
    const connectedUsersList = Array.from(state.connectedUsers.values()).map((u) => ({
      ...u.userData,
      socketCount: u.sockets.size,
    }));
    io.emit("connected_users", connectedUsersList);

    console.log(
      `${colors.green}✅ Emergencia COMPLETAMENTE limpiada para: ${safeUserName}${colors.reset}`
    );
    return true;
  } catch (error) {
    console.error(`${colors.red}❌ ERROR CRÍTICO en cleanupUserEmergency:${colors.reset}`, error);

    try {
      state.emergencyAlerts.delete(userId);
      state.emergencyHelpers.delete(userId);
      state.emergencyUserRoom.delete(userId);
    } catch (cleanupError) {
      console.error(
        `${colors.red}❌ Error incluso en limpieza mínima:${colors.reset}`,
        cleanupError
      );
    }

    return false;
  }
}

// ============================================================
// 🛠️ FUNCIONES UTILITARIAS
// ============================================================
const utils = {
  isHttpUrl: (str) => typeof str === "string" && /^https?:\/\//i.test(str),
  isDataUrl: (str) => typeof str === "string" && /^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(str),
  
  getMimeFromDataUrl: (dataUrl) => {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,/.exec(dataUrl || "");
    return match ? match[1] : "image/jpeg";
  },
  
  getBase64FromDataUrl: (dataUrl) => {
    const idx = (dataUrl || "").indexOf("base64,");
    return idx !== -1 ? dataUrl.substring(idx + 7) : null;
  },

  calculateDistance: (lat1, lon1, lat2, lon2) => {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  },

  getNearbyUsers: (alertLat, alertLng, radiusKm = 50) => {
    const socketsWithin = [];
    
    console.log(`${colors.blue}📍 Buscando usuarios cercanos a:${colors.reset}`, { alertLat, alertLng, radiusKm });
    console.log(`${colors.blue}📊 Total de usuarios conectados:${colors.reset} ${state.connectedUsers.size}`);
    
    state.connectedUsers.forEach(({ userData, sockets }, userId) => {
      const loc = userData?.lastKnownLocation;
      
      if (loc && typeof loc.lat === "number" && typeof loc.lng === "number") {
        const d = utils.calculateDistance(alertLat, alertLng, loc.lat, loc.lng);
        if (d <= radiusKm) {
          sockets.forEach((sid) => socketsWithin.push(sid));
        }
      }
    });

    if (socketsWithin.length === 0) {
      state.connectedUsers.forEach(({ sockets }) => {
        sockets.forEach((sid) => socketsWithin.push(sid));
      });
    }
    
    return socketsWithin;
  },

  isUserPresentInRoom: (userId, roomId) => {
    const entry = state.connectedUsers.get(userId);
    if (!entry) return false;
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room) return false;
    for (const sid of entry.sockets) {
      if (room.has(sid)) return true;
    }
    return false;
  },

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

async function getActiveFcmTokens(userId) {
  const snap = await db
    .collection(COLLECTIONS.USERS).doc(userId)
    .collection("fcmTokens")
    .where("enabled", "==", true)
    .get();

  const devices = [];
  snap.forEach(doc => {
    const d = doc.data() || {};
    const token = typeof d.token === "string" ? d.token.trim() : "";
    if (token.length > 0) {
      devices.push({ deviceId: doc.id, token });
    }
  });

  // dedupe tokens manteniendo el primer deviceId
  const seen = new Set();
  const uniq = [];
  for (const d of devices) {
    if (!seen.has(d.token)) {
      seen.add(d.token);
      uniq.push(d);
    }
  }
  return uniq;
}


async function disableInvalidDevices(userId, deviceIds = []) {
  if (!deviceIds.length) return;

  const batch = db.batch();
  const base = db.collection(COLLECTIONS.USERS).doc(userId).collection("fcmTokens");

  deviceIds.forEach(id => {
    const ref = base.doc(id);
    batch.set(ref, {
      enabled: false,
      invalidatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  await batch.commit();
}



// ============================================================
// 🚀 FUNCIÓN SEGURA PARA ENVIAR NOTIFICACIONES PUSH (NO ELIMINA TOKENS)
// ============================================================

async function sendToUserDevices(userId, title, body, data = {}) {
  try {
    const devices = await getActiveFcmTokens(userId);
    const tokens = devices.map(d => d.token);

    if (!tokens.length) {
      console.log(`${colors.yellow}⚠️ Usuario ${userId} sin tokens activos (subcolección)${colors.reset}`);
      return false;
    }

    const merged = {
      ...data,
      title,
      body,
      timestamp: Date.now(),
      emergency_user_id: data.emergency_user_id ?? data.userId ?? "",
      emergency_user_name: data.emergency_user_name ?? data.userName ?? "",
      emergency_latitude: data.emergency_latitude ?? data.latitude ?? "",
      emergency_longitude: data.emergency_longitude ?? data.longitude ?? "",
      emergency_avatar_url: data.emergency_avatar_url ?? data.avatarUrl ?? "",
      emergency_room_id: data.emergency_room_id ?? data.roomId ?? "",
      vehicle_foto: data.vehicle_foto ?? data.fotoVehiculoUri ?? "",
      vehicle_marca: data.vehicle_marca ?? data.marca ?? "",
      vehicle_modelo: data.vehicle_modelo ?? data.modelo ?? "",
      vehicle_patente: data.vehicle_patente ?? data.patente ?? "",
      vehicle_color: data.vehicle_color ?? data.color ?? "",
    };

    const safeData = Object.fromEntries(
      Object.entries(merged).map(([k, v]) => [k, v == null ? "" : String(v)])
    );

    const message = {
      tokens,
      android: { priority: "high" },
      data: safeData,
      apns: {
        headers: { "apns-priority": "10" },
        payload: { aps: { "content-available": 1 } },
      },
    };

    const res = await messaging.sendEachForMulticast(message);

    const ok = res.successCount > 0;
    console.log(
      `${ok ? colors.green : colors.yellow}📱 Push a ${userId}: ${res.successCount}/${tokens.length} ok${colors.reset}`
    );

    // Log detallado de errores (CLAVE para debug)
    res.responses.forEach((r, idx) => {
      if (!r.success) {
        console.log(
          `${colors.yellow}⚠️ FCM fail token[${idx}]: deviceId=${devices[idx]?.deviceId} code=${r.error?.code} msg=${r.error?.message}${colors.reset}`
        );
      }
    });

    // Deshabilitar tokens inválidos automáticamente
    const invalidDeviceIds = [];
    res.responses.forEach((r, idx) => {
      if (!r.success) {
        const code = r.error?.code || "";
        if (
          code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token"
        ) {
          if (devices[idx]?.deviceId) invalidDeviceIds.push(devices[idx].deviceId);
        }
      }
    });

    if (invalidDeviceIds.length) {
      console.log(`${colors.yellow}🧹 Deshabilitando ${invalidDeviceIds.length} tokens inválidos de ${userId}${colors.reset}`);
      await disableInvalidDevices(userId, invalidDeviceIds);
    }

    return ok;
  } catch (error) {
    console.error(`${colors.red}❌ Error enviando push:${colors.reset}`, error);
    return false;
  }
}


async function sendPushNotification(userId, title, body, data = {}) {
  return sendToUserDevices(userId, title, body, data);
}

async function sendEmergencyNotification(userId, title, body, data = {}) {
  return sendToUserDevices(userId, title, body, data);
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
// 🧹 FUNCIÓN PARA LIMPIAR TOKENS INVALIDOS (OPCIONAL - CRON JOB)
// ============================================================
async function cleanupInvalidTokens() {
  console.log(`${colors.cyan}🧹 Iniciando limpieza de tokens FCM inválidos...${colors.reset}`);
  
  try {
    const usersSnapshot = await db.collection(COLLECTIONS.USERS).get();
    let totalCleaned = 0;
    let usersProcessed = 0;
    
    for (const doc of usersSnapshot.docs) {
      const userId = doc.id;
      const userData = doc.data() || {};
      const tokens = Array.isArray(userData.fcmTokens) ? userData.fcmTokens : [];
      
      if (tokens.length === 0) continue;
      
      // Verificar tokens en lote
      try {
        const response = await messaging.sendEachForMulticast({
          tokens: tokens,
          data: { type: 'token_validation_check' }
        });
        
        const invalidTokens = [];
        response.responses.forEach((resp, idx) => {
          if (!resp.success) {
            const code = resp.error?.code || '';
            if (code === 'messaging/registration-token-not-registered' || 
                code === 'messaging/invalid-registration-token') {
              invalidTokens.push(tokens[idx]);
            }
          }
        });
        
        if (invalidTokens.length > 0) {
          const userRef = db.collection(COLLECTIONS.USERS).doc(userId);
          
          // Actualizar en transacción
          await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) return;
            
            const currentData = userDoc.data();
            const currentTokens = Array.isArray(currentData.fcmTokens) ? currentData.fcmTokens : [];
            const currentDevices = currentData.devices || {};
            
            // Filtrar tokens válidos
            const validTokens = currentTokens.filter(t => !invalidTokens.includes(t));
            
            // Filtrar dispositivos con tokens inválidos
            const validDevices = {};
            Object.entries(currentDevices).forEach(([deviceId, deviceInfo]) => {
              if (deviceInfo.token && !invalidTokens.includes(deviceInfo.token)) {
                validDevices[deviceId] = deviceInfo;
              }
            });
            
            // Actualizar solo si hay cambios
            if (validTokens.length !== currentTokens.length || 
                Object.keys(validDevices).length !== Object.keys(currentDevices).length) {
              
              transaction.update(userRef, {
                fcmTokens: validTokens,
                devices: validDevices,
                lastTokenCleanup: Date.now(),
                cleanupRemoved: invalidTokens.length
              });
              
              totalCleaned += invalidTokens.length;
            }
          });
          
          console.log(`${colors.yellow}🧹 Limpiados ${invalidTokens.length} tokens inválidos de ${userId}${colors.reset}`);
        }
        
      } catch (error) {
        console.warn(`${colors.yellow}⚠️ Error validando tokens para ${userId}:${colors.reset}`, error.message);
      }
      
      usersProcessed++;
      if (usersProcessed % 10 === 0) {
        console.log(`${colors.gray}📊 Procesados ${usersProcessed} usuarios...${colors.reset}`);
      }
    }
    
    console.log(`${colors.green}✅ Limpieza completada: ${totalCleaned} tokens eliminados de ${usersProcessed} usuarios${colors.reset}`);
    
  } catch (error) {
    console.error(`${colors.red}❌ Error en limpieza automática:${colors.reset}`, error);
  }
}

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
        console.warn(`${colors.yellow}⚠️ No se pudieron limpiar avatares antiguos:${colors.reset}`, cleanupErr.message);
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
// 🔥 NUEVOS ENDPOINTS PARA GESTIÓN DE TOKENS FCM
// ============================================================
app.post("/fcm/cleanup-tokens", async (req, res) => {
  try {
    const { userId, invalidTokens } = req.body;
    
    if (!userId || !Array.isArray(invalidTokens)) {
      return res.status(400).json({ 
        success: false, 
        message: "userId y invalidTokens array son requeridos" 
      });
    }

    const userRef = db.collection(COLLECTIONS.USERS).doc(userId);
    let removedCount = 0;
    
    await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      
      if (!userDoc.exists) {
        throw new Error("Usuario no encontrado");
      }
      
      const userData = userDoc.data();
      const currentTokens = userData.fcmTokens || [];
      const currentFcmToken = userData.fcmToken || "";
      const currentDevices = userData.devices || {};
      
      // Filtrar tokens válidos
      const validTokens = currentTokens.filter(
        token => !invalidTokens.includes(token)
      );
      
      // Si el token principal es inválido, limpiarlo
      const newFcmToken = invalidTokens.includes(currentFcmToken) ? "" : currentFcmToken;
      
      // Limpiar devices con tokens inválidos
      const validDevices = {};
      Object.entries(currentDevices).forEach(([deviceId, deviceInfo]) => {
        if (deviceInfo.token && !invalidTokens.includes(deviceInfo.token)) {
          validDevices[deviceId] = deviceInfo;
        } else {
          removedCount++;
        }
      });
      
      transaction.update(userRef, {
        fcmTokens: validTokens,
        fcmToken: newFcmToken,
        devices: validDevices,
        tokensCleanedAt: Date.now(),
        tokensCleanedCount: invalidTokens.length
      });
    });
    
    console.log(`${colors.green}✅ Tokens limpiados para ${userId}: ${removedCount} tokens inválidos eliminados${colors.reset}`);
    
    res.json({ 
      success: true, 
      message: `Se eliminaron ${removedCount} tokens inválidos`,
      removedCount,
      cleanedAt: Date.now()
    });
    
  } catch (error) {
    console.error(`${colors.red}❌ Error limpiando tokens:${colors.reset}`, error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

app.get("/fcm/user-tokens/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const userDoc = await db.collection(COLLECTIONS.USERS).doc(userId).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ 
        success: false, 
        message: "Usuario no encontrado" 
      });
    }
    
    const userData = userDoc.data();
    const tokens = {
      fcmTokens: userData.fcmTokens || [],
      fcmToken: userData.fcmToken || "",
      devices: userData.devices || {},
      count: (userData.fcmTokens?.length || 0) + (userData.fcmToken ? 1 : 0),
      lastUpdated: userData.fcmTokensUpdatedAt || null,
      tokensCleanedAt: userData.tokensCleanedAt || null
    };
    
    res.json({
      success: true,
      userId,
      tokens,
      totalTokens: tokens.count
    });
    
  } catch (error) {
    console.error(`${colors.red}❌ Error obteniendo tokens:${colors.reset}`, error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

app.post("/fcm/refresh-token", async (req, res) => {
  try {
    const { userId, oldToken, newToken, deviceId } = req.body;
    
    if (!userId || !newToken) {
      return res.status(400).json({ 
        success: false, 
        message: "userId y newToken son requeridos" 
      });
    }

    const userRef = db.collection(COLLECTIONS.USERS).doc(userId);
    const now = Date.now();
    
    await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      
      if (!userDoc.exists) {
        throw new Error("Usuario no encontrado");
      }
      
      const userData = userDoc.data();
      let currentTokens = userData.fcmTokens || [];
      const currentDevices = userData.devices || {};
      
      // Si hay oldToken, reemplazarlo
      if (oldToken && currentTokens.includes(oldToken)) {
        currentTokens = currentTokens.filter(token => token !== oldToken);
      }
      
      // Agregar el nuevo token si no existe
      if (!currentTokens.includes(newToken)) {
        currentTokens.push(newToken);
      }
      
      // Actualizar device si se proporciona deviceId
      let updatedDevices = { ...currentDevices };
      if (deviceId && updatedDevices[deviceId]) {
        updatedDevices[deviceId] = {
          ...updatedDevices[deviceId],
          token: newToken,
          lastActive: now,
          lastTokenRefresh: now
        };
      }
      
      transaction.update(userRef, {
        fcmTokens: currentTokens,
        fcmToken: newToken,
        fcmTokensUpdatedAt: now,
        devices: updatedDevices,
        lastTokenRefresh: now
      });
    });
    
    console.log(`${colors.green}✅ Token refrescado para ${userId}${colors.reset}`);
    
    res.json({ 
      success: true, 
      message: "Token actualizado correctamente",
      updatedAt: Date.now()
    });
    
  } catch (error) {
    console.error(`${colors.red}❌ Error refrescando token:${colors.reset}`, error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
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
// 🔌 SOCKET.IO - MANEJO DE CONEXIONES
// ============================================================
io.on("connection", (socket) => {
  console.log(`${colors.cyan}🔗 NUEVA CONEXIÓN SOCKET:${colors.reset} ${socket.id}`);

  // ============================================================
  // 🔑 EVENTO: REGISTRAR TOKEN FCM (MEJORADO)
  // ============================================================
 socket.on("register_fcm_token", async (data = {}, callback) => {
  try {
    const { userId, fcmToken, deviceId, platform, deviceModel } = data;

    if (!userId || !fcmToken) {
      return callback?.({ success: false, message: "userId y fcmToken requeridos" });
    }

    // ✅ Ideal: que venga siempre desde Android (DeviceIdProvider)
    const uniqueDeviceId =
      (typeof deviceId === "string" && deviceId.trim().length > 0)
        ? deviceId.trim()
        : `device_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    const userRef = db.collection(COLLECTIONS.USERS).doc(userId);
    const tokenRef = userRef.collection("fcmTokens").doc(uniqueDeviceId);

    // ✅ Upsert en subcolección (fuente de verdad)
    await tokenRef.set(
      {
        token: String(fcmToken),
        platform: platform || "android",
        deviceModel: deviceModel || null,
        socketId: socket.id,
        enabled: true,
        lastActiveAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        // createdAt solo si no existía
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // ✅ Opcional: marcar actividad en el doc del usuario (liviano)
    await userRef.set(
      {
        socketIds: admin.firestore.FieldValue.arrayUnion(socket.id),
        lastTokenRefreshAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.log(
      `${colors.green}✅ Token FCM guardado en subcolección para ${userId} (deviceId=${uniqueDeviceId})${colors.reset}`
    );

    callback?.({
      success: true,
      message: "Token registrado",
      deviceId: uniqueDeviceId,
    });
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

    socket.userId = userId;
    socket.username = username;

    const defaultRoom = "general";
    socket.join(defaultRoom);
    socket.currentRoom = defaultRoom;

    const generalRoom = state.chatRooms.get(defaultRoom);
    if (generalRoom) {
      generalRoom.users.add(userId);
    }

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
      // Usar update() en lugar de set() para mayor seguridad
      await db.collection(COLLECTIONS.USERS).doc(userId).update({
        isOnline: true,
        lastLogin: Date.now(),
        currentRoom: defaultRoom,
        socketIds: admin.firestore.FieldValue.arrayUnion(socket.id),
        lastSeen: Date.now()
      });
      console.log(`${colors.green}🔑 Usuario sincronizado con Firebase: ${username}${colors.reset}`);
    } catch (error) {
      console.error(`${colors.red}❌ Error al registrar usuario:${colors.reset}`, error);
    }

    io.emit(
      "connected_users",
      Array.from(state.connectedUsers.values()).map((u) => ({ 
        ...u.userData, 
        socketCount: u.sockets.size 
      }))
    );

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

    socket.emit("join_success", { 
      room: "general", 
      message: `Bienvenido al chat general, ${username}!` 
    });

    socket.to(defaultRoom).emit("user_joined_room", {
      userId: userId,
      username: username,
      roomId: defaultRoom,
      message: `${username} se unió a la sala`,
      timestamp: Date.now()
    });

    utils.updateRoomUserList(defaultRoom);

    ack?.({ success: true });
    console.log(`${colors.green}✅ ${username} conectado al chat general${colors.reset}`);
  });

  // ============================================================
  // 📍 ACTUALIZAR UBICACIÓN GENERAL
  // ============================================================
  socket.on("update_location", async (data = {}, ack) => {
    try {
      const { userId, lat, lng, timestamp } = data;
      if (!userId || typeof lat !== "number" || typeof lng !== "number") {
        return ack?.({ success: false, message: "Datos inválidos" });
      }
      const entry = state.connectedUsers.get(userId);
      if (entry) {
        const loc = { lat, lng, ts: typeof timestamp === "number" ? timestamp : Date.now() };
        entry.userData.lastKnownLocation = loc;
        
        await db.collection(COLLECTIONS.USERS).doc(userId).update({
          lastKnownLocation: loc,
          lastLocationUpdatedAt: Date.now(),
        });
        
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
  // 📍 ACTUALIZAR UBICACIÓN DE VÍCTIMA EN EMERGENCIA
  // ============================================================
  socket.on("update_emergency_location", async (data = {}, ack) => {
    try {
      const { 
        roomId,        // ID de la sala de emergencia
        userId,        // ID de la víctima
        lat,           // Latitud
        lng,           // Longitud
        timestamp,     // Timestamp
        accuracy       // Precisión (opcional)
      } = data;

      if (!roomId || !userId || typeof lat !== "number" || typeof lng !== "number") {
        return ack?.({ success: false, message: "Datos de ubicación inválidos" });
      }

      // Solo permitir que la víctima actualice su ubicación
      const expectedVictimId = roomId.replace("emergencia_", "");
      if (userId !== expectedVictimId) {
        return ack?.({ success: false, message: "Solo la víctima puede actualizar ubicación de emergencia" });
      }

      console.log(`${colors.red}🚨 update_emergency_location:${colors.reset}`, {
        userId,
        lat,
        lng,
        roomId
      });

      // ACTUALIZAR ÚLTIMA UBICACIÓN CONOCIDA EN MEMORIA
      const entry = state.connectedUsers.get(userId);
      if (entry) {
        entry.userData.lastKnownLocation = { 
          lat, 
          lng, 
          ts: timestamp || Date.now(),
          roomId,
          type: "victim"
        };
      }

      // ACTUALIZAR EN EL ESTADO DE EMERGENCIA
      const emergencyData = state.emergencyAlerts.get(userId);
      if (emergencyData) {
        emergencyData.latitude = lat;
        emergencyData.longitude = lng;
        emergencyData.lastLocationUpdate = timestamp || Date.now();
        state.emergencyAlerts.set(userId, emergencyData);
      }

      // REENVIAR A TODOS EN LA SALA (ayudantes)
      socket.to(roomId).emit("emergency_location_updated", {
        roomId,
        userId,
        lat,
        lng,
        timestamp: timestamp || Date.now(),
        type: "victim",
        accuracy: accuracy || null
      });

      // GUARDAR EN FIRESTORE PARA HISTÓRICO
      try {
        await db.collection(COLLECTIONS.EMERGENCIES)
          .doc(userId)
          .collection("locations")
          .add({
            userId,
            lat,
            lng,
            timestamp: timestamp || Date.now(),
            type: "victim",
            roomId,
            accuracy: accuracy || null
          });

        // Actualizar ubicación actual en el documento principal
        await db.collection(COLLECTIONS.EMERGENCIES).doc(userId).update({
          latitude: lat,
          longitude: lng,
          lastLocationUpdate: timestamp || Date.now()
        });
      } catch (dbError) {
        console.warn(`${colors.yellow}⚠️ No se pudo guardar ubicación en Firestore:${colors.reset}`, dbError.message);
      }

      ack?.({ success: true });

    } catch (error) {
      console.error(`${colors.red}❌ Error en update_emergency_location:${colors.reset}`, error);
      ack?.({ success: false, message: error.message });
    }
  });

  // ============================================================
  // 🚗 ACTUALIZAR UBICACIÓN DE AYUDANTE EN EMERGENCIA
  // ============================================================
  socket.on("update_helper_location", async (data = {}, ack) => {
    try {
      const { 
        roomId,           // ID de la sala de emergencia
        helperId,         // ID del ayudante
        emergencyUserId,  // ID de la víctima (opcional, se puede derivar de roomId)
        lat,              // Latitud
        lng,              // Longitud
        timestamp,        // Timestamp
        accuracy          // Precisión (opcional)
      } = data;

      if (!roomId || !helperId || typeof lat !== "number" || typeof lng !== "number") {
        return ack?.({ success: false, message: "Datos de ubicación inválidos" });
      }

      // Verificar que es una sala de emergencia
      if (!roomId.startsWith("emergencia_")) {
        return ack?.({ success: false, message: "Solo para salas de emergencia" });
      }

      const victimId = emergencyUserId || roomId.replace("emergencia_", "");

      console.log(`${colors.blue}🚗 update_helper_location:${colors.reset}`, {
        helperId,
        victimId,
        lat,
        lng,
        roomId
      });

      // ACTUALIZAR ÚLTIMA UBICACIÓN CONOCIDA EN MEMORIA
      const entry = state.connectedUsers.get(helperId);
      if (entry) {
        entry.userData.lastKnownLocation = { 
          lat, 
          lng, 
          ts: timestamp || Date.now(),
          roomId,
          type: "helper",
          helpingVictimId: victimId
        };
      }

      // AÑADIR AL SET DE AYUDANTES SI NO ESTÁ
      const helpers = state.emergencyHelpers.get(victimId);
      if (helpers && !helpers.has(helperId)) {
        helpers.add(helperId);
        state.emergencyHelpers.set(victimId, helpers);
      }

      // REENVIAR A TODOS EN LA SALA (víctima y otros ayudantes)
      socket.to(roomId).emit("helper_location_updated", {
        roomId,
        helperId,
        victimId,
        lat,
        lng,
        timestamp: timestamp || Date.now(),
        type: "helper",
        accuracy: accuracy || null
      });

      // TAMBIÉN ENVIAR ESPECÍFICAMENTE A LA VÍCTIMA (por si acaso)
      io.to(victimId).emit("helper_location_updated", {
        roomId,
        helperId,
        victimId,
        lat,
        lng,
        timestamp: timestamp || Date.now(),
        type: "helper",
        accuracy: accuracy || null
      });

      // GUARDAR EN FIRESTORE PARA HISTÓRICO
      try {
        await db.collection(COLLECTIONS.EMERGENCIES)
          .doc(victimId)
          .collection("helper_locations")
          .add({
            helperId,
            lat,
            lng,
            timestamp: timestamp || Date.now(),
            roomId,
            accuracy: accuracy || null
          });

        // Actualizar ubicación del ayudante en el mapa de ayudantes
        const helperRef = db.collection(COLLECTIONS.EMERGENCIES)
          .doc(victimId)
          .collection("active_helpers")
          .doc(helperId);
        
        await helperRef.set({
          helperId,
          lastLocation: { lat, lng },
          lastLocationUpdate: timestamp || Date.now(),
          isActive: true
        }, { merge: true });

      } catch (dbError) {
        console.warn(`${colors.yellow}⚠️ No se pudo guardar ubicación de ayudante:${colors.reset}`, dbError.message);
      }

      ack?.({ success: true });

    } catch (error) {
      console.error(`${colors.red}❌ Error en update_helper_location:${colors.reset}`, error);
      ack?.({ success: false, message: error.message });
    }
  });

  // ============================================================
  // 🎯 SOLICITAR UBICACIÓN ACTUAL DE LA VÍCTIMA
  // ============================================================
  socket.on("request_victim_location", async (data = {}, ack) => {
    try {
      const { roomId, helperId, emergencyUserId } = data;

      if (!roomId || !helperId || !emergencyUserId) {
        return ack?.({ success: false, message: "Datos incompletos" });
      }

      console.log(`${colors.yellow}🎯 request_victim_location:${colors.reset}`, {
        helperId,
        emergencyUserId,
        roomId
      });

      // BUSCAR LA ÚLTIMA UBICACIÓN DE LA VÍCTIMA EN MEMORIA
      const victimEntry = state.connectedUsers.get(emergencyUserId);
      const emergencyData = state.emergencyAlerts.get(emergencyUserId);
      
      if (victimEntry?.userData?.lastKnownLocation) {
        const location = victimEntry.userData.lastKnownLocation;
        
        // ENVIAR SOLO AL AYUDANTE QUE SOLICITÓ
        io.to(helperId).emit("victim_location_response", {
          userId: emergencyUserId,
          lat: location.lat,
          lng: location.lng,
          timestamp: location.ts || Date.now(),
          roomId,
          type: "victim"
        });
        
        console.log(`${colors.green}✅ Ubicación de víctima desde memoria enviada a helper ${helperId}${colors.reset}`);
      } 
      else if (emergencyData?.latitude && emergencyData?.longitude) {
        // Usar datos de la emergencia como respaldo
        io.to(helperId).emit("victim_location_response", {
          userId: emergencyUserId,
          lat: emergencyData.latitude,
          lng: emergencyData.longitude,
          timestamp: emergencyData.lastLocationUpdate || emergencyData.timestamp || Date.now(),
          roomId,
          type: "victim",
          fromEmergencyData: true
        });
        
        console.log(`${colors.green}✅ Ubicación de víctima desde emergencyData${colors.reset}`);
      }
      else {
        // BUSCAR EN FIRESTORE COMO ÚLTIMO RECURSO
        try {
          const locationsSnapshot = await db.collection(COLLECTIONS.EMERGENCIES)
            .doc(emergencyUserId)
            .collection("locations")
            .orderBy("timestamp", "desc")
            .limit(1)
            .get();
          
          if (!locationsSnapshot.empty) {
            const lastLoc = locationsSnapshot.docs[0].data();
            
            io.to(helperId).emit("victim_location_response", {
              userId: emergencyUserId,
              lat: lastLoc.lat,
              lng: lastLoc.lng,
              timestamp: lastLoc.timestamp,
              roomId,
              type: "victim",
              fromFirestore: true
            });
            
            console.log(`${colors.green}✅ Ubicación de víctima desde Firestore${colors.reset}`);
          } else {
            console.log(`${colors.yellow}⚠️ No hay ubicación guardada para la víctima${colors.reset}`);
            io.to(helperId).emit("victim_location_response", {
              userId: emergencyUserId,
              error: "No hay ubicación disponible",
              timestamp: Date.now()
            });
          }
        } catch (dbError) {
          console.warn(`${colors.yellow}⚠️ Error buscando ubicación en Firestore:${colors.reset}`, dbError.message);
        }
      }

      ack?.({ success: true });

    } catch (error) {
      console.error(`${colors.red}❌ Error en request_victim_location:${colors.reset}`, error);
      ack?.({ success: false, message: error.message });
    }
  });

  // ============================================================
  // 👥 SOLICITAR UBICACIONES DE TODOS LOS AYUDANTES
  // ============================================================
  socket.on("helpers_location_request", async (data = {}, ack) => {
    try {
      const { roomId, emergencyUserId } = data;

      if (!roomId || !emergencyUserId) {
        return ack?.({ success: false, message: "Datos incompletos" });
      }

      console.log(`${colors.blue}👥 helpers_location_request:${colors.reset} para ${roomId}`);

      const helpers = state.emergencyHelpers.get(emergencyUserId) || new Set();
      const helpersLocations = [];

      // RECOPILAR UBICACIONES DE TODOS LOS AYUDANTES
      for (const helperId of helpers) {
        const helperEntry = state.connectedUsers.get(helperId);
        if (helperEntry?.userData?.lastKnownLocation) {
          const loc = helperEntry.userData.lastKnownLocation;
          helpersLocations.push({
            userId: helperId,
            userName: helperEntry.userData.username || "Ayudante",
            lat: loc.lat,
            lng: loc.lng,
            timestamp: loc.ts || Date.now(),
            type: "helper"
          });
        } else {
          // Intentar obtener de Firestore
          try {
            const helperLocSnapshot = await db.collection(COLLECTIONS.EMERGENCIES)
              .doc(emergencyUserId)
              .collection("helper_locations")
              .where("helperId", "==", helperId)
              .orderBy("timestamp", "desc")
              .limit(1)
              .get();
            
            if (!helperLocSnapshot.empty) {
              const loc = helperLocSnapshot.docs[0].data();
              helpersLocations.push({
                userId: helperId,
                userName: "Ayudante",
                lat: loc.lat,
                lng: loc.lng,
                timestamp: loc.timestamp,
                type: "helper",
                fromFirestore: true
              });
            }
          } catch (dbError) {
            console.warn(`${colors.yellow}⚠️ Error buscando ubicación de ayudante ${helperId}:${colors.reset}`, dbError.message);
          }
        }
      }

      // ENVIAR A LA VÍCTIMA
      io.to(emergencyUserId).emit("helpers_locations_update", {
        roomId,
        helpers: helpersLocations,
        timestamp: Date.now()
      });

      // TAMBIÉN ENVIAR AL SOLICITANTE
      io.to(socket.id).emit("helpers_locations_update", {
        roomId,
        helpers: helpersLocations,
        timestamp: Date.now()
      });

      ack?.({ 
        success: true, 
        count: helpersLocations.length 
      });

    } catch (error) {
      console.error(`${colors.red}❌ Error en helpers_location_request:${colors.reset}`, error);
      ack?.({ success: false, message: error.message });
    }
  });

  // ============================================================
  // 🚗 ACTUALIZAR ESTADO DE CONDUCCIÓN DEL AYUDANTE
  // ============================================================
  socket.on("helper_driving_status", (data = {}) => {
    try {
      const { roomId, helperId, isDriving, emergencyUserId } = data;
      
      if (!roomId || !helperId) return;
      
      console.log(`${colors.blue}🚗 helper_driving_status:${colors.reset}`, {
        helperId,
        isDriving: isDriving ? "CONDUCIENDO" : "DETENIDO"
      });
      
      // NOTIFICAR A LA VÍCTIMA
      if (emergencyUserId) {
        io.to(emergencyUserId).emit("helper_driving_update", {
          helperId,
          isDriving,
          timestamp: Date.now()
        });
      }
      
      // NOTIFICAR A TODA LA SALA
      socket.to(roomId).emit("helper_driving_update", {
        helperId,
        isDriving,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error(`${colors.red}❌ Error en helper_driving_status:${colors.reset}`, error);
    }
  });

  // ============================================================
  // 🚪 MANEJO DE SALAS
  // ============================================================
  // ============================================================
// 🚪 MANEJO DE SALAS (CORREGIDO: fallback userId + Firestore upsert)
// ============================================================

socket.on("join_room", async (data = {}, ack) => {
  try {
    const { roomId } = data;
    const userId = data.userId || socket.userId; // ✅ fallback seguro

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

    // Si estaba en otra sala, salir prolijo
    if (socket.currentRoom && socket.currentRoom !== roomId) {
      const previousRoomId = socket.currentRoom;
      const previousRoom = state.chatRooms.get(previousRoomId);

      if (previousRoom) {
        previousRoom.users.delete(userId);
      }

      socket.leave(previousRoomId);

      socket.to(previousRoomId).emit("user_left_room", {
        userId,
        username: socket.username,
        roomId: previousRoomId,
        message: `${socket.username} salió de la sala`,
        timestamp: Date.now(),
      });

      utils.updateRoomUserList(previousRoomId);
    }

    // Entrar a la nueva sala
    socket.join(roomId);
    socket.currentRoom = roomId;
    targetRoom.users.add(userId);

    const entry = state.connectedUsers.get(userId);
    if (entry) {
      entry.userData.currentRoom = roomId;
    }

    // ✅ FIX: NO usar update() (revienta si el doc no existe)
    await db.collection(COLLECTIONS.USERS).doc(userId).set(
      {
        currentRoom: roomId,
        lastActive: Date.now(),
        uid: userId,
        username: socket.username || null,
      },
      { merge: true }
    );

    // Enviar historial (si existe)
    try {
      const messagesSnapshot = await db
        .collection(COLLECTIONS.MESSAGES)
        .where("roomId", "==", roomId)
        .orderBy("timestamp", "desc")
        .limit(50)
        .get();

      const messages = messagesSnapshot.docs
        .map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }))
        .reverse();

      socket.emit("room_messages", {
        roomId,
        messages,
      });
    } catch (dbError) {
      console.warn(
        `${colors.yellow}⚠️ No se pudo cargar historial de mensajes:${colors.reset}`,
        dbError.message
      );
    }

    socket.to(roomId).emit("user_joined_room", {
      userId,
      username: socket.username,
      roomId,
      message: `${socket.username} se unió a la sala`,
      timestamp: Date.now(),
    });

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
    const { roomId } = data;
    const userId = data.userId || socket.userId; // ✅ fallback

    if (!roomId) {
      return ack?.({ success: false, message: "❌ Sala no especificada" });
    }

    console.log(
      `${colors.blue}🚪 Evento → leave_room:${colors.reset} ${socket.username} → ${roomId}`
    );

    const room = state.chatRooms.get(roomId);
    if (!room) {
      return ack?.({ success: false, message: "Sala no encontrada" });
    }

    socket.leave(roomId);
    room.users.delete(userId);

    if (socket.currentRoom === roomId) socket.currentRoom = null;

    const entry = state.connectedUsers.get(userId);
    if (entry) entry.userData.currentRoom = null;

    // ✅ FIX: set merge (no explota si doc no existe)
    await db.collection(COLLECTIONS.USERS).doc(userId).set(
      {
        currentRoom: null,
        lastActive: Date.now(),
        uid: userId,
        username: socket.username || null,
      },
      { merge: true }
    );

    socket.to(roomId).emit("user_left_room", {
      userId,
      username: socket.username,
      roomId,
      message: `${socket.username} salió de la sala`,
      timestamp: Date.now(),
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
  // 💬 MENSAJES DE TEXTO (CORREGIDO)
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
      await db.collection(COLLECTIONS.MESSAGES).add(message);
      
      const room = state.chatRooms.get(roomId);
      if (room) {
        room.messageCount++;
      }
      
      io.to(roomId).emit("new_message", message);
      socket.emit("message_sent", message);
      
      let usersToNotify = [];
      
      if (roomId === "general") {
        const offlineUsersSnap = await db.collection(COLLECTIONS.USERS)
          .where("isOnline", "==", false)
          .get();
        
        usersToNotify = offlineUsersSnap.docs.map(doc => doc.id);
      } else {
        usersToNotify = room ? Array.from(room.users) : [];
      }
      
      for (const targetUserId of usersToNotify) {
        if (targetUserId === userId) continue;
        
        const isPresent = utils.isUserPresentInRoom(targetUserId, roomId);
        
        if (!isPresent) {
          await sendPushNotification(
            targetUserId,
            "💬 Nuevo mensaje",
            `${username}: ${text}`,
            {
              type: "chat_message",
              roomId: roomId,
              userId: userId,
              username: username,
              text: text,
              timestamp: Date.now().toString(),
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
  // 🎧 MENSAJES DE AUDIO (CORREGIDO)
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

      io.to(roomId).emit("audio_message", message);
      socket.emit("message_sent", { id: message.id, ...message });

      const roomUsers = room ? Array.from(room.users) : [];
      
      for (const targetUserId of roomUsers) {
        if (targetUserId === userId) continue;
        
        const isPresent = utils.isUserPresentInRoom(targetUserId, roomId);
        
        if (!isPresent) {
          await sendPushNotification(
            targetUserId,
            "🎧 Mensaje de audio",
            `${username} envió un audio`,
            {
              type: "audio_message",
              roomId: roomId,
              userId: userId,
              username: username,
              timestamp: Date.now().toString(),
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

      await db.collection(COLLECTIONS.USERS).doc(userId).update(updatedUser);

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
  // 🚨 SISTEMA DE EMERGENCIA (CORREGIDO - USA LOCK_REF)
  // ============================================================
  socket.on("emergency_alert", async (data = {}, ack) => {
    let lockAcquired = false;
    let reqUserId = null;
    let reqUserName = null;
    let emergencyRoomId = null;

    try {
      const {
        userId,
        userName,
        latitude,
        longitude,
        timestamp,
        emergencyType = "general",
      } = data;

      reqUserId = userId || null;
      reqUserName = userName || null;

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

      emergencyRoomId = `emergencia_${userId}`;

      // 🔒 LOCK GLOBAL CON DETECCIÓN DE STALE LOCK - USA LOCK_REF
      const lockResult = await db.runTransaction(async (tx) => {
        const snap = await tx.get(LOCK_REF);
        const lock = snap.exists ? (snap.data() || {}) : null;

        if (lock?.active === true) {
          const startedAt = typeof lock.startedAt === "number" ? lock.startedAt : 0;
          const age = Date.now() - startedAt;

          if (startedAt > 0 && age > LOCK_TTL_MS) {
            tx.set(LOCK_REF, {
              active: true,
              userId,
              roomId: emergencyRoomId,
              startedAt: Date.now(),
              emergencyType,
              replacedStaleLock: true,
              previousLock: {
                userId: lock.userId || null,
                roomId: lock.roomId || null,
                startedAt: lock.startedAt || null
              }
            }, { merge: true });

            return { allowed: true, staleReplaced: true };
          }

          return {
            allowed: false,
            activeEmergency: {
              userId: lock.userId || null,
              roomId: lock.roomId || null,
              startedAt: lock.startedAt || null,
            }
          };
        }

        tx.set(LOCK_REF, {
          active: true,
          userId,
          roomId: emergencyRoomId,
          startedAt: Date.now(),
          emergencyType,
        }, { merge: true });

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

      lockAcquired = true;

      try {
        socket.join(emergencyRoomId);
        socket.currentRoom = emergencyRoomId;
      } catch (joinErr) {
        console.warn(`${colors.yellow}⚠️ No se pudo unir socket a ${emergencyRoomId}:${colors.reset}`, joinErr.message);
      }

      let avatarUrl = null;
      try {
        const userDoc = await db.collection(COLLECTIONS.USERS).doc(userId).get();
        if (userDoc.exists) {
          const userData = userDoc.data() || {};
          avatarUrl = userData.avatarUrl || userData.avatarUri || null;
        }
      } catch (e) {
        console.warn(`${colors.yellow}⚠️ Error obteniendo avatar:${colors.reset} ${e.message}`);
      }

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
        timestamp: (typeof timestamp === "number" ? timestamp : Date.now()),
        socketId: socket.id,
        emergencyType,
        status: "active",
        emergencyRoomId,
        roomId: emergencyRoomId,
        vehicleInfo: vehicleData,
      };

      state.emergencyAlerts.set(userId, emergencyData);
      if (!state.emergencyHelpers.has(userId)) {
        state.emergencyHelpers.set(userId, new Set());
      }

      try {
        await db
          .collection(COLLECTIONS.EMERGENCIES)
          .doc(userId)
          .set(
            {
              ...emergencyData,
              isActive: true,
              createdAt: Date.now(),
            },
            { merge: true }
          );

        await db.collection(COLLECTIONS.USERS).doc(userId).update({
          hasActiveEmergency: true,
          emergencyRoomId,
          lastEmergencyStarted: Date.now(),
        });

      } catch (fireErr) {
        console.error(`${colors.red}❌ Error guardando emergencia:${colors.reset}`, fireErr.message);
      }

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

      let socketNotifications = 0;
      const notifiedUsers = new Set();

      for (const [sid, s] of io.sockets.sockets) {
        if (sid === socket.id) continue;
        if (s?.userId && s.userId === userId) continue;

        io.to(sid).emit("emergency_alert", {
          ...emergencyData,
          emergencyRoomId,
        });
        socketNotifications++;

        if (s?.userId) notifiedUsers.add(s.userId);
      }

      const usersSnapshot = await db.collection(COLLECTIONS.USERS).get();
      let pushNotifications = 0;

      for (const doc of usersSnapshot.docs) {
        const targetUserId = doc.id;

        if (targetUserId === userId) continue;
        if (notifiedUsers.has(targetUserId)) continue;

        const ok = await sendEmergencyNotification(
          targetUserId,
          "🚨 EMERGENCIA",
          `${userName} necesita ayuda`,
          {
            type: "emergency",
            emergencyUserId: userId,
            emergencyUserName: userName,
            emergencyType,
            open_emergency_screen: "true",
            is_helper: "true",
            emergency_user_id: userId,
            emergency_user_name: userName,
            emergency_type: emergencyType,
            emergency_room_id: emergencyRoomId,
            latitude: latitude.toString(),
            longitude: longitude.toString(),
            emergency_latitude: latitude.toString(),
            emergency_longitude: longitude.toString(),
            avatarUrl: avatarUrl || "",
            emergency_avatar_url: avatarUrl || "",
            vehicleMarca: vehicleData?.brand || "",
            vehicleModelo: vehicleData?.model || "",
            vehiclePatente: vehicleData?.licensePlate || "",
            vehicleColor: vehicleData?.color || "",
            vehicleFoto: vehicleData?.photoUri || "",
            vehicle_marca: vehicleData?.brand || "",
            vehicle_modelo: vehicleData?.model || "",
            vehicle_patente: vehicleData?.licensePlate || "",
            vehicle_color: vehicleData?.color || "",
            vehicle_foto: vehicleData?.photoUri || "",
            timestamp: Date.now().toString(),
            emergencyRoomId,
          }
        );

        if (ok) pushNotifications++;
      }

      console.log(`${colors.red}📢 ALERTA DIFUNDIDA:${colors.reset} ${userName}`);
      console.log(`${colors.blue}   → Sockets: ${socketNotifications} usuarios conectados${colors.reset}`);
      console.log(`${colors.magenta}   → Push: ${pushNotifications} usuarios no conectados${colors.reset}`);

      return ack?.({
        success: true,
        message: "Alerta de emergencia enviada correctamente",
        vehicle: vehicleData,
        avatarUrl: avatarUrl,
        socketNotifications: socketNotifications,
        pushNotifications: pushNotifications,
        emergencyRoomId,
        staleReplaced: !!lockResult.staleReplaced,
      });

    } catch (error) {
      console.error(`${colors.red}❌ Error en emergency_alert:${colors.reset}`, error);

      if (lockAcquired) {
        console.log(`${colors.yellow}⚠️ Error después de adquirir lock, liberando...${colors.reset}`);
        try {
          await releaseEmergencyLock({
            userId: reqUserId,
            roomId: emergencyRoomId || (reqUserId ? `emergencia_${reqUserId}` : null),
            reason: "error_during_emergency",
          });
        } catch (e) {
          console.warn(`${colors.yellow}⚠️ Falló releaseEmergencyLock en rollback:${colors.reset}`, e.message);
        }
      }

      return ack?.({
        success: false,
        code: "SERVER_ERROR",
        message: "Error procesando alerta de emergencia",
      });
    }
  });

  // ============================================================
  // ✅ EVENTO DE CONFIRMACIÓN DE AYUDA
  // ============================================================
  socket.on("help_confirm", async (data = {}, ack) => {
    try {
      const { emergencyUserId, helperId, helperName, latitude, longitude, timestamp } = data;

      console.log(`${colors.green}✅ Evento → help_confirm:${colors.reset}`, {
        emergencyUserId,
        helperId,
        helperName
      });

      if (!emergencyUserId || !helperId) {
        return ack?.({ success: false, message: "Datos incompletos" });
      }

      // Añadir helper al set de ayudantes
      const helpers = state.emergencyHelpers.get(emergencyUserId);
      if (helpers) {
        helpers.add(helperId);
        state.emergencyHelpers.set(emergencyUserId, helpers);
      }

      // Notificar a la víctima
      io.to(emergencyUserId).emit("help_confirmed", {
        emergencyUserId,
        helperId,
        helperName: helperName || "Ayudante",
        latitude,
        longitude,
        timestamp: timestamp || Date.now()
      });

      // Notificar al helper que su confirmación fue recibida
      io.to(helperId).emit("help_confirmed_notification", {
        emergencyUserId,
        helperId,
        helperName,
        timestamp: Date.now()
      });

      ack?.({ success: true });

    } catch (error) {
      console.error(`${colors.red}❌ Error en help_confirm:${colors.reset}`, error);
      ack?.({ success: false, message: error.message });
    }
  });

  // ============================================================
  // ❌ EVENTO DE RECHAZO DE AYUDA
  // ============================================================
  socket.on("help_reject", async (data = {}, ack) => {
    try {
      const { emergencyUserId, helperId } = data;

      console.log(`${colors.red}❌ Evento → help_reject:${colors.reset}`, {
        emergencyUserId,
        helperId
      });

      if (!emergencyUserId || !helperId) {
        return ack?.({ success: false, message: "Datos incompletos" });
      }

      // Eliminar helper del set de ayudantes
      const helpers = state.emergencyHelpers.get(emergencyUserId);
      if (helpers) {
        helpers.delete(helperId);
        state.emergencyHelpers.set(emergencyUserId, helpers);
      }

      // Notificar al helper que fue rechazado
      io.to(helperId).emit("help_rejected", {
        emergencyUserId,
        helperId,
        timestamp: Date.now()
      });

      ack?.({ success: true });

    } catch (error) {
      console.error(`${colors.red}❌ Error en help_reject:${colors.reset}`, error);
      ack?.({ success: false, message: error.message });
    }
  });

  // ============================================================
  // ✅ EVENTO DE RESOLUCIÓN DE EMERGENCIA (CORREGIDO)
  // ============================================================
  socket.on("emergency_resolve", async (data = {}, ack) => {
    try {
      const { userId, reason = "resolved_by_user" } = data;

      console.log(`${colors.green}✅ Evento → emergency_resolve:${colors.reset}`, { userId, reason });

      if (!userId) {
        return ack?.({ success: false, message: "userId requerido" });
      }

      const emergencyRoomId = state.emergencyUserRoom.get(userId) || `emergencia_${userId}`;
      const emergencyData = state.emergencyAlerts.get(userId);
      const username = emergencyData?.userName || socket.username || "Usuario";

      await releaseEmergencyLock({
        userId,
        roomId: emergencyRoomId,
        reason,
      });

      io.emit("emergency_cancelled", {
        userId,
        userName: username,
        username: username,
        roomId: emergencyRoomId,
        reason,
        timestamp: Date.now(),
        isActive: false,
      });

      io.to(emergencyRoomId).emit("emergency_resolved", {
        roomId: emergencyRoomId,
        userId,
        message: "Emergencia resuelta",
        reason,
        timestamp: Date.now(),
      });

      try {
        await deleteEmergencyChatHistory(emergencyRoomId);
        console.log(`${colors.green}🗑️ Historial eliminado: ${emergencyRoomId}${colors.reset}`);
      } catch (deleteError) {
        console.warn(
          `${colors.yellow}⚠️ No se pudo eliminar el historial:${colors.reset}`,
          deleteError.message
        );
      }

      const room = state.chatRooms.get(emergencyRoomId);
      if (room) {
        room.users.forEach((roomUserId) => {
          const entry = state.connectedUsers.get(roomUserId);
          if (entry) {
            entry.sockets.forEach((socketId) => {
              const s = io.sockets.sockets.get(socketId);
              s?.leave(emergencyRoomId);
              if (s && s.currentRoom === emergencyRoomId) s.currentRoom = null;
            });

            if (entry.userData?.currentRoom === emergencyRoomId) {
              entry.userData.currentRoom = null;
            }
          }
        });
      }

      state.chatRooms.delete(emergencyRoomId);
      state.emergencyUserRoom.delete(userId);
      state.emergencyAlerts.delete(userId);
      state.emergencyHelpers.delete(userId);

      await db.collection(COLLECTIONS.EMERGENCIES).doc(userId).update({
        status: "resolved",
        isActive: false,
        resolvedAt: Date.now(),
        endedAt: Date.now(),
        roomId: emergencyRoomId,
        endReason: reason,
      });

      await db.collection(COLLECTIONS.USERS).doc(userId).update({
        hasActiveEmergency: false,
        emergencyRoomId: null,
        lastEmergencyEnded: Date.now(),
      });

      console.log(`${colors.green}✅ Emergencia resuelta para usuario: ${userId}${colors.reset}`);

      return ack?.({
        success: true,
        message: "Emergencia resuelta correctamente",
        emergencyRoomId,
        chatHistoryDeleted: true,
      });
    } catch (error) {
      console.error(`${colors.red}❌ Error en emergency_resolve:${colors.reset}`, error);
      return ack?.({ success: false, message: error.message });
    }
  });

  // ============================================================
  // 🔴 DESCONEXIÓN
  // ============================================================
  socket.on("disconnect", async (reason) => {
    const userId = socket.userId;
    const username = socket.username;
    const currentRoom = socket.currentRoom;
    
    console.log(`${colors.red}🔌 Socket desconectado:${colors.reset} ${username || socket.id} (${reason})`);

    let entry = userId ? state.connectedUsers.get(userId) : null;
    let isLastConnection = true;
    
    if (entry) {
      entry.sockets.delete(socket.id);
      isLastConnection = entry.sockets.size === 0;
    }

    const hasActiveEmergency = state.emergencyAlerts.has(userId);
    const emergencyRoomId = state.emergencyUserRoom.get(userId);
    
    if (userId) {
      try {
        await db.collection(COLLECTIONS.USERS).doc(userId).update({
          socketIds: admin.firestore.FieldValue.arrayRemove(socket.id),
          lastSeen: Date.now(),
          ...(isLastConnection && { 
            isOnline: false,
            currentRoom: "general"
          })
        });
      } catch (error) {
        console.warn(`${colors.yellow}⚠️ Error actualizando Firestore en desconexión:${colors.reset}`, error.message);
      }
      
      if (isLastConnection && entry) {
        entry.userData.isOnline = false;
        entry.userData.currentRoom = "general";
        state.connectedUsers.delete(userId);
        
        if (hasActiveEmergency) {
          console.log(`${colors.red}🚨 USUARIO CON EMERGENCIA ACTIVA SE DESCONECTÓ: ${username}${colors.reset}`);
          await cleanupUserEmergency(userId, username, emergencyRoomId);
        }
        
        io.emit('user_status_changed', {
          userId,
          username,
          isOnline: false,
          currentRoom: "general",
          emergencyCleared: hasActiveEmergency,
          timestamp: Date.now()
        });
        
        console.log(`${colors.red}🔴 Usuario ${username} completamente desconectado. ${hasActiveEmergency ? '(Emergencia limpiada)' : ''}${colors.reset}`);
      } else if (entry) {
        console.log(`${colors.yellow}⚠️ Usuario ${username} tiene ${entry.sockets.size} conexiones restantes${colors.reset}`);
        
        socket.leave(currentRoom);
        socket.currentRoom = "general";
        
        if (currentRoom && currentRoom !== "general") {
          socket.to(currentRoom).emit("user_left_room", {
            userId: userId,
            username: username,
            roomId: currentRoom,
            message: `${username} se desconectó`,
            timestamp: Date.now(),
            socketId: socket.id,
            hadEmergency: hasActiveEmergency
          });
        }
      } else if (hasActiveEmergency) {
        console.log(`${colors.red}🚨 USUARIO NO ENCONTRADO PERO CON EMERGENCIA ACTIVA: ${userId}${colors.reset}`);
        await cleanupUserEmergency(userId, username, emergencyRoomId);
        
        try {
          await db.collection(COLLECTIONS.USERS).doc(userId).update({
            socketIds: admin.firestore.FieldValue.arrayRemove(socket.id),
            lastSeen: Date.now(),
            isOnline: false,
            currentRoom: "general",
            hasActiveEmergency: false,
            emergencyRoomId: null
          });
        } catch (error) {
          console.warn(`${colors.yellow}⚠️ Error actualizando Firestore para usuario no encontrado:${colors.reset}`, error.message);
        }
      }

      if (currentRoom && currentRoom !== "general") {
        socket.to(currentRoom).emit("user_left_room", {
          userId: userId,
          username: username,
          roomId: currentRoom,
          message: `${username} se desconectó`,
          timestamp: Date.now(),
          socketId: socket.id,
          hadEmergency: hasActiveEmergency,
          movedToGeneral: true
        });

        utils.updateRoomUserList(currentRoom);
        socket.leave(currentRoom);
        
        if (hasActiveEmergency && currentRoom === emergencyRoomId) {
          console.log(`${colors.yellow}⚠️ Usuario abandonó sala de emergencia por desconexión${colors.reset}`);
          
          io.to(emergencyRoomId).emit("emergency_user_disconnected", {
            userId,
            username,
            roomId: emergencyRoomId,
            message: `${username} se desconectó de la sala de emergencia`,
            timestamp: Date.now(),
            helpersInRoom: Array.from(state.emergencyHelpers.get(userId) || [])
          });
        }
      }
      
      if (!isLastConnection && entry) {
        socket.join("general");
        socket.currentRoom = "general";
        
        socket.to("general").emit("user_joined_room", {
          userId: userId,
          username: username,
          roomId: "general",
          message: `${username} se reconectó en general`,
          timestamp: Date.now(),
          isReconnection: true
        });
      }
    }

    if (socket.rooms) {
      const rooms = Array.from(socket.rooms);
      const emergencyRooms = rooms.filter(room => room.startsWith('emergencia_'));
      
      for (const emergencyRoom of emergencyRooms) {
        socket.leave(emergencyRoom);
        console.log(`${colors.yellow}⚠️ Socket ${socket.id} removido de sala de emergencia: ${emergencyRoom}${colors.reset}`);
      }
    }

    const connectedUsersList = Array.from(state.connectedUsers.values()).map((u) => ({
      ...u.userData,
      socketCount: u.sockets.size,
      currentRoom: u.userData.currentRoom || "general"
    }));
    
    io.emit("connected_users", connectedUsersList);
    utils.updateRoomUserList("general");
  });
});

// ============================================================
// 🚀 INICIALIZACIÓN Y INICIO DEL SERVIDOR
// ============================================================
initializeDefaultRooms();

const PORT = process.env.PORT || 8080;

process.on('uncaughtException', (error) => {
  console.error(`${colors.red}🔥 ERROR NO CAPTURADO:${colors.reset}`, error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`${colors.red}🔥 PROMESA RECHAZADA NO MANEJADA:${colors.reset}`, reason);
});

// Programa una limpieza automática de tokens cada 24 horas (opcional)
// setInterval(cleanupInvalidTokens, 24 * 60 * 60 * 1000);

setInterval(() => {
  const memoryUsage = process.memoryUsage();
  console.log(`${colors.gray}🧠 Uso de memoria:${colors.reset}`, {
    rss: Math.round(memoryUsage.rss / 1024 / 1024) + 'MB',
    heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + 'MB',
    heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + 'MB',
  });
}, 300000);

server.listen(PORT, () => {
  console.log(`${colors.green}🚀 Servidor de chat corriendo en puerto ${PORT}${colors.reset}`);
  console.log(`${colors.cyan}🌐 http://localhost:${PORT}${colors.reset}`);
  console.log(`${colors.blue}💬 Sistema de salas activo${colors.reset}`);
  console.log(`${colors.red}🚨 Sistema de Emergencia activo${colors.reset}`);
  console.log(`${colors.yellow}🔒 Sistema de LOCK global (1 emergencia a la vez)${colors.reset}`);
  console.log(`${colors.magenta}🔥 Sistema de Tokens FCM mejorado${colors.reset}`);
  console.log(`${colors.green}📱 Nuevos endpoints FCM disponibles:${colors.reset}`);
  console.log(`${colors.cyan}   POST /fcm/cleanup-tokens - Para limpiar tokens inválidos${colors.reset}`);
  console.log(`${colors.cyan}   GET /fcm/user-tokens/:userId - Para debug de tokens${colors.reset}`);
  console.log(`${colors.cyan}   POST /fcm/refresh-token - Para refrescar tokens${colors.reset}`);
  console.log(`${colors.cyan}📍 NUEVOS EVENTOS DE UBICACIÓN:${colors.reset}`);
  console.log(`${colors.cyan}   - update_location - Ubicación general${colors.reset}`);
  console.log(`${colors.cyan}   - update_emergency_location - Víctima en emergencia${colors.reset}`);
  console.log(`${colors.cyan}   - update_helper_location - Ayudante en emergencia${colors.reset}`);
  console.log(`${colors.cyan}   - request_victim_location - Ayudantes solicitan ubicación de víctima${colors.reset}`);
  console.log(`${colors.cyan}   - helpers_location_request - Víctima solicita ubicaciones de ayudantes${colors.reset}`);
  console.log(`${colors.cyan}   - helper_driving_status - Estado de conducción de ayudantes${colors.reset}`);
  console.log(`${colors.green}🤝 NUEVOS EVENTOS DE AYUDA:${colors.reset}`);
  console.log(`${colors.cyan}   - help_confirm - Confirmar ayuda${colors.reset}`);
  console.log(`${colors.cyan}   - help_reject - Rechazar ayuda${colors.reset}`);
});