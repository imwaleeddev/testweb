const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// تتبع الغرف
// rooms[roomId] = { streamer: socketId, viewer: socketId }
const rooms = {};

app.use(cors());
app.get('/', (req, res) => {
    res.send(`
        <h2>LiveStream Signaling Server</h2>
        <p>Status: Running</p>
        <p>Active rooms: ${Object.keys(rooms).length}</p>
        <ul>${Object.entries(rooms).map(([id, r]) =>
            `<li>${id} — streamer: ${r.streamer ? '✓' : '✗'} | viewer: ${r.viewer ? '✓' : '✗'}</li>`
        ).join('')}</ul>
    `);
});

io.on('connection', (socket) => {
    console.log(`[+] Connected: ${socket.id}`);

    // انضمام لغرفة
    socket.on('join-room', (roomId, role) => {
        socket.join(roomId);
        socket.roomId = roomId;
        socket.role = role;

        if (!rooms[roomId]) rooms[roomId] = {};

        if (role === 'player') {
            rooms[roomId].streamer = socket.id;
            console.log(`[Room ${roomId}] Streamer joined`);
        } else if (role === 'viewer') {
            rooms[roomId].viewer = socket.id;
            console.log(`[Room ${roomId}] Viewer joined`);
        }
    });

    // المشاهد جاهز — أخبر الباث
    socket.on('viewer-ready', (roomId) => {
        console.log(`[Room ${roomId}] Viewer ready`);
        socket.to(roomId).emit('viewer-ready');
    });

    // Offer من الباث → المشاهد
    socket.on('offer', (roomId, offer) => {
        console.log(`[Room ${roomId}] Offer sent`);
        socket.to(roomId).emit('offer', offer);
    });

    // Answer من المشاهد → الباث
    socket.on('answer', (roomId, answer) => {
        console.log(`[Room ${roomId}] Answer sent`);
        socket.to(roomId).emit('answer', answer);
    });

    // ICE Candidates
    socket.on('ice-candidate', (roomId, candidate) => {
        socket.to(roomId).emit('ice-candidate', candidate);
    });

    // إنهاء البث
    socket.on('end-stream', (roomId) => {
        console.log(`[Room ${roomId}] Stream ended`);
        socket.to(roomId).emit('stream-ended');
        delete rooms[roomId];
    });

    // قطع الاتصال
    socket.on('disconnect', () => {
        console.log(`[-] Disconnected: ${socket.id}`);
        const roomId = socket.roomId;
        if (roomId && rooms[roomId]) {
            // أبلغ الطرف الآخر
            socket.to(roomId).emit('stream-ended');
            delete rooms[roomId];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n✅ Signaling Server running on http://localhost:${PORT}`);
    console.log(`   اضغط Ctrl+C للإيقاف\n`);
});
