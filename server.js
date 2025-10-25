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
        
        io.to(nearbySocketId).emit("emergency_alert", emergencyData);
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
      totalNearbyUsers: nearbyUsers.length
    };

    console.log(`${colors.green}✅ Respuesta al emisor:${colors.reset}`, {
      success: response.success,
      notifiedUsers: response.notifiedUsers,
      tieneAvatar: !!response.avatarUrl,
      tieneVehiculo: !!response.vehicle
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
  // ✅ Confirmar ayuda a una emergencia - VERSIÓN CORREGIDA
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
          emergencyUserId,
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

      // 🔥 NUEVO: Notificar a TODOS los usuarios que el ayudante confirmó (para cerrar notificaciones)
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
  console.log(`${colors.magenta}📍 Filtrado por ubicación activo (50km)${colors.reset}`);
});