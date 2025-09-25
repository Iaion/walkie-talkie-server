// server.js - CÓDIGO CORREGIDO PARA RAILWAY

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os'); 
const { Buffer } = require('buffer'); // ✅ NUEVO: Importar Buffer para manejar datos binarios

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ CAMBIO CRÍTICO: Obtener la URL del entorno de Railway o usar localhost para desarrollo.
// Utiliza process.env.RAILWAY_STATIC_URL o una similar para producción.
const SERVER_BASE_URL = process.env.RAILWAY_STATIC_URL || `http://localhost:${PORT}`;


// Middleware
app.use(cors({
    origin: "*", 
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
}));
app.use(express.json());

// Crear servidor HTTP con Express
const httpServer = http.createServer(app);

// Configuración mejorada de Socket.IO con CORS
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        allowedHeaders: ["Content-Type"],
        credentials: true
    },
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000
});

// Almacenar usuarios conectados y salas
const users = new Map();
const roomUsers = new Map();

// --- Manejo de Archivos Estáticos de Audio ---
const audioDir = path.join(__dirname, 'uploads/audio');
if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
}

// ✅ CORRECCIÓN 2: Middleware para servir archivos de audio
app.use('/uploads/audio', express.static(audioDir));

// --- Rutas de Express para monitoreo y estado ---
app.get('/', (req, res) => {
    res.json({
        message: 'Servidor de A2Intento funcionando correctamente',
        status: 'online',
        timestamp: new Date().toISOString(),
        connectedUsers: Array.from(users.values()).length,
        activeRooms: Array.from(roomUsers.keys()),
        totalSockets: io.engine.clientsCount
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        connected: io.engine.clientsCount
    });
});

app.get('/users', (req, res) => {
    const room = req.query.room || 'general';
    const roomUsersList = roomUsers.has(room) 
        ? Array.from(roomUsers.get(room))
            .map(id => users.get(id))
            .filter(user => user !== undefined && user !== null)
        : [];
    
    res.json({
        room: room,
        users: roomUsersList,
        count: roomUsersList.length
    });
});

// Endpoint para debugging de conexiones
app.get('/debug', (req, res) => {
    res.json({
        totalSockets: io.engine.clientsCount,
        users: Array.from(users.entries()).map(([id, user]) => ({
            socketId: id,
            user: user
        })),
        rooms: Array.from(roomUsers.entries()).map(([room, sockets]) => ({
            room: room,
            userCount: sockets.size,
            users: Array.from(sockets).map(socketId => users.get(socketId))
        }))
    });
});

// --- Manejar eventos de conexión de Socket.IO ---
io.on('connection', (socket) => {
    console.log('✅ Usuario conectado:', socket.id);
    
    // ... [Tu código de 'join_general_chat', 'send_message', 'audio_message', 
    // y eventos WebRTC está correcto y lo omito aquí por brevedad] ...
    
    socket.emit('connection_established', { 
        socketId: socket.id, 
        message: 'Conexión establecida correctamente',
        timestamp: new Date().toISOString()
    });

    // Tu código de 'join_general_chat' (1)
    socket.on('join_general_chat', (userName) => {
        try {
            // Almacenar información del usuario
            users.set(socket.id, {
                userName: userName,
                room: 'general',
                id: socket.id,
                joinedAt: new Date().toISOString()
            });
            
            socket.join('general');
            
            if (!roomUsers.has('general')) {
                roomUsers.set('general', new Set());
            }
            
            roomUsers.get('general').add(socket.id);
            
            console.log(`👤 ${userName} se unió al chat general (Socket: ${socket.id})`);
            
            socket.to('general').emit('user_joined', userName);
            
            const userList = Array.from(roomUsers.get('general'))
                .map(id => {
                    const user = users.get(id);
                    return user ? user.userName : null;
                })
                .filter(name => name !== null && name !== undefined);
            
            socket.emit('users_list', userList);
            io.to('general').emit('users_list', userList);
            
            socket.emit('join_success', {
                message: `Te has unido al chat general como ${userName}`,
                users: userList
            });
            
        } catch (error) {
            console.error('Error en join_general_chat:', error);
            socket.emit('error', { message: 'Error al unirse al chat' });
        }
    });

    // Tu código de 'send_message' (2)
    socket.on('send_message', (messageData) => {
        try {
            const userInfo = users.get(socket.id);
            if (userInfo) {
                const receivedText = messageData.text;

                const finalMessage = {
                    id: socket.id + '-' + Date.now(), 
                    text: receivedText, 
                    username: userInfo.userName,
                    userId: userInfo.id,
                    timestamp: Date.now(),
                    roomId: userInfo.room
                };
                io.to(userInfo.room).emit('new_message', finalMessage);
                
                console.log(`💬 [${userInfo.room}] ${userInfo.userName}: ${receivedText}`);
            }
        } catch (error) {
            console.error('Error en send_message:', error);
        }
    });

    // Tu código de 'audio_message' (3)
    socket.on('audio_message', (audioMessageData) => {
    try {
        const userInfo = users.get(socket.id);
        if (!userInfo) {
            console.error('Error: Usuario no encontrado para el socket:', socket.id);
            return;
        }

        const audioBase64 = audioMessageData.audioData;
        const audioBuffer = Buffer.from(audioBase64, 'base64');
        
        const filename = `audio_${Date.now()}.mp3`; 
        const filePath = path.join(audioDir, filename);

        fs.writeFile(filePath, audioBuffer, (err) => {
            if (err) {
                console.error('Error al guardar el archivo de audio:', err);
                return;
            }
            console.log(`✅ Archivo de audio guardado: ${filePath}`);

            // ✅ CORRECCIÓN CLAVE: Usar la URL base del servidor de Railway
            const audioUrl = `${SERVER_BASE_URL}/uploads/audio/${filename}`;
            
            const finalMessage = {
                id: socket.id + '-' + Date.now(),
                audioUrl: audioUrl, 
                username: userInfo.userName,
                userId: userInfo.id,
                timestamp: Date.now(),
                roomId: userInfo.room
            };

            io.to(userInfo.room).emit('new_message', finalMessage);
            console.log(`🎙️ [${userInfo.room}] ${userInfo.userName} envió un audio.`);
        });

    } catch (error) {
        console.error('Error en audio_message:', error);
    }
});

    // Tu código de señalización WebRTC (4, 5, 6, 7)

    // Tu código de ping/pong (8)
    socket.on('ping', () => {
        socket.emit('pong', { timestamp: Date.now() });
    });

    // Tu código de desconexión (9)
    socket.on('disconnect', (reason) => {
        const userInfo = users.get(socket.id);
        if (userInfo) {
            console.log(`❌ Usuario desconectado: ${userInfo.userName} (Razón: ${reason})`);
            
            if (userInfo.room && roomUsers.has(userInfo.room)) {
                roomUsers.get(userInfo.room).delete(socket.id);
                
                socket.to(userInfo.room).emit('user_left', {
                    userName: userInfo.userName,
                    reason: reason,
                    timestamp: Date.now()
                });
                
                const roomUserList = Array.from(roomUsers.get(userInfo.room))
                    .map(id => {
                        const user = users.get(id);
                        return user ? user.userName : null;
                    })
                    .filter(name => name !== null && name !== undefined);
                
                io.to(userInfo.room).emit('users_list', roomUserList);
            }
            
            users.delete(socket.id);
        } else {
            console.log(`❌ Socket desconectado: ${socket.id} (Razón: ${reason})`);
        }
    });

    // Tu código de error de socket (10)
    socket.on('error', (error) => {
        console.error(`❌ Error en socket ${socket.id}:`, error);
    });
});

// Middleware para manejar rutas no encontradas
app.use('*', (req, res) => {
    res.status(404).json({
        error: 'Ruta no encontrada',
        availableEndpoints: {
            GET: ['/', '/health', '/users', '/debug', '/uploads/audio/*']
        }
    });
});

// Manejo de errores global
process.on('uncaughtException', (error) => {
    console.error('❌ Error no capturado:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promesa rechazada no manejada:', reason);
});

// Manejar cierre graceful del servidor
process.on('SIGINT', () => {
    console.log('\n🛑 Recibida señal SIGINT. Cerrando servidor...');
    
    io.close(() => {
        console.log('✅ Socket.IO cerrado');
        httpServer.close(() => {
            console.log('✅ Servidor HTTP cerrado');
            process.exit(0);
        });
    });
});

httpServer.listen(PORT, () => {
    console.log(`🚀 Servidor Express con Socket.IO ejecutándose en el puerto ${PORT}`);
    console.log(`📍 URL local: http://localhost:${PORT}`);
    console.log(`📍 URL red: http://${getLocalIP()}:${PORT}`);
    console.log(`📊 Estado: http://localhost:${PORT}/health`);
    console.log(`👥 Usuarios: http://localhost:${PORT}/users`);
    console.log(`🐛 Debug: http://localhost:${PORT}/debug`);
    console.log(`💬 Funcionalidades implementadas:`);
    console.log(`   - Chat en tiempo real`);
    console.log(`   - Lista de usuarios conectados`);
    console.log(`   - WebRTC para llamadas de voz`);
    console.log(`   - Compartir audio`);
    console.log(`   - API REST para monitoreo`);
    console.log(`   - CORS configurado para desarrollo`);
});

// Función para obtener la IP local
function getLocalIP() {
    const interfaces = os.networkInterfaces(); 
    for (const interfaceName in interfaces) {
        const addresses = interfaces[interfaceName];
        for (const address of addresses) {
            if (address.family === 'IPv4' && !address.internal) {
                return address.address;
            }
        }
    }
    return 'localhost';
}