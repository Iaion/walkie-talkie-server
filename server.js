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
  admin.firestore().settings({ ignoreUndefinedProperties: true });
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
const chatRooms = new Map(); // 🆕 Sistema de salas

// ============================================================
// 🏗️ Inicializar salas de chat por defecto
// ============================================================
function initializeDefaultRooms() {
  const defaultRooms = [
    { id: "general", name: "Chat General", type: "public", description: "Sala principal para conversaciones generales" },
    { id: "ayuda", name: "Sala de Ayuda", type: "public", description: "Sala para pedir y ofrecer ayuda" },
    { id: "handy", name: "Modo Handy", type: "ptt", description: "Sala para comunicación push-to-talk" }
  ];

  defaultRooms.forEach(room => {
    chatRooms.set(room.id, {
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

// Inicializar salas al arrancar
initializeDefaultRooms();

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

// 🔥 NUEVO: Calcular distancia entre coordenadas (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radio de la Tierra en km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// 🔥 NUEVO: Helper para obtener todos los usuarios conectados (sin límite de distancia)
function getNearbyUsers(alertLat, alertLng, radiusKm) {
  const allSockets = [];

  connectedUsers.forEach((userData) => {
    userData.sockets.forEach(socketId => {
      allSockets.push(socketId);
    });
  });

  return allSockets;
}

// 🆕 Función helper para actualizar lista de usuarios en sala
function updateRoomUserList(roomId) {
  const room = chatRooms.get(roomId);
  if (!room) return;

  const usersInRoom = Array.from(room.users).map(userId => {
    const userInfo = connectedUsers.get(userId);
    return userInfo ? userInfo.userData : null;
  }).filter(Boolean);

  // Enviar lista actualizada a todos en la sala
  io.to(roomId).emit("room_users_updated", {
    roomId: roomId,
    users: usersInRoom,
    userCount: usersInRoom.length
  });
}
// ============================================================
// 🔧 Helpers de emisión por userId → socketIds
// ============================================================
function emitToUser(userId, event, payload) {
  const entry = connectedUsers.get(userId);
  if (!entry) return 0; // usuario offline o sin sockets
  let count = 0;
  entry.sockets.forEach((sid) => {
    const s = io.sockets.sockets.get(sid);
    if (s) {
      s.emit(event, payload);
      count++;
    }
  });
  return count; // cantidad de sockets notificados
}

function emitToUserExcept(userId, exceptSocketId, event, payload) {
  const entry = connectedUsers.get(userId);
  if (!entry) return 0;
  let count = 0;
  entry.sockets.forEach((sid) => {
    if (sid === exceptSocketId) return;
    const s = io.sockets.sockets.get(sid);
    if (s) {
      s.emit(event, payload);
      count++;
    }
  });
  return count;
}


// ============================================================
// 🖼️ Subida de avatar en base64 (Firebase Storage optimizada)
// ============================================================
async function uploadAvatarFromDataUrl(userId, dataUrl) {
  try {
    if (!isDataUrl(dataUrl)) {
      throw new Error("Formato de imagen inválido (no es DataURL)");
    }

    // Detectar tipo MIME y extensión
    const mime = getMimeFromDataUrl(dataUrl);
    const ext = mime.split("/")[1] || "jpg";
    const base64 = getBase64FromDataUrl(dataUrl);

    if (!base64) throw new Error("Data URL inválida (sin base64)");

    const buffer = Buffer.from(base64, "base64");

    // 🔧 Generar ruta única en Storage
    const filePath = `avatars/${userId}/${Date.now()}_${uuidv4()}.${ext}`;
    const file = bucket.file(filePath);

    console.log(
      `${colors.yellow}⬆️ Subiendo avatar optimizado → ${filePath} (${mime})${colors.reset}`
    );

    // Guardar imagen (sin reanudación, directo)
    await file.save(buffer, {
      contentType: mime,
      resumable: false,
      gzip: true, // 🔧 Compresión automática
      metadata: {
        cacheControl: "public, max-age=31536000", // 1 año
        metadata: { userId },
      },
    });

    // Hacer el archivo público
    await file.makePublic();
    const publicUrl = file.publicUrl();

    console.log(`${colors.green}✅ Avatar subido y público:${colors.reset} ${publicUrl}`);

    // ============================================================
    // 🧹 OPCIONAL: eliminar avatares viejos del usuario
    // ============================================================
    try {
      const [files] = await bucket.getFiles({ prefix: `avatars/${userId}/` });
      const sorted = files.sort(
        (a, b) => b.metadata.timeCreated.localeCompare(a.metadata.timeCreated)
      );
      // Conserva solo el más reciente (índice 0)
      const oldFiles = sorted.slice(1);
      if (oldFiles.length > 0) {
        await Promise.allSettled(oldFiles.map((f) => f.delete()));
        console.log(
          `${colors.gray}🧹 ${oldFiles.length} avatares antiguos eliminados (${userId})${colors.reset}`
        );
      }
    } catch (cleanupErr) {
      console.warn(
        `${colors.yellow}⚠️ No se pudieron limpiar avatares antiguos:${colors.reset} ${cleanupErr.message}`
      );
    }

    return publicUrl;
  } catch (error) {
    console.error(`${colors.red}❌ Error en uploadAvatarFromDataUrl:${colors.reset}`, error);
    throw error;
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

// ============================================================
// 🏪 Endpoints para Salas de Chat
// ============================================================

// Obtener todas las salas disponibles
app.get("/rooms", (req, res) => {
  try {
    const roomsArray = Array.from(chatRooms.values()).map(room => ({
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

// Obtener información de una sala específica
app.get("/rooms/:roomId", (req, res) => {
  try {
    const { roomId } = req.params;
    const room = chatRooms.get(roomId);

    if (!room) {
      return res.status(404).json({ success: false, message: "Sala no encontrada" });
    }

    const roomInfo = {
      ...room,
      userCount: room.users.size,
      users: Array.from(room.users).map(userId => {
        const user = connectedUsers.get(userId);
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

// ============================================================
// 🚗 Guardar/actualizar vehículo - VERSIÓN CORREGIDA
// ============================================================
app.post("/vehiculo", async (req, res) => {
  try {
    const vehiculoData = req.body;
    console.log(`${colors.cyan}🚗 POST /vehiculo${colors.reset}`, {
      patente: vehiculoData.patente,
      marca: vehiculoData.marca,
      modelo: vehiculoData.modelo,
      userId: vehiculoData.userId,
      fotoVehiculoUri: vehiculoData.fotoVehiculoUri ? "✅ Presente" : "❌ Ausente",
      fotoCascoUri: vehiculoData.fotoCascoUri ? "✅ Presente" : "❌ Ausente"
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
      // 🔥 CORREGIDO: Crear nuevo vehículo con datos completos
      const nuevoVehiculo = {
        ...vehiculoData,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        // ✅ Asegurar que las URLs de imágenes se guarden
        fotoVehiculoUri: vehiculoData.fotoVehiculoUri || "",
        fotoCascoUri: vehiculoData.fotoCascoUri || ""
      };
      
      result = await db.collection(VEHICULOS_COLLECTION).add(nuevoVehiculo);
      console.log(`${colors.green}✅ Nuevo vehículo creado: ${vehiculoData.patente}${colors.reset}`);
      
      // 🔍 DEBUG: Verificar URLs en nuevo vehículo
      console.log(`${colors.blue}🔍 URLs en nuevo vehículo:${colors.reset}`, {
        fotoVehiculoUri: nuevoVehiculo.fotoVehiculoUri ? "✅ URL guardada" : "❌ Sin URL",
        fotoCascoUri: nuevoVehiculo.fotoCascoUri ? "✅ URL guardada" : "❌ Sin URL"
      });
    } else {
      // 🔥 CORREGIDO: Actualizar vehículo existente SIN perder imágenes
      const existingDoc = snapshot.docs[0];
      const existingData = existingDoc.data();
      
      // 🖼️ PRESERVAR URLs existentes si no vienen nuevas
      const updateData = {
        ...vehiculoData,
        updatedAt: Date.now(),
        // ✅ Mantener URLs existentes si no se envían nuevas
        fotoVehiculoUri: vehiculoData.fotoVehiculoUri || existingData.fotoVehiculoUri || "",
        fotoCascoUri: vehiculoData.fotoCascoUri || existingData.fotoCascoUri || ""
      };
      
      result = await existingDoc.ref.update(updateData);
      console.log(`${colors.green}✅ Vehículo actualizado: ${vehiculoData.patente}${colors.reset}`);
      
      // 🔍 DEBUG: Verificar URLs antes y después
      console.log(`${colors.blue}🔍 URLs ANTES de actualizar:${colors.reset}`, {
        fotoVehiculoUri: existingData.fotoVehiculoUri || "❌ No existía",
        fotoCascoUri: existingData.fotoCascoUri || "❌ No existía"
      });
      
      console.log(`${colors.blue}🔍 URLs DESPUÉS de actualizar:${colors.reset}`, {
        fotoVehiculoUri: updateData.fotoVehiculoUri || "❌ Sin URL",
        fotoCascoUri: updateData.fotoCascoUri || "❌ Sin URL",
        esUrlFirebaseVehiculo: updateData.fotoVehiculoUri?.includes('firebasestorage') ? "✅ Firebase" : "❌ No Firebase",
        esUrlFirebaseCasco: updateData.fotoCascoUri?.includes('firebasestorage') ? "✅ Firebase" : "❌ No Firebase"
      });
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


// ============================================================
// 🚗 Subir foto de vehículo o casco + Guardar URL en Firestore - VERSIÓN CORREGIDA
// ============================================================
app.post("/vehiculo/foto", async (req, res) => {
  try {
    const { userId, imageData, tipo } = req.body; // tipo: 'vehiculo' o 'casco'

    if (!userId || !imageData || !isDataUrl(imageData)) {
      return res.status(400).json({ 
        success: false, 
        message: "Datos inválidos: userId, imageData y tipo son requeridos" 
      });
    }

    if (tipo !== 'vehiculo' && tipo !== 'casco') {
      return res.status(400).json({ 
        success: false, 
        message: "Tipo inválido. Debe ser 'vehiculo' o 'casco'" 
      });
    }

    console.log(`${colors.yellow}⬆️ Subiendo foto de ${tipo} para usuario ${userId}${colors.reset}`);

    // Determinar tipo MIME y extensión
    const mime = getMimeFromDataUrl(imageData);
    const ext = mime.split("/")[1] || "jpg";
    const base64 = getBase64FromDataUrl(imageData);

    if (!base64) {
      return res.status(400).json({ 
        success: false, 
        message: "Formato de imagen inválido" 
      });
    }

    const buffer = Buffer.from(base64, "base64");
    const filePath = `vehiculos/${userId}/${tipo}_${Date.now()}_${uuidv4()}.${ext}`;
    const file = bucket.file(filePath);

    // Subir a Firebase Storage
    await file.save(buffer, { 
      contentType: mime, 
      resumable: false,
      metadata: {
        cacheControl: 'public, max-age=31536000',
      }
    });
    await file.makePublic();

    const url = file.publicUrl();
    console.log(`${colors.green}✅ Foto de ${tipo} subida: ${url}${colors.reset}`);

    // ============================================================
    // 🧠 CORREGIDO: Buscar el documento del vehículo y actualizar correctamente
    // ============================================================
    try {
      // Primero buscar el vehículo del usuario
      const snapshot = await db.collection(VEHICULOS_COLLECTION)
        .where("userId", "==", userId)
        .limit(1)
        .get();

      if (snapshot.empty) {
        // 🔥 CREAR NUEVO VEHÍCULO si no existe
        const nuevoVehiculo = {
          userId: userId,
          fotoVehiculoUri: tipo === 'vehiculo' ? url : "",
          fotoCascoUri: tipo === 'casco' ? url : "",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          isActive: true
        };
        
        await db.collection(VEHICULOS_COLLECTION).add(nuevoVehiculo);
        console.log(`${colors.green}✅ Nuevo vehículo creado para usuario ${userId} con foto de ${tipo}${colors.reset}`);
      } else {
        // 🔥 ACTUALIZAR VEHÍCULO EXISTENTE
        const existingDoc = snapshot.docs[0];
        const existingData = existingDoc.data();
        
        // 🖼️ PRESERVAR la otra foto si existe
        const updateData = {
          updatedAt: Date.now()
        };
        
        if (tipo === 'vehiculo') {
          updateData.fotoVehiculoUri = url;
          // Mantener la foto del casco si existe
          if (existingData.fotoCascoUri) {
            updateData.fotoCascoUri = existingData.fotoCascoUri;
          }
        } else {
          updateData.fotoCascoUri = url;
          // Mantener la foto del vehículo si existe
          if (existingData.fotoVehiculoUri) {
            updateData.fotoVehiculoUri = existingData.fotoVehiculoUri;
          }
        }
        
        await existingDoc.ref.update(updateData);
        console.log(`${colors.green}✅ Vehículo existente actualizado con foto de ${tipo}${colors.reset}`);
        
        // 🔍 DEBUG
        console.log(`${colors.blue}🔍 Estado después de actualizar:${colors.reset}`, {
          fotoVehiculoUri: updateData.fotoVehiculoUri || existingData.fotoVehiculoUri || "❌ Sin URL",
          fotoCascoUri: updateData.fotoCascoUri || existingData.fotoCascoUri || "❌ Sin URL"
        });
      }

      console.log(`${colors.green}☁️ Firestore actualizado con URL de ${tipo} para ${userId}${colors.reset}`);

    } catch (firestoreError) {
      console.error(`${colors.red}❌ Error actualizando Firestore:${colors.reset}`, firestoreError);
      // ⚠️ Pero aún así responder éxito porque la imagen se subió
    }

    // ✅ Responder con éxito
    res.json({
      success: true,
      message: `Foto de ${tipo} subida y guardada correctamente`,
      url: url,
      tipo: tipo
    });

  } catch (error) {
    console.error(`${colors.red}❌ Error subiendo foto:${colors.reset}`, error);
    res.status(500).json({ 
      success: false, 
      message: `Error subiendo foto: ${error.message}` 
    });
  }
});

// ============================================================
// 🔍 Endpoint para debuggear vehículos (OPCIONAL PERO ÚTIL)
// ============================================================
app.get("/debug/vehiculo/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    console.log(`${colors.cyan}🔍 DEBUG /debug/vehiculo/${userId}${colors.reset}`);

    const snapshot = await db.collection(VEHICULOS_COLLECTION)
      .where("userId", "==", userId)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.json({ 
        success: true, 
        debug: { existe: false, message: "Vehículo no encontrado" } 
      });
    }

    const vehiculoDoc = snapshot.docs[0];
    const vehiculo = { id: vehiculoDoc.id, ...vehiculoDoc.data() };
    
    // Información detallada para debug
    const debugInfo = {
      existe: true,
      patente: vehiculo.patente || "❌ No tiene",
      userId: vehiculo.userId,
      fotoVehiculoUri: {
        valor: vehiculo.fotoVehiculoUri || "❌ Vacío",
        esFirebaseUrl: vehiculo.fotoVehiculoUri?.includes('firebasestorage') ? "✅ Sí" : "❌ No",
        longitud: vehiculo.fotoVehiculoUri?.length || 0,
        esValida: vehiculo.fotoVehiculoUri?.startsWith('http') ? "✅ Sí" : "❌ No"
      },
      fotoCascoUri: {
        valor: vehiculo.fotoCascoUri || "❌ Vacío",
        esFirebaseUrl: vehiculo.fotoCascoUri?.includes('firebasestorage') ? "✅ Sí" : "❌ No",
        longitud: vehiculo.fotoCascoUri?.length || 0,
        esValida: vehiculo.fotoCascoUri?.startsWith('http') ? "✅ Sí" : "❌ No"
      },
      actualizado: new Date(vehiculo.updatedAt).toISOString()
    };
    
    console.log(`${colors.green}🔍 DEBUG Vehículo:${colors.reset}`, debugInfo);
    res.json({ success: true, debug: debugInfo, vehiculo });
  } catch (error) {
    console.error(`${colors.red}❌ Error en debug:${colors.reset}`, error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// 🔌 Socket.IO - Chat General + Sistema de Emergencia
// ============================================================
io.on("connection", (socket) => {
  console.log(`${colors.cyan}🔗 NUEVA CONEXIÓN SOCKET:${colors.reset} ${socket.id}`);

  // ============================================================
  // 🧩 Usuario conectado al chat general - MEJORADO
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

    // Unir automáticamente al chat general por defecto
    const defaultRoom = "general";
    socket.join(defaultRoom);
    socket.currentRoom = defaultRoom;

    // Agregar usuario a la sala en memoria
    const generalRoom = chatRooms.get(defaultRoom);
    if (generalRoom) {
      generalRoom.users.add(userId);
    }

    // Actualizar estado de usuarios conectados
    const existing = connectedUsers.get(userId);
    if (existing) {
      existing.sockets.add(socket.id);
      existing.userData = { ...existing.userData, ...user, isOnline: true };
    } else {
      connectedUsers.set(userId, { 
        userData: { ...user, isOnline: true, currentRoom: defaultRoom }, 
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

    // Enviar información de salas disponibles al usuario
    socket.emit("available_rooms", 
      Array.from(chatRooms.values()).map(room => ({
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

    // Notificar a la sala general que llegó un nuevo usuario
    socket.to(defaultRoom).emit("user_joined_room", {
      userId: userId,
      username: username,
      roomId: defaultRoom,
      message: `${username} se unió a la sala`,
      timestamp: Date.now()
    });

    // Actualizar lista de usuarios en la sala
    updateRoomUserList(defaultRoom);

    ack?.({ success: true });
    console.log(`${colors.green}✅ ${username} conectado al chat general${colors.reset}`);
  });

  // ============================================================
  // 🔥 NUEVO: Unirse a sala (general o emergencia) - MEJORADO
  // ============================================================
  socket.on("join_room", async (data = {}, ack) => {
    const { roomId, userId, username } = data;
    
    if (!roomId || !userId || !username) {
      return ack?.({ 
        success: false, 
        message: "❌ Datos de sala inválidos" 
      });
    }

    console.log(`${colors.blue}🚪 join_room:${colors.reset} ${username} → ${roomId}`);

    try {
      // Verificar que la sala existe
      const targetRoom = chatRooms.get(roomId);
      if (!targetRoom) {
        return ack?.({ 
          success: false, 
          message: `❌ La sala ${roomId} no existe` 
        });
      }

      // Dejar sala anterior si existe
      if (socket.currentRoom) {
        const previousRoom = chatRooms.get(socket.currentRoom);
        if (previousRoom) {
          previousRoom.users.delete(userId);
          socket.leave(socket.currentRoom);
          
          // Notificar salida de la sala anterior
          socket.to(socket.currentRoom).emit("user_left_room", {
            userId: userId,
            username: username,
            roomId: socket.currentRoom,
            message: `${username} salió de la sala`,
            timestamp: Date.now()
          });
        }
      }

      // Unirse a nueva sala
      socket.join(roomId);
      socket.currentRoom = roomId;
      targetRoom.users.add(userId);

      // Actualizar estado del usuario
      const userInfo = connectedUsers.get(userId);
      if (userInfo) {
        userInfo.userData.currentRoom = roomId;
      }

      // Enviar historial de mensajes de la sala
      try {
        const messagesSnapshot = await db.collection(MESSAGES_COLLECTION)
          .where("roomId", "==", roomId)
          .orderBy("timestamp", "desc")
          .limit(50)
          .get();

        const messages = messagesSnapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        })).reverse();

        socket.emit("room_messages", {
          roomId: roomId,
          messages: messages
        });
      } catch (dbError) {
        console.warn(`${colors.yellow}⚠️ No se pudo cargar historial de mensajes:${colors.reset}`, dbError.message);
      }

      // Determinar tipo de sala
      let roomType = "general";
      if (roomId.startsWith("emergencia_")) {
        roomType = "emergency";
        console.log(`${colors.red}🚨 ${username} unido a sala de EMERGENCIA: ${roomId}${colors.reset}`);
      } else if (roomId === "handy") {
        roomType = "ptt";
      }

      // Enviar confirmación
      ack?.({ 
        success: true, 
        roomId: roomId,
        roomName: targetRoom.name,
        message: `Unido a ${targetRoom.name}`,
        type: roomType
      });

      // Notificar a otros en la sala
      socket.to(roomId).emit("user_joined_room", {
        userId: userId,
        username: username,
        roomId: roomId,
        message: `${username} se unió a la sala`,
        timestamp: Date.now()
      });

      // Actualizar lista de usuarios en sala
      updateRoomUserList(roomId);

      console.log(`${colors.green}✅ ${username} unido a sala: ${roomId}${colors.reset}`);

    } catch (error) {
      console.error(`${colors.red}❌ Error uniendo a sala:${colors.reset}`, error);
      ack?.({ success: false, message: "Error al unirse a la sala" });
    }
  });

  // ============================================================
  // 🔥 NUEVO: Salir de sala - MEJORADO
  // ============================================================
  socket.on("leave_room", async (data = {}, ack) => {
    const { roomId, userId } = data;
    
    if (!roomId) {
      return ack?.({ success: false, message: "❌ Sala no especificada" });
    }

    console.log(`${colors.blue}🚪 leave_room:${colors.reset} ${socket.username} → ${roomId}`);

    try {
      const room = chatRooms.get(roomId);
      if (!room) {
        return ack?.({ success: false, message: "Sala no encontrada" });
      }

      // Salir de la sala
      socket.leave(roomId);
      room.users.delete(userId || socket.userId);
      
      // Limpiar sala actual si era la actual
      if (socket.currentRoom === roomId) {
        socket.currentRoom = null;
      }

      // Actualizar estado del usuario
      const userInfo = connectedUsers.get(userId || socket.userId);
      if (userInfo && userInfo.userData.currentRoom === roomId) {
        userInfo.userData.currentRoom = null;
      }

      // Notificar a otros en la sala
      socket.to(roomId).emit("user_left_room", {
        userId: userId || socket.userId,
        username: socket.username,
        roomId: roomId,
        message: `${socket.username} salió de la sala`,
        timestamp: Date.now()
      });

      // Actualizar lista de usuarios en sala
      updateRoomUserList(roomId);

      ack?.({ success: true, message: `Salido de ${roomId}` });
      console.log(`${colors.yellow}↩️ ${socket.username} salió de: ${roomId}${colors.reset}`);

    } catch (error) {
      console.error(`${colors.red}❌ Error saliendo de sala:${colors.reset}`, error);
      ack?.({ success: false, message: "Error al salir de la sala" });
    }
  });

  // ============================================================
  // 💬 Mensajes de texto en cualquier sala - ACTUALIZADO
  // ============================================================
  socket.on("send_message", async (data = {}, ack) => {
    const { userId, username, text, roomId = socket.currentRoom || "general" } = data;
    
    if (!userId || !username || !text) {
      return ack?.({ success: false, message: "❌ Datos de mensaje inválidos" });
    }

    if (!socket.currentRoom || !chatRooms.has(roomId)) {
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
      // Guardar en Firebase
      await db.collection(MESSAGES_COLLECTION).add(message);
      
      // Incrementar contador de mensajes en la sala
      const room = chatRooms.get(roomId);
      if (room) {
        room.messageCount++;
      }
      
      // Enviar a todos en la sala específica
      io.to(roomId).emit("new_message", message);
      socket.emit("message_sent", message);
      
      ack?.({ success: true, id: message.id });

      // Log especial para emergencias
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
  // 🎧 Mensajes de audio en cualquier sala - NUEVO
  // ============================================================
  socket.on("audio_message", async (data = {}, ack) => {
    try {
      const { userId, username, audioUrl, roomId = socket.currentRoom || "general" } = data;
      
      console.log(`${colors.magenta}🎧 Evento → audio_message:${colors.reset}`, { 
        userId, 
        username, 
        roomId,
        audioUrl: audioUrl ? `✅ Presente` : "❌ Ausente" 
      });

      if (!userId || !username || !audioUrl) {
        return ack?.({ success: false, message: "❌ Datos de audio inválidos" });
      }

      if (!socket.currentRoom || !chatRooms.has(roomId)) {
        return ack?.({ success: false, message: "❌ No estás en una sala válida" });
      }

      const message = { 
        id: uuidv4(), 
        userId, 
        username, 
        roomId: roomId, 
        audioUrl: audioUrl,
        type: "audio",
        content: "[Audio]",
        timestamp: Date.now() 
      };

      try {
        // Guardar en Firebase
        await db.collection(MESSAGES_COLLECTION).add(message);
        
        // Incrementar contador de mensajes en la sala
        const room = chatRooms.get(roomId);
        if (room) {
          room.messageCount++;
        }
        
        // Enviar a todos en la sala específica
        io.to(roomId).emit("audio_message", message);
        socket.emit("message_sent", message);
        
        ack?.({ success: true, id: message.id });

        // Log especial para emergencias
        if (roomId.startsWith("emergencia_")) {
          console.log(`${colors.red}🚨 ${username} → EMERGENCIA ${roomId}: [Audio]${colors.reset}`);
        } else {
          console.log(`${colors.magenta}🎧 ${username} → ${roomId}: [Audio]${colors.reset}`);
        }

      } catch (err) {
        ack?.({ success: false, message: "Error guardando mensaje de audio" });
        console.error(`${colors.red}❌ Error al guardar mensaje de audio:${colors.reset}`, err);
      }

    } catch (error) {
      console.error(`${colors.red}❌ Error en audio_message:${colors.reset}`, error);
      ack?.({ success: false, message: error.message });
    }
  });

  // ============================================================
  // 🔥 NUEVO: Solicitar lista de usuarios en sala
  // ============================================================
  socket.on("request_user_list", (data = {}, ack) => {
    const { roomId } = data;
    
    if (!roomId) {
      return ack?.({ success: false, message: "❌ Sala no especificada" });
    }

    try {
      const room = chatRooms.get(roomId);
      if (!room) {
        return ack?.({ success: false, message: "Sala no encontrada" });
      }

      const usersInRoom = Array.from(room.users).map(userId => {
        const userInfo = connectedUsers.get(userId);
        return userInfo ? userInfo.userData : null;
      }).filter(Boolean);

      ack?.({ 
        success: true, 
        roomId: roomId,
        users: usersInRoom 
      });

      console.log(`${colors.blue}👥 Lista usuarios en ${roomId}:${colors.reset} ${usersInRoom.length} usuarios`);

    } catch (error) {
      console.error(`${colors.red}❌ Error obteniendo lista de usuarios:${colors.reset}`, error);
      ack?.({ success: false, message: "Error obteniendo usuarios" });
    }
  });

  // ============================================================
  // 🔥 NUEVO: Solicitar salas disponibles
  // ============================================================
  socket.on("request_available_rooms", (data = {}, ack) => {
    try {
      const roomsArray = Array.from(chatRooms.values()).map(room => ({
        id: room.id,
        name: room.name,
        type: room.type,
        description: room.description,
        userCount: room.users.size,
        messageCount: room.messageCount
      }));

      ack?.({ 
        success: true, 
        rooms: roomsArray 
      });

      console.log(`${colors.blue}🏪 Salas disponibles enviadas:${colors.reset} ${roomsArray.length} salas`);

    } catch (error) {
      console.error(`${colors.red}❌ Error obteniendo salas:${colors.reset}`, error);
      ack?.({ success: false, message: "Error obteniendo salas" });
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

    // ============================================================
    // 🧠 MANTENER AVATAR PREVIO SI NO LLEGA NUEVO
    // ============================================================
    const prevSnap = await db.collection(USERS_COLLECTION).doc(userId).get();
    const prevData = prevSnap.exists ? prevSnap.data() : {};
    let finalAvatar = prevData?.avatarUri || "";

    // ============================================================
    // 🖼️ Lógica para decidir qué hacer con el nuevo avatarUri
    // ============================================================
    if (typeof avatarUri === "string" && avatarUri.trim() !== "") {
      if (isDataUrl(avatarUri)) {
        // 👉 Imagen codificada en base64 → subir a Firebase Storage
        finalAvatar = await uploadAvatarFromDataUrl(userId, avatarUri);
      } else if (isHttpUrl(avatarUri)) {
        // 👉 Ya es una URL válida → conservarla
        finalAvatar = avatarUri;
      } else {
        // 👉 Es un content:// u otra ruta local → ignorar, mantener el anterior
        console.log(`${colors.gray}⚠️ URI local ignorada (${avatarUri})${colors.reset}`);
      }
    } else {
      console.log(`${colors.yellow}🟡 No llegó avatar nuevo, se mantiene el anterior${colors.reset}`);
    }

    // ============================================================
    // 📋 Armar objeto final del usuario actualizado
    // ============================================================
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

    // ============================================================
    // ☁️ Guardar en Firestore (merge)
    // ============================================================
    await db.collection(USERS_COLLECTION).doc(userId).set(updatedUser, { merge: true });

    // ============================================================
    // 💾 Actualizar en memoria
    // ============================================================
    const entry = connectedUsers.get(userId);
    if (entry) {
      entry.userData = { ...entry.userData, ...updatedUser };
    }

    // ============================================================
    // 🚀 Emitir cambios globalmente
    // ============================================================
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
// 🚨 Enviar alerta de emergencia - VERSIÓN COMPLETAMENTE CORREGIDA
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

    // ============================================================
    // 🧩 Validaciones básicas
    // ============================================================
    if (!userId || !userName) {
      console.warn(`${colors.yellow}⚠️ Datos de usuario faltantes${colors.reset}`);
      return ack?.({ success: false, message: "Datos de usuario inválidos" });
    }

    if (typeof latitude !== "number" || typeof longitude !== "number") {
      console.warn(`${colors.yellow}⚠️ Coordenadas inválidas${colors.reset}`);
      return ack?.({ success: false, message: "Ubicación inválida" });
    }

    // ============================================================
    // 🧩 Obtener avatar del usuario desde Firestore - VERSIÓN MEJORADA
    // ============================================================
    let avatarUrl = null;
    try {
      const userDoc = await db.collection(USERS_COLLECTION).doc(userId).get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        // 🔥 CORRECCIÓN CRÍTICA: Buscar tanto avatarUri como avatarUrl para compatibilidad
        avatarUrl = userData?.avatarUrl || userData?.avatarUri || null;
        
        // 🔍 DEBUG DETALLADO del avatar
        console.log(`${colors.green}✅ Avatar obtenido:${colors.reset}`, {
          userId: userId,
          avatarUrl: avatarUrl ? `✅ Presente (${avatarUrl.substring(0, 80)}...)` : "❌ Ausente",
          campoEncontrado: userData?.avatarUrl ? 'avatarUrl' : userData?.avatarUri ? 'avatarUri' : 'ninguno',
          esUrlValida: avatarUrl ? avatarUrl.startsWith('http') : false,
          esFirebaseUrl: avatarUrl ? avatarUrl.includes('firebasestorage') : false
        });
      } else {
        console.log(`${colors.yellow}⚠️ Usuario no encontrado en Firestore: ${userId}${colors.reset}`);
      }
    } catch (e) {
      console.warn(`${colors.yellow}⚠️ Error obteniendo avatar:${colors.reset} ${e.message}`);
    }

    // ============================================================
    // 🚗 Obtener datos del vehículo del usuario - VERSIÓN MEJORADA
    // ============================================================
    let vehicleData = null;
    try {
      const vehiculoSnap = await db
        .collection(VEHICULOS_COLLECTION)
        .where("userId", "==", userId)
        .limit(1)
        .get();

      if (!vehiculoSnap.empty) {
        const vehiculoDoc = vehiculoSnap.docs[0];
        const vehiculo = vehiculoDoc.data();
        vehicleData = {
          marca: vehiculo.marca || "Desconocida",
          modelo: vehiculo.modelo || "",
          patente: vehiculo.patente || "N/A",
          color: vehiculo.color || "",
          fotoVehiculoUri: vehiculo.fotoVehiculoUri || "",
        };
        
        // 🔍 DEBUG DETALLADO del vehículo
        console.log(`${colors.green}✅ Vehículo asociado:${colors.reset}`, {
          patente: vehicleData.patente,
          marca: vehicleData.marca,
          modelo: vehicleData.modelo,
          fotoVehiculoUri: vehicleData.fotoVehiculoUri ? `✅ Presente` : "❌ Ausente",
          esUrlValida: vehicleData.fotoVehiculoUri ? vehicleData.fotoVehiculoUri.startsWith('http') : false
        });
      } else {
        console.log(`${colors.yellow}⚠️ No se encontró vehículo para ${userName}${colors.reset}`);
      }
    } catch (vehErr) {
      console.warn(`${colors.yellow}⚠️ Error obteniendo vehículo:${colors.reset} ${vehErr.message}`);
    }

    // ============================================================
    // 🚨 Crear objeto completo de emergencia - VERSIÓN CORREGIDA
    // ============================================================
    const emergencyData = {
      userId,
      userName,
      avatarUrl: avatarUrl, // ✅ CORREGIDO: usar avatarUrl que es lo que espera Android
      latitude,
      longitude,
      timestamp: timestamp || Date.now(),
      socketId: socket.id,
      emergencyType,
      status: "active",
      vehicleInfo: vehicleData,
    };

    // 🔍 DEBUG FINAL de los datos que se enviarán
    console.log(`${colors.cyan}📦 DATOS DE EMERGENCIA A ENVIAR:${colors.reset}`, {
      userName: emergencyData.userName,
      avatarUrl: emergencyData.avatarUrl ? `✅ Presente (${emergencyData.avatarUrl.substring(0, 50)}...)` : "❌ Ausente",
      vehicleInfo: emergencyData.vehicleInfo ? `✅ Presente` : "❌ Ausente",
      vehicleImage: emergencyData.vehicleInfo?.fotoVehiculoUri ? `✅ Presente` : "❌ Ausente"
    });

    // ============================================================
    // 💾 Guardar en memoria y Firestore
    // ============================================================
    emergencyAlerts.set(userId, emergencyData);
    if (!emergencyHelpers.has(userId)) {
      emergencyHelpers.set(userId, new Set());
    }

    try {
      await db
        .collection(EMERGENCIAS_COLLECTION)
        .doc(userId)
        .set(
          {
            ...emergencyData,
            createdAt: Date.now(),
          },
          { merge: true }
        );
      console.log(`${colors.green}✅ Emergencia registrada en Firestore${colors.reset}`);
    } catch (fireErr) {
      console.error(`${colors.red}❌ Error guardando emergencia:${colors.reset}`, fireErr.message);
    }

    // ============================================================
    // 🆕 Crear sala de emergencia automáticamente
    // ============================================================
    const emergencyRoomId = `emergencia_${userId}_${Date.now()}`;
    const emergencyRoom = {
      id: emergencyRoomId,
      name: `Emergencia ${userName}`,
      type: "emergency",
      description: `Sala de emergencia para ${userName}`,
      users: new Set([userId]), // El usuario en emergencia se une automáticamente
      createdAt: Date.now(),
      messageCount: 0,
      emergencyData: data
    };

    chatRooms.set(emergencyRoomId, emergencyRoom);

    // Unir al usuario a su sala de emergencia
    socket.join(emergencyRoomId);
    socket.currentRoom = emergencyRoomId;

    // Notificar a todos sobre la nueva sala de emergencia
    io.emit("new_room_created", {
      ...emergencyRoom,
      userCount: 1
    });

    console.log(`${colors.red}🚨 Sala de emergencia creada: ${emergencyRoomId}${colors.reset}`);

    // ============================================================
    // 🔥 Notificar a los demás usuarios conectados - VERSIÓN MEJORADA
    // ============================================================
    const nearbyUsers = getNearbyUsers(latitude, longitude, 50); // 50 km de radio
    
    console.log(`${colors.blue}👥 Usuarios cercanos encontrados: ${nearbyUsers.length}${colors.reset}`);
    
    let notifiedCount = 0;
    nearbyUsers.forEach((nearbySocketId) => {
      if (nearbySocketId !== socket.id) {
        // 🔍 DEBUG de lo que se envía a cada usuario
        console.log(`${colors.magenta}📤 Enviando a socket: ${nearbySocketId}${colors.reset}`, {
          userName: emergencyData.userName,
          tieneAvatar: !!emergencyData.avatarUrl,
          tieneVehiculo: !!emergencyData.vehicleInfo
        });
        
        io.to(nearbySocketId).emit("emergency_alert", {
          ...emergencyData,
          emergencyRoomId: emergencyRoomId // 🆕 Incluir ID de sala de emergencia
        });
        notifiedCount++;
      }
    });

    console.log(
      `${colors.red}📢 ALERTA DIFUNDIDA:${colors.reset} ${userName} → ${notifiedCount}/${nearbyUsers.length} usuarios notificados`
    );

    // ============================================================
    // ✅ Responder al emisor - VERSIÓN MEJORADA
    // ============================================================
    const response = {
      success: true,
      message: "Alerta de emergencia enviada correctamente",
      vehicle: vehicleData,
      avatarUrl: avatarUrl, // ✅ Incluir info del avatar en la respuesta
      notifiedUsers: notifiedCount,
      totalNearbyUsers: nearbyUsers.length,
      emergencyRoomId: emergencyRoomId // 🆕 Incluir ID de sala de emergencia
    };

    console.log(`${colors.green}✅ Respuesta al emisor:${colors.reset}`, {
      success: response.success,
      notifiedUsers: response.notifiedUsers,
      tieneAvatar: !!response.avatarUrl,
      tieneVehiculo: !!response.vehicle,
      emergencyRoomId: response.emergencyRoomId
    });

    ack?.(response);

  } catch (error) {
    console.error(`${colors.red}❌ Error en emergency_alert:${colors.reset}`, error);
    ack?.({ 
      success: false, 
      message: error.message,
      errorDetails: "Error procesando alerta de emergencia"
    });
  }
});

  // ============================================================
// 📍 Actualizar ubicación durante emergencia (userId → sockets)
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

    // Notificar a los ayudantes (userIds → TODOS sus sockets)
    const helpers = emergencyHelpers.get(userId) || new Set();
    helpers.forEach(helperUserId => {
      emitToUser(helperUserId, "helper_location_update", {
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
// ✅ Confirmar ayuda a una emergencia (userId → sockets)
// ============================================================
socket.on("confirm_help", async (data = {}, ack) => {
  try {
    const { emergencyUserId, helperId, helperName, latitude, longitude, timestamp } = data;
    console.log(`${colors.green}✅ Evento → confirm_help:${colors.reset}`, { emergencyUserId, helperId, helperName });

    if (!emergencyUserId || !helperId) {
      return ack?.({ success: false, message: "Datos de ayuda inválidos" });
    }

    // Agregar ayudante a la emergencia (guardamos userIds)
    const helpers = emergencyHelpers.get(emergencyUserId) || new Set();
    helpers.add(helperId);
    emergencyHelpers.set(emergencyUserId, helpers);

    // Notificar al usuario en emergencia (preferimos socketId si lo tenemos)
    const emergencyAlert = emergencyAlerts.get(emergencyUserId);
    const payloadConfirmed = {
      emergencyUserId,
      helperId,
      helperName,
      latitude,
      longitude,
      timestamp: timestamp || Date.now()
    };

    if (emergencyAlert && emergencyAlert.socketId) {
      io.to(emergencyAlert.socketId).emit("help_confirmed", payloadConfirmed);
    } else {
      // Fallback por userId → TODOS sus sockets
      emitToUser(emergencyUserId, "help_confirmed", payloadConfirmed);
    }

    // Notificar a todos los ayudantes (menos el que recién confirmó) con su ubicación
    helpers.forEach(hUserId => {
      if (hUserId !== helperId) {
        emitToUser(hUserId, "helper_location_update", {
          userId: helperId,
          userName: helperName,
          latitude,
          longitude,
          timestamp: timestamp || Date.now()
        });
      }
    });

    // Notificación global para cerrar banners/toasts en otros clientes
    io.emit("helper_confirmed_notification", {
      emergencyUserId,
      helperId,
      helperName,
      timestamp: timestamp || Date.now()
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
  // 🛑 Cancelar emergencia - MEJORADO
  // ============================================================
  socket.on("cancel_emergency", async (data = {}, ack) => {
    try {
      const { userId } = data;
      console.log(`${colors.blue}🛑 Evento → cancel_emergency:${colors.reset}`, { userId });

      if (!userId) {
        return ack?.({ success: false, message: "userId requerido" });
      }

      // 🆕 Buscar y eliminar sala de emergencia asociada
      let emergencyRoomId = null;
      for (const [roomId, room] of chatRooms.entries()) {
        if (room.type === "emergency" && room.users.has(userId)) {
          emergencyRoomId = roomId;
          break;
        }
      }

      if (emergencyRoomId) {
        // Notificar a usuarios en la sala
        io.to(emergencyRoomId).emit("emergency_room_closed", {
          roomId: emergencyRoomId,
          message: "Emergencia resuelta - Sala cerrada"
        });

        // Forzar a todos a salir de la sala
        const room = chatRooms.get(emergencyRoomId);
       if (room) {
  room.users.forEach(roomUserId => {
    const userEntry = connectedUsers.get(roomUserId);
    if (userEntry) {
      userEntry.sockets.forEach(socketId => {
        io.sockets.sockets.get(socketId)?.leave(emergencyRoomId);
      });
    }
  });
}

        // Eliminar sala
        chatRooms.delete(emergencyRoomId);
        console.log(`${colors.blue}🛑 Sala de emergencia eliminada: ${emergencyRoomId}${colors.reset}`);
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
  // 🔴 Desconexión - MEJORADO
  // ============================================================
  socket.on("disconnect", (reason) => {
    const userId = socket.userId;
    const username = socket.username;
    const currentRoom = socket.currentRoom;
    
    console.log(`${colors.red}🔌 Socket desconectado:${colors.reset} ${username || socket.id} (${reason})`);

    if (userId) {
      const entry = connectedUsers.get(userId);
      if (entry) {
        entry.sockets.delete(socket.id);
        if (entry.sockets.size === 0) {
          connectedUsers.delete(userId);
          
          // 🆕 Remover usuario de todas las salas
          chatRooms.forEach(room => {
            room.users.delete(userId);
          });

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

      // 🆕 Notificar salida de la sala actual
      if (currentRoom) {
        socket.to(currentRoom).emit("user_left_room", {
          userId: userId,
          username: username,
          roomId: currentRoom,
          message: `${username} se desconectó`,
          timestamp: Date.now()
        });

        // 🆕 Actualizar lista de usuarios en la sala
        updateRoomUserList(currentRoom);
      }
    }

    // Actualizar lista global de usuarios
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
  console.log(`${colors.blue}💬 Sistema de salas activo${colors.reset}`);
  console.log(`${colors.green}🏪 Salas disponibles:${colors.reset}`);
  Array.from(chatRooms.values()).forEach(room => {
    console.log(`${colors.green}   - ${room.name} (${room.id})${colors.reset}`);
  });
  console.log(`${colors.red}🚨 Sistema de Emergencia activo${colors.reset}`);
  console.log(`${colors.green}🚗 Soporte para vehículos activo${colors.reset}`);
  console.log(`${colors.magenta}🎧 Soporte para audio activo${colors.reset}`);
  console.log(`${colors.magenta}📍 Filtrado por ubicación activo (50km)${colors.reset}`);
});