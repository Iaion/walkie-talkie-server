// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
// ... Importaciones y configuración de Socket.IO ...
const fs = require('fs');
const path = require('path');

// Middleware
app.use(cors({
    origin: "*", // Permite todas las origins (en producción restringe esto)
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
    // Configuración adicional para mejor compatibilidad
    allowEIO3: true, // Compatibilidad con clientes más antiguos
    pingTimeout: 60000,
    pingInterval: 25000
});

// Almacenar usuarios conectados y salas
const users = new Map(); // socket.id -> {userName, room}
const roomUsers = new Map(); // room -> [socketIds]

const audioDir = path.join(__dirname, 'uploads/audio');
if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
}

// Rutas de Express para verificar el estado del servidor
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

server.listen(PORT, () => {
    console.log(`Servidor de chat ejecutándose en el puerto ${PORT}`);
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

// Manejar eventos de conexión de Socket.IO
io.on('connection', (socket) => {
    console.log('✅ Usuario conectado:', socket.id);
    
    // Evento para debugging - confirmar que la conexión se estableció
    socket.emit('connection_established', { 
        socketId: socket.id, 
        message: 'Conexión establecida correctamente',
        timestamp: new Date().toISOString()
    });

    // 1. Unirse al chat general
    socket.on('join_general_chat', (userName) => {
        try {
            // Almacenar información del usuario
            users.set(socket.id, {
                userName: userName,
                room: 'general',
                id: socket.id,
                joinedAt: new Date().toISOString()
            });
            
            // Unir al usuario a la sala general
            socket.join('general');
            
            // Inicializar lista de usuarios para la sala general si no existe
            if (!roomUsers.has('general')) {
                roomUsers.set('general', new Set());
            }
            
            // Agregar usuario a la sala general
            roomUsers.get('general').add(socket.id);
            
            console.log(`👤 ${userName} se unió al chat general (Socket: ${socket.id})`);
            
            // Notificar a todos en la sala general
            socket.to('general').emit('user_joined', userName);
            
            // Enviar lista actualizada de usuarios al nuevo usuario
            const userList = Array.from(roomUsers.get('general'))
                .map(id => {
                    const user = users.get(id);
                    return user ? user.userName : null;
                })
                .filter(name => name !== null && name !== undefined);
            
            socket.emit('users_list', userList);
            
            // Enviar lista actualizada a todos en la sala general
            io.to('general').emit('users_list', userList);
            
            // Confirmación al usuario
            socket.emit('join_success', {
                message: `Te has unido al chat general como ${userName}`,
                users: userList
            });
            
        } catch (error) {
            console.error('Error en join_general_chat:', error);
            socket.emit('error', { message: 'Error al unirse al chat' });
        }
    });

    // 2. Enviar mensaje de chat
    socket.on('send_message', (messageData) => {
    try {
        const userInfo = users.get(socket.id);
        if (userInfo) {
            // ✅ CORRECCIÓN 1: Leer el mensaje desde la clave "text" que el cliente envía.
            const receivedText = messageData.text;

            // ✅ CORRECCIÓN 2: Construir un objeto final con todas las claves que el cliente espera.
            const finalMessage = {
                // Genera un ID único para cada mensaje.
                id: socket.id + '-' + Date.now(), 
                // El texto del mensaje que acabamos de recibir.
                text: receivedText, 
                // El nombre de usuario.
                username: userInfo.userName,
                // El ID del usuario.
                userId: userInfo.id,
                // El timestamp del mensaje.
                timestamp: Date.now(),
                // El ID de la sala.
                roomId: userInfo.room
            };

            // ✅ CORRECCIÓN 3: Emitir el objeto completo a todos en la sala usando el evento "new_message".
            io.to(userInfo.room).emit('new_message', finalMessage);
            
            console.log(`💬 [${userInfo.room}] ${userInfo.userName}: ${receivedText}`);
        }
    } catch (error) {
        console.error('Error en send_message:', error);
    }
});

    // 3. Manejar mensaje de audio
socket.on('audio_message', (audioMessageData) => {
    try {
        const userInfo = users.get(socket.id);
        if (!userInfo) {
            console.error('Error: Usuario no encontrado para el socket:', socket.id);
            return;
        }

        const audioBytes = audioMessageData.audioData;
        const filename = `audio_${Date.now()}.mp3`;
        const filePath = path.join(audioDir, filename);
        
        // Escribir los bytes en un archivo
        fs.writeFile(filePath, Buffer.from(audioBytes), (err) => {
            if (err) {
                console.error('Error al guardar el archivo de audio:', err);
                return;
            }
            console.log(`✅ Archivo de audio guardado: ${filePath}`);

            const audioUrl = `/uploads/audio/${filename}`; // URL pública para el archivo
            
            // Crear el objeto de mensaje final para todos los clientes
            const finalMessage = {
                id: socket.id + '-' + Date.now(),
                // ✅ Usamos la clave 'audioUrl' para indicar que es un mensaje de audio
                audioUrl: audioUrl,
                username: userInfo.userName,
                userId: userInfo.id,
                timestamp: Date.now(),
                roomId: userInfo.room
            };

            // Enviar el mensaje de audio a todos en la sala
            io.to(userInfo.room).emit('new_message', finalMessage);
            console.log(`🎙️ [${userInfo.room}] ${userInfo.userName} envió un audio.`);
        });

    } catch (error) {
        console.error('Error en audio_message:', error);
    }
});

    // 4. Señalización WebRTC entre pares
    socket.on('senal', (data) => {
        try {
            console.log(`📶 Señal de ${socket.id} para ${data.destino}`);
            // Reenvía la señal al usuario específico
            socket.to(data.destino).emit('senal', { 
                ...data, 
                origen: socket.id,
                timestamp: Date.now()
            });
        } catch (error) {
            console.error('Error en senal:', error);
        }
    });

    // 5. WebRTC - Oferta
    socket.on('offer', (offerData) => {
        try {
            const userInfo = users.get(socket.id);
            if (userInfo) {
                console.log(`📡 Oferta WebRTC de ${userInfo.userName} para ${offerData.target}`);
                // Transmitir oferta al usuario específico
                socket.to(offerData.target).emit('webrtc_offer', {
                    offer: offerData.offer,
                    from: socket.id,
                    userName: userInfo.userName,
                    timestamp: Date.now()
                });
            }
        } catch (error) {
            console.error('Error en offer:', error);
        }
    });

    // 6. WebRTC - Respuesta
    socket.on('answer', (answerData) => {
        try {
            const userInfo = users.get(socket.id);
            if (userInfo) {
                console.log(`📡 Respuesta WebRTC de ${userInfo.userName} para ${answerData.target}`);
                // Transmitir respuesta al usuario específico
                socket.to(answerData.target).emit('webrtc_answer', {
                    answer: answerData.answer,
                    from: socket.id,
                    userName: userInfo.userName,
                    timestamp: Date.now()
                });
            }
        } catch (error) {
            console.error('Error en answer:', error);
        }
    });

    // 7. WebRTC - Candidato ICE
    socket.on('ice-candidate', (candidateData) => {
        try {
            const userInfo = users.get(socket.id);
            if (userInfo) {
                // Transmitir candidato ICE al usuario específico
                socket.to(candidateData.target).emit('webrtc_ice_candidate', {
                    candidate: candidateData.candidate,
                    from: socket.id,
                    userName: userInfo.userName,
                    timestamp: Date.now()
                });
            }
        } catch (error) {
            console.error('Error en ice-candidate:', error);
        }
    });

    // 8. Ping/pong para mantener conexión activa
    socket.on('ping', () => {
        socket.emit('pong', { timestamp: Date.now() });
    });

    // 9. Manejar la desconexión del usuario
    socket.on('disconnect', (reason) => {
        const userInfo = users.get(socket.id);
        if (userInfo) {
            console.log(`❌ Usuario desconectado: ${userInfo.userName} (Razón: ${reason})`);
            
            // Notificar a los usuarios de la sala
            if (userInfo.room && roomUsers.has(userInfo.room)) {
                roomUsers.get(userInfo.room).delete(socket.id);
                
                socket.to(userInfo.room).emit('user_left', {
                    userName: userInfo.userName,
                    reason: reason,
                    timestamp: Date.now()
                });
                
                // Enviar lista actualizada
                const roomUserList = Array.from(roomUsers.get(userInfo.room))
                    .map(id => {
                        const user = users.get(id);
                        return user ? user.userName : null;
                    })
                    .filter(name => name !== null && name !== undefined);
                
                io.to(userInfo.room).emit('users_list', roomUserList);
            }
            
            // Eliminar usuario del mapa
            users.delete(socket.id);
        } else {
            console.log(`❌ Socket desconectado: ${socket.id} (Razón: ${reason})`);
        }
    });

    // 10. Manejar errores de socket
    socket.on('error', (error) => {
        console.error(`❌ Error en socket ${socket.id}:`, error);
    });
});

// Middleware para manejar rutas no encontradas
app.use('*', (req, res) => {
    res.status(404).json({
        error: 'Ruta no encontrada',
        availableEndpoints: {
            GET: ['/', '/health', '/users', '/debug']
        }
    });
});

// Manejo de errores global
process.on('uncaughtException', (error) => {
    console.error('❌ Error no capturado:', error);
    // No cerrar el proceso, continuar ejecutando
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promesa rechazada no manejada:', reason);
});

// Manejar cierre graceful del servidor
process.on('SIGINT', () => {
    console.log('\n🛑 Recibida señal SIGINT. Cerrando servidor...');
    
    // Desconectar todos los sockets
    io.close(() => {
        console.log('✅ Socket.IO cerrado');
        httpServer.close(() => {
            console.log('✅ Servidor HTTP cerrado');
            process.exit(0);
        });
    });
});

// Poner el servidor a escuchar en el puerto
httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor Express con Socket.IO ejecutándose en el puerto ${PORT}`);
    console.log(`📍 URL local: http://localhost:${PORT}`);
    console.log(`📍 URL red: http://${getLocalIP()}:${PORT}`);
    console.log(`📊 Estado: http://localhost:${PORT}/health`);
    console.log(`👥 Usuarios: http://localhost:${PORT}/users`);
    console.log(`🐛 Debug: http://localhost:${PORT}/debug`);
    console.log(`💬 Funcionalidades implementadas:`);
    console.log(`   - Chat en tiempo real`);
    console.log(`   - Lista de usuarios conectados`);
    console.log(`   - WebRTC para llamadas de voz`);
    console.log(`   - Compartir audio`);
    console.log(`   - API REST para monitoreo`);
    console.log(`   - CORS configurado para desarrollo`);
});

// Función para obtener la IP local
function getLocalIP() {
    const interfaces = require('os').networkInterfaces();
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