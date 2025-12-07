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
// 🗄️ MANEJO DE ARCHIVOS - STORAGE
// ============================================================
const storageService = {
  // Subir avatar desde DataURL
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

      // Limpiar avatares antiguos
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

  // Subir foto de vehículo
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

  // Guardar audio en Storage
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

// Obtener todas las salas disponibles
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

// Obtener información de una sala específica
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

// Obtener emergencias activas
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

// Obtener ayudantes de una emergencia
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
// 🚗 ENDPOINTS PARA VEHÍCULOS - ACTUALIZADOS
// ============================================================

// Obtener todos los vehículos de un usuario
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
        // Compatibilidad: nuevos nombres + viejos nombres
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
        // Campos específicos por tipo
        ...(data.type === 'CAR' && {
          doors: data.doors
        }),
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

// Obtener un vehículo específico por ID
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
      // Compatibilidad: nuevos nombres + viejos nombres
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
      // Campos específicos por tipo
      ...(data.type === 'CAR' && {
        doors: data.doors
      }),
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

// Crear o actualizar vehículo
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
      // Actualizar vehículo existente
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
      // Crear nuevo vehículo
      const userVehicles = await db.collection(COLLECTIONS.VEHICLES)
        .where("userId", "==", vehicleData.userId)
        .where("isActive", "==", true)
        .get();

      const newVehicle = {
        ...vehicleData,
        createdAt: now,
        updatedAt: now,
        isActive: true,
        isPrimary: userVehicles.empty // Primer vehículo es primario
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

// Eliminar vehículo (soft delete)
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

// Establecer vehículo como primario
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

    // Quitar estado primario de todos los vehículos del usuario
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

    // Establecer nuevo vehículo como primario
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

// Subir foto de vehículo
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

    // Actualizar vehículo con la nueva URL de foto
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
      const userDoc = db.collection(COLLECTIONS.USERS).doc(userId);
      await userDoc.set({ ...user, isOnline: true, lastLogin: Date.now() }, { merge: true });
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
  // 🚪 MANEJO DE SALAS
  // ============================================================
socket.on("join_room", async (data = {}, ack) => {
  try {
    const { roomId, userId, username } = data;

    if (!roomId || !userId) {
      ack?.({ success: false, message: "roomId y userId son requeridos" });
      return;
    }

    const targetRoom = state.chatRooms.get(roomId);
    if (!targetRoom) {
      ack?.({ success: false, message: `Sala ${roomId} no encontrada`, roomId });
      return;
    }

    // 🔹 Dejar sala anterior si existe
    if (socket.currentRoom && socket.currentRoom !== roomId) {
      const previousRoom = state.chatRooms.get(socket.currentRoom);
      if (previousRoom) {
        previousRoom.users.delete(userId);
      }

      socket.leave(socket.currentRoom);

      socket.to(socket.currentRoom).emit("user_left_room", {
        userId,
        username,
        roomId: socket.currentRoom,
        message: `${username} salió de la sala`,
        timestamp: Date.now()
      });

      utils.updateRoomUserList(socket.currentRoom);
    }

    // 🔹 Unirse a nueva sala
    socket.join(roomId);
    socket.currentRoom = roomId;
    targetRoom.users.add(userId);

    // 🔹 Enviar historial de mensajes
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

    // 🔹 Notificar a otros en la sala
    socket.to(roomId).emit("user_joined_room", {
      userId,
      username,
      roomId,
      message: `${username} se unió a la sala`,
      timestamp: Date.now(),
    });

    // 🔹 Actualizar lista de usuarios
    utils.updateRoomUserList(roomId);

    // ✅ AHORA SÍ: responder a Android
    ack?.({
      success: true,
      roomId,
      message: `Unido a sala ${roomId}`,
    });

  } catch (err) {
    console.error("❌ Error en join_room:", err);
    ack?.({ success: false, message: "Error interno en join_room" });
  }
});

  socket.on("leave_room", async (data = {}, ack) => {
    const { roomId, userId } = data;
    
    if (!roomId) {
      return ack?.({ success: false, message: "❌ Sala no especificada" });
    }

    console.log(`${colors.blue}🚪 leave_room:${colors.reset} ${socket.username} → ${roomId}`);

    try {
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
  // 💬 MENSAJES DE TEXTO
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

      io.to(roomId).emit("audio_message", message);
      socket.emit("message_sent", { id: message.id, ...message });

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
  // 👥 SOLICITUDES DE INFORMACIÓN
  // ============================================================
  socket.on("request_user_list", (data = {}, ack) => {
    const { roomId } = data;
    
    if (!roomId) {
      return ack?.({ success: false, message: "❌ Sala no especificada" });
    }

    try {
      const room = state.chatRooms.get(roomId);
      if (!room) {
        return ack?.({ success: false, message: "Sala no encontrada" });
      }

      const usersInRoom = Array.from(room.users).map(userId => {
        const userInfo = state.connectedUsers.get(userId);
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

  socket.on("request_available_rooms", (data = {}, ack) => {
    try {
      const roomsArray = Array.from(state.chatRooms.values()).map(room => ({
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
  // Reusar la lógica de request_user_list
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
  // 🚨 SISTEMA DE EMERGENCIAS - ACTUALIZADO
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
        return ack?.({ success: false, message: "Datos de usuario inválidos" });
      }

      if (typeof latitude !== "number" || typeof longitude !== "number") {
        console.warn(`${colors.yellow}⚠️ Coordenadas inválidas${colors.reset}`);
        return ack?.({ success: false, message: "Ubicación inválida" });
      }

      // ========================================================
      // 👤 AVATAR DEL USUARIO
      // ========================================================
      let avatarUrl = null;
      try {
        const userDoc = await db.collection(COLLECTIONS.USERS).doc(userId).get();
        if (userDoc.exists) {
          const userData = userDoc.data();
          avatarUrl = userData?.avatarUrl || userData?.avatarUri || null;

          console.log(`${colors.green}✅ Avatar obtenido:${colors.reset}`, {
            userId: userId,
            avatarUrl: avatarUrl ? `✅ Presente` : "❌ Ausente",
            esUrlValida: avatarUrl ? avatarUrl.startsWith("http") : false,
          });
        }
      } catch (e) {
        console.warn(
          `${colors.yellow}⚠️ Error obteniendo avatar:${colors.reset} ${e.message}`
        );
      }

      // ========================================================
      // 🚗 VEHÍCULO PRIMARIO ASOCIADO (con compatibilidad vieja/nueva)
      // ========================================================
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
            // nombres comunes
            name: vehiculo.name || vehiculo.nombre || null,
            brand: vehiculo.brand || vehiculo.marca || null,
            model: vehiculo.model || vehiculo.modelo || null,
            year: vehiculo.year || null,
            color: vehiculo.color || null,
            licensePlate: vehiculo.licensePlate || vehiculo.patente || null,
            photoUri: vehiculo.photoUri || vehiculo.fotoVehiculoUri || null,
            // extras por tipo (si existen)
            ...(typeRaw === "CAR" && {
              doors: vehiculo.doors,
            }),
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

          console.log(`${colors.green}✅ Vehículo primario asociado:${colors.reset}`, {
            id: vehicleData.id,
            tipo: vehicleData.type,
            nombre: vehicleData.name,
            marca: vehicleData.brand,
            patente: vehicleData.licensePlate,
            fotoUri: vehicleData.photoUri ? "✅" : "❌",
          });
        } else {
          console.log(
            `${colors.yellow}⚠️ Usuario sin vehículo primario activo${colors.reset}`
          );
        }
      } catch (vehErr) {
        console.warn(
          `${colors.yellow}⚠️ Error obteniendo vehículo:${colors.reset} ${vehErr.message}`
        );
      }

      // ========================================================
      // 🧩 DATOS COMPLETOS DE EMERGENCIA
      // ========================================================
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
        console.log(
          `${colors.green}✅ Emergencia registrada en Firestore${colors.reset}`
        );
      } catch (fireErr) {
        console.error(
          `${colors.red}❌ Error guardando emergencia:${colors.reset}`,
          fireErr.message
        );
      }

      // ========================================================
      // 💬 CREAR SALA DE EMERGENCIA
      // ========================================================
      const createdAt = Date.now();
      const emergencyRoomId = `emergencia_${userId}`;

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

      console.log(
        `${colors.red}🚨 Sala de emergencia creada: ${emergencyRoomId}${colors.reset}`
      );

      // ========================================================
      // 📍 DEBUG DE USUARIOS CONECTADOS + FILTRO POR UBICACIÓN
      // ========================================================
      console.log(
        "📊 connectedUsers size:",
        state.connectedUsers.size
      );
      console.log(
        "📊 connectedUsers detalle:",
        Array.from(state.connectedUsers.entries()).map(([uid, info]) => ({
          userId: uid,
          sockets: Array.from(info.sockets || []),
          lastKnownLocation: info.userData?.lastKnownLocation || null,
        }))
      );

      const nearbyUsers = utils.getNearbyUsers(latitude, longitude, 50);
      console.log(
        `${colors.blue}👥 Usuarios a notificar: ${nearbyUsers.length}${colors.reset}`
      );

      // ========================================================
      // 📢 ENVIAR ALERTA A USUARIOS CERCANOS
      // ========================================================
      let notifiedCount = 0;
      nearbyUsers.forEach((nearbySocketId) => {
        if (nearbySocketId !== socket.id) {
          io.to(nearbySocketId).emit("emergency_alert", {
            ...emergencyData,
            emergencyRoomId,
          });
          notifiedCount++;
        }
      });

      console.log(
        `${colors.red}📢 ALERTA DIFUNDIDA:${colors.reset} ${userName} → ${notifiedCount}/${nearbyUsers.length} usuarios`
      );

      io.emit("emergency_alert", {
  ...emergencyData,
  emergencyRoomId,
});

      // Respuesta al cliente que originó la emergencia
      ack?.({
        success: true,
        message: "Alerta de emergencia enviada correctamente",
        vehicle: vehicleData,
        avatarUrl: avatarUrl,
        notifiedUsers: notifiedCount,
        totalNearbyUsers: nearbyUsers.length,
        emergencyRoomId,
      });
    } catch (error) {
      console.error(
        `${colors.red}❌ Error en emergency_alert:${colors.reset}`,
        error
      );
      ack?.({
        success: false,
        message: error.message,
        errorDetails: "Error procesando alerta de emergencia",
      });
    }
  });

  socket.on("update_emergency_location", async (data = {}, ack) => {
    try {
      const { userId, userName, latitude, longitude, timestamp } = data;

      if (!userId) {
        return ack?.({ success: false, message: "userId requerido" });
      }

      const existingAlert = state.emergencyAlerts.get(userId);
      if (existingAlert) {
        existingAlert.latitude = latitude;
        existingAlert.longitude = longitude;
        existingAlert.timestamp = timestamp || Date.now();
      }

      const helpers = state.emergencyHelpers.get(userId) || new Set();
      helpers.forEach(helperUserId => {
        utils.emitToUser(helperUserId, "helper_location_update", {
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

  socket.on("confirm_help", async (data = {}, ack) => {
    try {
      const { emergencyUserId, helperId, helperName, latitude, longitude, timestamp } = data;
      console.log(`${colors.green}✅ Evento → confirm_help:${colors.reset}`, { emergencyUserId, helperId, helperName });

      if (!emergencyUserId || !helperId) {
        return ack?.({ success: false, message: "Datos de ayuda inválidos" });
      }

      const helpers = state.emergencyHelpers.get(emergencyUserId) || new Set();
      helpers.add(helperId);
      state.emergencyHelpers.set(emergencyUserId, helpers);

      const emergencyAlert = state.emergencyAlerts.get(emergencyUserId);
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
        utils.emitToUser(emergencyUserId, "help_confirmed", payloadConfirmed);
      }

      helpers.forEach(hUserId => {
        if (hUserId !== helperId) {
          utils.emitToUser(hUserId, "helper_location_update", {
            userId: helperId,
            userName: helperName,
            latitude,
            longitude,
            timestamp: timestamp || Date.now()
          });
        }
      });

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

  socket.on("reject_help", async (data = {}, ack) => {
    try {
      const { emergencyUserId, helperId, helperName } = data;
      console.log(`${colors.yellow}❌ Evento → reject_help:${colors.reset}`, { emergencyUserId, helperId, helperName });

      if (!emergencyUserId || !helperId) {
        return ack?.({ success: false, message: "Datos inválidos" });
      }

      const helpers = state.emergencyHelpers.get(emergencyUserId);
      if (helpers) {
        helpers.delete(helperId);
      }

      const emergencyAlert = state.emergencyAlerts.get(emergencyUserId);
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

  socket.on("cancel_emergency", async (data = {}, ack) => {
    try {
      const { userId } = data;
      console.log(`${colors.blue}🛑 Evento → cancel_emergency:${colors.reset}`, { userId });

      if (!userId) {
        return ack?.({ success: false, message: "userId requerido" });
      }

      const emergencyRoomId = state.emergencyUserRoom.get(userId);

      if (emergencyRoomId && state.chatRooms.has(emergencyRoomId)) {
        io.to(emergencyRoomId).emit("emergency_room_closed", {
          roomId: emergencyRoomId,
          message: "Emergencia resuelta - Sala cerrada"
        });

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
        console.log(`${colors.blue}🛑 Sala de emergencia eliminada: ${emergencyRoomId}${colors.reset}`);
      }

      state.emergencyAlerts.delete(userId);
      state.emergencyHelpers.delete(userId);

      await db.collection(COLLECTIONS.EMERGENCIES).doc(userId).set({
        status: "cancelled",
        cancelledAt: Date.now()
      }, { merge: true });

      io.emit("emergency_cancelled", { userId });

      console.log(`${colors.blue}🛑 Emergencia cancelada para usuario: ${userId}${colors.reset}`);
      ack?.({ success: true, message: "Emergencia cancelada" });
    } catch (error) {
      console.error(`${colors.red}❌ Error en cancel_emergency:${colors.reset}`, error);
      ack?.({ success: false, message: error.message });
    }
  });

  socket.on("request_helpers", async (data = {}, ack) => {
    try {
      const { emergencyUserId } = data;
      console.log(`${colors.cyan}👥 Evento → request_helpers:${colors.reset}`, { emergencyUserId });

      if (!emergencyUserId) {
        return ack?.({ success: false, message: "emergencyUserId requerido" });
      }

      const helpers = state.emergencyHelpers.get(emergencyUserId) || new Set();
      const helpersArray = Array.from(helpers);

      const helpersInfo = [];
      for (const helperId of helpersArray) {
        const helperEntry = state.connectedUsers.get(helperId);
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
  // 🔴 DESCONEXIÓN
  // ============================================================
  socket.on("disconnect", (reason) => {
    const userId = socket.userId;
    const username = socket.username;
    const currentRoom = socket.currentRoom;
    
    console.log(`${colors.red}🔌 Socket desconectado:${colors.reset} ${username || socket.id} (${reason})`);

    if (userId) {
      const entry = state.connectedUsers.get(userId);
      if (entry) {
        entry.sockets.delete(socket.id);
        if (entry.sockets.size === 0) {
          state.connectedUsers.delete(userId);
          
          state.chatRooms.forEach(room => {
            room.users.delete(userId);
          });

          if (state.emergencyAlerts.has(userId)) {
            state.emergencyAlerts.delete(userId);
            state.emergencyHelpers.delete(userId);
            io.emit("emergency_cancelled", { userId });
            console.log(`${colors.red}🚨 Emergencia cancelada por desconexión de ${username}${colors.reset}`);
          }

          const er = state.emergencyUserRoom.get(userId);
          if (er && state.chatRooms.has(er)) {
            state.chatRooms.delete(er);
            state.emergencyUserRoom.delete(userId);
          }
          
          console.log(`${colors.red}🔴 Usuario ${username} completamente desconectado.${colors.reset}`);
        }
      }

      if (currentRoom) {
        socket.to(currentRoom).emit("user_left_room", {
          userId: userId,
          username: username,
          roomId: currentRoom,
          message: `${username} se desconectó`,
          timestamp: Date.now()
        });

        utils.updateRoomUserList(currentRoom);
      }
    }

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
  console.log(`${colors.green}🏪 Salas disponibles:${colors.reset}`);
  Array.from(state.chatRooms.values()).forEach(room => {
    console.log(`${colors.green}   - ${room.name} (${room.id})${colors.reset}`);
  });
  console.log(`${colors.red}🚨 Sistema de Emergencia activo${colors.reset}`);
  console.log(`${colors.green}🚗 Gestión de Vehículos activa${colors.reset}`);
  console.log(`${colors.magenta}🎧 Soporte para audio activo${colors.reset}`);
  console.log(`${colors.magenta}📍 Filtrado por ubicación activo (50km)${colors.reset}`);
});