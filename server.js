const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Buffer } = require('buffer');
const {
    initializeApp,
    applicationDefault,
    getApps
} = require('firebase-admin/app');
const {
    getStorage
} = require('firebase-admin/storage');

const app = express();
const PORT = process.env.PORT || 3000;

const SERVER_BASE_URL = process.env.RAILWAY_STATIC_URL || `http://localhost:${PORT}`;

// ✅ Middleware
app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
}));
app.use(express.json());

// ✅ Inicializar Firebase Admin SDK si no está inicializado
if (!getApps().length) {
    initializeApp({
        credential: applicationDefault(),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET
    });
}
const storage = getStorage();

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        allowedHeaders: ["Content-Type"],
        credentials: true
    },
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e8 // Aumenta el buffer a 100MB
});

const users = new Map();
const roomUsers = new Map();

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
    
    socket.emit('connection_established', { 
        socketId: socket.id, 
        message: 'Conexión establecida correctamente',
        timestamp: new Date().toISOString()
    });

    socket.on('join_general_chat', (userName) => {
        try {
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

    // ✅ Nuevo: Escuchar por mensajes de audio y subirlos a Firebase Storage
    socket.on('audio_message', async (data) => {
        try {
            const {
                roomId,
                userId,
                username,
                audioData,
                timestamp
            } = data;
            const filename = `audio_${Date.now()}.mp3`;

            const audioBuffer = Buffer.from(audioData, 'base64');
            const file = storage.bucket().file(`uploads/audio/${filename}`);

            await file.save(audioBuffer, {
                metadata: {
                    contentType: 'audio/mpeg',
                },
                public: true
            });

            const [publicUrl] = await file.getSignedUrl({
              action: 'read',
              expires: '03-09-2491'
            });
            
            console.log(`🎙️ [${roomId}] Audio subido a Firebase Storage: ${publicUrl}`);

            const audioMessage = {
                id: socket.id,
                userId,
                username,
                roomId,
                timestamp,
                audioUrl: publicUrl
            };
            io.to(roomId).emit('new_message', audioMessage);

        } catch (error) {
            console.error('❌ Error al procesar el mensaje de audio:', error.message);
        }
    });

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

    socket.on('error', (error) => {
        console.error(`❌ Error en socket ${socket.id}:`, error);
    });
});

app.use('*', (req, res) => {
    res.status(404).json({
        error: 'Ruta no encontrada',
        availableEndpoints: {
            GET: ['/', '/health', '/users', '/debug']
        }
    });
});

process.on('uncaughtException', (error) => {
    console.error('❌ Error no capturado:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promesa rechazada no manejada:', reason);
});

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
    console.log(`   - Compartir audio`);
    console.log(`   - API REST para monitoreo`);
    console.log(`   - CORS configurado para desarrollo`);
});

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
