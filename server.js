// ============================================================
// 🌐 Servidor Node.js con Socket.IO, Firebase Firestore y Storage
// 💬 Chat General + Sistema de Emergencia + Soporte para Vehículos
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
  transports: ["websocket", "polling"],
  allowEIO3: true,
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
const VEHICULOS_COLLECTION = "vehiculos";
const EMERGENCIAS_COLLECTION = "emergencias";

// ============================================================
// 📦 Estado en memoria
// ============================================================
const connectedUsers = new Map();
const emergencyAlerts = new Map(); // userId -> emergencyData
const emergencyHelpers = new Map(); // emergencyUserId -> Set(helperUserIds)

// ============================================================
// 🔧 Helpers
// ============================================================
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

// ============================================================
// 🚨 ENDPOINTS PARA EMERGENCIAS
// ============================================================

// Obtener emergencias activas
app.get("/emergencias/activas", async (req, res) => {
  try {
    console.log(`${colors.cyan}🚨 GET /emergencias/activas${colors.reset}`);
    
    const emergenciasArray = Array.from(emergencyAlerts.entries()).map(([userId, alert]) => ({
      ...alert,
      helpersCount: emergencyHelpers.get(userId)?.size || 0
    }));
    
    res.json({ 
      success: true, 
      emergencias: emergenciasArray,
      total: emergenciasArray.length 
    });
  } catch (error) {
    console.error(`${colors.red}❌ Error obteniendo emergencias activas:${colors.reset}`, error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Obtener ayudantes de una emergencia
app.get("/emergencias/:userId/helpers", async (req, res) => {
  try {
    const { userId } = req.params;
    console.log(`${colors.cyan}👥 GET /emergencias/${userId}/helpers${colors.reset}`);

    const helpersSet = emergencyHelpers.get(userId) || new Set();
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

// Obtener vehículo de un usuario
app.get("/vehiculo/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    console.log(`${colors.cyan}🚗 GET /vehiculo/${userId}${colors.reset}`);

    const snapshot = await db.collection(VEHICULOS_COLLECTION)
      .where("userId", "==", userId)
      .limit(1)
      .get();

    if (snapshot.empty) {
      console.log(`${colors.yellow}⚠️ No se encontró vehículo para usuario: ${userId}${colors.reset}`);
      return res.status(404).json({ success: false, message: "Vehículo no encontrado" });
    }

    const vehiculoDoc = snapshot.docs[0];
    const vehiculo = { id: vehiculoDoc.id, ...vehiculoDoc.data() };
    
    console.log(`${colors.green}✅ Vehículo encontrado: ${vehiculo.patente}${colors.reset}`);
    res.json({ success: true, vehiculo });
  } catch (error) {
    console.error(`${colors.red}❌ Error obteniendo vehículo:${colors.reset}`, error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Guardar/actualizar vehículo
app.post("/vehiculo", async (req, res) => {
  try {
    const vehiculoData = req.body;
    console.log(`${colors.cyan}🚗 POST /vehiculo${colors.reset}`, {
      patente: vehiculoData.patente,
      marca: vehiculoData.marca,
      modelo: vehiculoData.modelo,
      userId: vehiculoData.userId
    });

    if (!vehiculoData.userId) {
      return res.status(400).json({ success: false, message: "userId es requerido" });
    }

    // Buscar si ya existe un vehículo para este usuario
    const snapshot = await db.collection(VEHICULOS_COLLECTION)
      .where("userId", "==", vehiculoData.userId)
      .limit(1)
      .get();

    let result;
    if (snapshot.empty) {
      // Crear nuevo vehículo
      result = await db.collection(VEHICULOS_COLLECTION).add({
        ...vehiculoData,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
      console.log(`${colors.green}✅ Nuevo vehículo creado: ${vehiculoData.patente}${colors.reset}`);
    } else {
      // Actualizar vehículo existente
      const existingDoc = snapshot.docs[0];
      result = await existingDoc.ref.update({
        ...vehiculoData,
        updatedAt: Date.now()
      });
      console.log(`${colors.green}✅ Vehículo actualizado: ${vehiculoData.patente}${colors.reset}`);
    }

    res.json({ 
      success: true, 
      message: "Vehículo guardado correctamente",
      vehiculo: vehiculoData
    });
  } catch (error) {
    console.error(`${colors.red}❌ Error guardando vehículo:${colors.reset}`, error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Subir foto de vehículo
app.post("/vehiculo/foto", async (req, res) => {
  try {
    const { userId, imageData, tipo } = req.body; // tipo: 'vehiculo' o 'casco'
    
    if (!userId || !imageData || !isDataUrl(imageData)) {
      return res.status(400).json({ success: false, message: "Datos inválidos" });
    }

    const mime = getMimeFromDataUrl(imageData);
    const ext = mime.split("/")[1] || "jpg";
    const base64 = getBase64FromDataUrl(imageData);
    
    const buffer = Buffer.from(base64, "base64");
    const filePath = `vehiculos/${userId}/${tipo}_${Date.now()}_${uuidv4()}.${ext}`;
    const file = bucket.file(filePath);
    
    console.log(`${colors.yellow}⬆️ Subiendo foto de ${tipo} para usuario ${userId}${colors.reset}`);
    
    await file.save(buffer, { contentType: mime, resumable: false });
    await file.makePublic();
    
    const url = file.publicUrl();
    console.log(`${colors.green}✅ Foto de ${tipo} subida: ${url}${colors.reset}`);
    
    res.json({ success: true, url });
  } catch (error) {
    console.error(`${colors.red}❌ Error subiendo foto:${colors.reset}`, error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 🔌 Socket.IO - Chat General + Sistema de Emergencia
// ============================================================
io.on("connection", (socket) => {
  console.log(`${colors.cyan}🔗 NUEVA CONEXIÓN SOCKET:${colors.reset} ${socket.id}`);

  // ============================================================
  // 🧩 Usuario conectado al chat general
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
    socket.join("general");

    // Actualizar estado de usuarios conectados
    const existing = connectedUsers.get(userId);
    if (existing) {
      existing.sockets.add(socket.id);
      existing.userData = { ...existing.userData, ...user, isOnline: true };
    } else {
      connectedUsers.set(userId, { 
        userData: { ...user, isOnline: true }, 
        sockets: new Set([socket.id]) 
      });
    }

    try {
      // Sincronizar con Firebase
      const userDoc = db.collection(USERS_COLLECTION).doc(userId);
      await userDoc.set({ ...user, isOnline: true, lastLogin: Date.now() }, { merge: true });
      console.log(`${colors.green}🔑 Usuario sincronizado con Firebase: ${username}${colors.reset}`);
    } catch (error) {
      console.error(`${colors.red}❌ Error al registrar usuario:${colors.reset}`, error);
    }

    // Notificar a todos los usuarios conectados
    io.emit(
      "connected_users",
      Array.from(connectedUsers.values()).map((u) => ({ 
        ...u.userData, 
        socketCount: u.sockets.size 
      }))
    );

    // Enviar mensaje de bienvenida
    socket.emit("join_success", { 
      room: "general", 
      message: `Bienvenido al chat general, ${username}!` 
    });

    ack?.({ success: true });
    console.log(`${colors.green}✅ ${username} conectado al chat general${colors.reset}`);
  });

  // ============================================================
  // 💬 Mensajes de texto en chat general
  // ============================================================
  socket.on("send_message", async (data = {}, ack) => {
    const { userId, username, text } = data;
    
    if (!userId || !username || !text) {
      return ack?.({ success: false, message: "❌ Datos de mensaje inválidos" });
    }

    const message = { 
      id: uuidv4(), 
      userId, 
      username, 
      roomId: "general", 
      text, 
      timestamp: Date.now() 
    };

    try {
      // Guardar en Firebase
      await db.collection(MESSAGES_COLLECTION).add(message);
      
      // Enviar a todos en el chat general
      io.to("general").emit("new_message", message);
      socket.emit("message_sent", message);
      
      ack?.({ success: true, id: message.id });
      console.log(`${colors.green}💬 ${username} → Chat General: ${text}${colors.reset}`);
    } catch (err) {
      ack?.({ success: false, message: "Error guardando mensaje" });
      console.error(`${colors.red}❌ Error al guardar mensaje:${colors.reset}`, err);
    }
  });

  // ============================================================
  // 👤 PERFIL: get_profile / update_profile
  // ============================================================
  socket.on("get_profile", async (data = {}, callback) => {
    try {
      const userId = data.userId;
      console.log(`${colors.cyan}📥 Evento → get_profile${colors.reset}`, data);

      if (!userId) {
        return callback?.({ success: false, message: "userId requerido" });
      }

      const snap = await db.collection(USERS_COLLECTION).doc(userId).get();
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

      let finalAvatar = avatarUri || "";
      if (isDataUrl(avatarUri)) {
        finalAvatar = await uploadAvatarFromDataUrl(userId, avatarUri);
      } else if (avatarUri && !isHttpUrl(avatarUri)) {
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

      // Actualizar en memoria
      const entry = connectedUsers.get(userId);
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

  // ============================================================
  // 📋 Obtener usuarios conectados
  // ============================================================
  socket.on("get_users", (data = {}, ack) => {
    console.log(`${colors.cyan}📥 Evento → get_users${colors.reset}`);

    const users = Array.from(connectedUsers.values()).map((u) => ({
      ...u.userData,
      roomId: "general",
    }));

    socket.emit("connected_users", users);
    ack?.({
      success: true,
      roomId: "general",
      count: users.length,
      users: users.map((u) => ({ id: u.id, username: u.username })),
    });

    console.log(`${colors.blue}📋 Chat General: ${users.length} usuarios conectados${colors.reset}`);
  });

  // ============================================================
  // 🚨 SISTEMA DE EMERGENCIA - NUEVOS EVENTOS
  // ============================================================

  // ============================================================
  // 🚨 Enviar alerta de emergencia
  // ============================================================
  socket.on("emergency_alert", async (data = {}, ack) => {
    try {
      const { userId, userName, latitude, longitude, timestamp } = data;
      console.log(`${colors.red}🚨 Evento → emergency_alert:${colors.reset}`, { userId, userName, latitude, longitude });

      if (!userId || !userName) {
        return ack?.({ success: false, message: "Datos de emergencia inválidos" });
      }

      const emergencyData = {
        userId,
        userName,
        latitude,
        longitude,
        timestamp: timestamp || Date.now(),
        socketId: socket.id
      };

      // Guardar en memoria
      emergencyAlerts.set(userId, emergencyData);
      
      // Crear conjunto de ayudantes para esta emergencia
      if (!emergencyHelpers.has(userId)) {
        emergencyHelpers.set(userId, new Set());
      }

      // Guardar en Firebase
      await db.collection(EMERGENCIAS_COLLECTION).doc(userId).set({
        ...emergencyData,
        status: "active",
        createdAt: Date.now()
      }, { merge: true });

      // Notificar a TODOS los usuarios conectados (excepto al que envió la alerta)
      socket.broadcast.emit("emergency_alert", emergencyData);
      
      console.log(`${colors.red}🚨 ALERTA DE EMERGENCIA: ${userName} en (${latitude}, ${longitude})${colors.reset}`);
      
      ack?.({ success: true, message: "Alerta de emergencia enviada" });
    } catch (error) {
      console.error(`${colors.red}❌ Error en emergency_alert:${colors.reset}`, error);
      ack?.({ success: false, message: error.message });
    }
  });

  // ============================================================
  // 📍 Actualizar ubicación durante emergencia
  // ============================================================
  socket.on("update_emergency_location", async (data = {}, ack) => {
    try {
      const { userId, userName, latitude, longitude, timestamp } = data;
      console.log(`${colors.blue}📍 Evento → update_emergency_location:${colors.reset}`, { userId, userName, latitude, longitude });

      if (!userId) {
        return ack?.({ success: false, message: "userId requerido" });
      }

      // Actualizar en memoria
      const existingAlert = emergencyAlerts.get(userId);
      if (existingAlert) {
        existingAlert.latitude = latitude;
        existingAlert.longitude = longitude;
        existingAlert.timestamp = timestamp || Date.now();
      }

      // Notificar a los ayudantes
      const helpers = emergencyHelpers.get(userId) || new Set();
      helpers.forEach(helperId => {
        io.to(helperId).emit("helper_location_update", {
          userId,
          userName,
          latitude,
          longitude,
          timestamp: timestamp || Date.now()
        });
      });

      ack?.({ success: true, message: "Ubicación actualizada" });
    } catch (error) {
      console.error(`${colors.red}❌ Error en update_emergency_location:${colors.reset}`, error);
      ack?.({ success: false, message: error.message });
    }
  });

  // ============================================================
  // ✅ Confirmar ayuda a una emergencia
  // ============================================================
  socket.on("confirm_help", async (data = {}, ack) => {
    try {
      const { emergencyUserId, helperId, helperName, latitude, longitude, timestamp } = data;
      console.log(`${colors.green}✅ Evento → confirm_help:${colors.reset}`, { emergencyUserId, helperId, helperName });

      if (!emergencyUserId || !helperId) {
        return ack?.({ success: false, message: "Datos de ayuda inválidos" });
      }

      // Agregar ayudante a la emergencia
      const helpers = emergencyHelpers.get(emergencyUserId) || new Set();
      helpers.add(helperId);
      emergencyHelpers.set(emergencyUserId, helpers);

      // Notificar al usuario en emergencia
      const emergencyAlert = emergencyAlerts.get(emergencyUserId);
      if (emergencyAlert && emergencyAlert.socketId) {
        io.to(emergencyAlert.socketId).emit("help_confirmed", {
          helperId,
          helperName,
          latitude,
          longitude,
          timestamp: timestamp || Date.now()
        });
      }

      // Notificar a todos los ayudantes
      helpers.forEach(hId => {
        if (hId !== helperId) {
          io.to(hId).emit("helper_location_update", {
            userId: helperId,
            userName: helperName,
            latitude,
            longitude,
            timestamp: timestamp || Date.now()
          });
        }
      });

      console.log(`${colors.green}✅ ${helperName} confirmó ayuda para ${emergencyUserId}${colors.reset}`);
      ack?.({ success: true, message: "Ayuda confirmada" });
    } catch (error) {
      console.error(`${colors.red}❌ Error en confirm_help:${colors.reset}`, error);
      ack?.({ success: false, message: error.message });
    }
  });

  // ============================================================
  // ❌ Rechazar ayuda a una emergencia
  // ============================================================
  socket.on("reject_help", async (data = {}, ack) => {
    try {
      const { emergencyUserId, helperId, helperName } = data;
      console.log(`${colors.yellow}❌ Evento → reject_help:${colors.reset}`, { emergencyUserId, helperId, helperName });

      if (!emergencyUserId || !helperId) {
        return ack?.({ success: false, message: "Datos inválidos" });
      }

      // Remover ayudante de la emergencia
      const helpers = emergencyHelpers.get(emergencyUserId);
      if (helpers) {
        helpers.delete(helperId);
      }

      // Notificar al usuario en emergencia
      const emergencyAlert = emergencyAlerts.get(emergencyUserId);
      if (emergencyAlert && emergencyAlert.socketId) {
        io.to(emergencyAlert.socketId).emit("help_rejected", {
          helperId,
          helperName
        });
      }

      console.log(`${colors.yellow}❌ ${helperName} rechazó ayuda para ${emergencyUserId}${colors.reset}`);
      ack?.({ success: true, message: "Ayuda rechazada" });
    } catch (error) {
      console.error(`${colors.red}❌ Error en reject_help:${colors.reset}`, error);
      ack?.({ success: false, message: error.message });
    }
  });

  // ============================================================
  // 🛑 Cancelar emergencia
  // ============================================================
  socket.on("cancel_emergency", async (data = {}, ack) => {
    try {
      const { userId } = data;
      console.log(`${colors.blue}🛑 Evento → cancel_emergency:${colors.reset}`, { userId });

      if (!userId) {
        return ack?.({ success: false, message: "userId requerido" });
      }

      // Remover de memoria
      emergencyAlerts.delete(userId);
      emergencyHelpers.delete(userId);

      // Actualizar en Firebase
      await db.collection(EMERGENCIAS_COLLECTION).doc(userId).set({
        status: "cancelled",
        cancelledAt: Date.now()
      }, { merge: true });

      // Notificar a todos los usuarios
      io.emit("emergency_cancelled", { userId });

      console.log(`${colors.blue}🛑 Emergencia cancelada para usuario: ${userId}${colors.reset}`);
      ack?.({ success: true, message: "Emergencia cancelada" });
    } catch (error) {
      console.error(`${colors.red}❌ Error en cancel_emergency:${colors.reset}`, error);
      ack?.({ success: false, message: error.message });
    }
  });

  // ============================================================
  // 👥 Solicitar lista de ayudantes disponibles
  // ============================================================
  socket.on("request_helpers", async (data = {}, ack) => {
    try {
      const { emergencyUserId } = data;
      console.log(`${colors.cyan}👥 Evento → request_helpers:${colors.reset}`, { emergencyUserId });

      if (!emergencyUserId) {
        return ack?.({ success: false, message: "emergencyUserId requerido" });
      }

      const helpers = emergencyHelpers.get(emergencyUserId) || new Set();
      const helpersArray = Array.from(helpers);

      // Obtener información de cada ayudante
      const helpersInfo = [];
      for (const helperId of helpersArray) {
        const helperEntry = connectedUsers.get(helperId);
        if (helperEntry) {
          helpersInfo.push({
            userId: helperId,
            userName: helperEntry.userData.username,
            isOnline: true
          });
        }
      }

      socket.emit("available_helpers", helpersInfo);
      ack?.({ success: true, helpers: helpersInfo });
    } catch (error) {
      console.error(`${colors.red}❌ Error en request_helpers:${colors.reset}`, error);
      ack?.({ success: false, message: error.message });
    }
  });

  // ============================================================
  // 🔴 Desconexión
  // ============================================================
  socket.on("disconnect", (reason) => {
    const userId = socket.userId;
    const username = socket.username;
    
    console.log(`${colors.red}🔌 Socket desconectado:${colors.reset} ${username || socket.id} (${reason})`);

    if (userId) {
      const entry = connectedUsers.get(userId);
      if (entry) {
        entry.sockets.delete(socket.id);
        if (entry.sockets.size === 0) {
          connectedUsers.delete(userId);
          
          // Si el usuario tenía una emergencia activa, cancelarla
          if (emergencyAlerts.has(userId)) {
            emergencyAlerts.delete(userId);
            emergencyHelpers.delete(userId);
            io.emit("emergency_cancelled", { userId });
            console.log(`${colors.red}🚨 Emergencia cancelada por desconexión de ${username}${colors.reset}`);
          }
          
          console.log(`${colors.red}🔴 Usuario ${username} completamente desconectado.${colors.reset}`);
        }
      }
    }

    // Actualizar lista de usuarios para todos
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
  console.log(`${colors.green}🚀 Servidor de chat corriendo en puerto ${PORT}${colors.reset}`);
  console.log(`${colors.cyan}🌐 http://localhost:${PORT}${colors.reset}`);
  console.log(`${colors.blue}💬 Chat General activo${colors.reset}`);
  console.log(`${colors.red}🚨 Sistema de Emergencia activo${colors.reset}`);
  console.log(`${colors.green}🚗 Soporte para vehículos activo${colors.reset}`);
});