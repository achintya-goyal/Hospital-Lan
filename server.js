const express = require('express');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const socketIo = require('socket.io');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const httpsOptions = {
    key: fs.readFileSync('./security/cert.key'),
    cert: fs.readFileSync('./security/cert.pem'),
    requestCert: false,
    rejectUnauthorized: false
};

const server = https.createServer(httpsOptions, app);
const io = socketIo(server, { cors: { origin: '*' } });

// ─── In-Memory State ────────────────────────────────────────────────────────
const connectedUsers = {};   // socketId -> { name, department, role, joinedAt }
const auditLog = [];         // Array of log entries
const LOG_FILE = path.join(__dirname, 'logs', 'audit.log');

// ─── Departments & Roles ────────────────────────────────────────────────────
const DEPARTMENTS = [
    'Emergency', 'ICU', 'Radiology', 'Surgery', 'Pharmacy',
    'Laboratory', 'Cardiology', 'Pediatrics', 'Administration', 'Nursing'
];

const ROLES = ['Doctor', 'Nurse', 'Technician', 'Administrator', 'Pharmacist'];

// ─── Logging ────────────────────────────────────────────────────────────────
function log(type, actor, details) {
    const entry = {
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        timestamp: new Date().toISOString(),
        type,
        actor,
        details
    };
    auditLog.unshift(entry);
    if (auditLog.length > 2000) auditLog.splice(1999);

    const line = `[${entry.timestamp}] [${type}] ${actor}: ${JSON.stringify(details)}\n`;
    fs.appendFile(LOG_FILE, line, () => {});
    io.emit('log-entry', entry);
    return entry;
}

// ─── REST Endpoints ─────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
    res.json({ departments: DEPARTMENTS, roles: ROLES });
});

app.get('/api/users', (req, res) => {
    res.json(Object.values(connectedUsers));
});

app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 200;
    const type = req.query.type;
    let entries = auditLog;
    if (type && type !== 'all') entries = entries.filter(e => e.type === type);
    res.json(entries.slice(0, limit));
});

// ─── Socket.IO ──────────────────────────────────────────────────────────────
const ROOM_ALL = 'hospital-all';

io.on('connection', (socket) => {

    // ── Registration ──────────────────────────────────────────────────────
    socket.on('register', ({ name, department, role }) => {
        if (!name || !department || !role) return socket.emit('register-error', 'Missing fields');

        connectedUsers[socket.id] = {
            socketId: socket.id,
            name,
            department,
            role,
            joinedAt: new Date().toISOString()
        };

        socket.join(ROOM_ALL);
        socket.join(`dept-${department}`);

        log('JOIN', name, { department, role, socketId: socket.id });

        socket.emit('register-ok', { socketId: socket.id });
        io.emit('users-updated', Object.values(connectedUsers));

        // Tell existing users about this new peer (for WebRTC mesh)
        socket.to(ROOM_ALL).emit('peer-joined', socket.id);
    });

    // ── WebRTC Signaling ──────────────────────────────────────────────────
    socket.on('offer', ({ target, sdp }) => {
        io.to(target).emit('offer', { callerId: socket.id, sdp });
    });

    socket.on('answer', ({ target, sdp }) => {
        io.to(target).emit('answer', { responderId: socket.id, sdp });
    });

    socket.on('ice-candidate', ({ target, candidate }) => {
        io.to(target).emit('ice-candidate', { senderId: socket.id, candidate });
    });

    // ── Call logging ──────────────────────────────────────────────────────
    socket.on('call-started', ({ targetId }) => {
        const caller = connectedUsers[socket.id];
        const callee = connectedUsers[targetId];
        if (caller && callee) {
            log('CALL_START', caller.name, {
                to: callee.name,
                callerDept: caller.department,
                calleeDept: callee.department
            });
        }
    });

    socket.on('call-ended', ({ targetId }) => {
        const caller = connectedUsers[socket.id];
        const callee = connectedUsers[targetId];
        if (caller && callee) {
            log('CALL_END', caller.name, { to: callee.name });
        }
    });

    // ── Chat ──────────────────────────────────────────────────────────────
    socket.on('chat-message', ({ text, channel }) => {
        const user = connectedUsers[socket.id];
        if (!user) return;

        const msg = {
            id: Date.now(),
            from: user.name,
            department: user.department,
            role: user.role,
            text,
            channel,
            timestamp: new Date().toISOString()
        };

        log('CHAT', user.name, { channel, length: text.length });

        if (channel === 'all') {
            io.to(ROOM_ALL).emit('chat-message', msg);
        } else {
            io.to(`dept-${channel}`).emit('chat-message', msg);
        }
    });

    // ── Document / File share log ─────────────────────────────────────────
    socket.on('file-sent', ({ fileName, fileSize, targetId }) => {
        const sender = connectedUsers[socket.id];
        const receiver = connectedUsers[targetId];
        if (sender) {
            log('FILE_TRANSFER', sender.name, {
                file: fileName,
                size: fileSize,
                to: receiver ? receiver.name : targetId
            });
        }
    });

    // ── Disconnect ────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        const user = connectedUsers[socket.id];
        if (user) {
            log('LEAVE', user.name, { department: user.department });
            delete connectedUsers[socket.id];
            io.emit('users-updated', Object.values(connectedUsers));
            socket.to(ROOM_ALL).emit('peer-left', socket.id);
        }
    });
});

// ─── Boot ────────────────────────────────────────────────────────────────────
function getLocalIP() {
    const ifaces = os.networkInterfaces();
    for (const dev of Object.values(ifaces)) {
        for (const alias of dev) {
            if (alias.family === 'IPv4' && !alias.internal) return alias.address;
        }
    }
    return '0.0.0.0';
}

if (!fs.existsSync(path.join(__dirname, 'logs'))) fs.mkdirSync(path.join(__dirname, 'logs'));

server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    console.log('══════════════════════════════════════════════');
    console.log('  🏥 Hospital Secure LAN Network');
    console.log(`  Connect: https://${ip}:${PORT}`);
    console.log('  Accept the self-signed cert warning.');
    console.log('══════════════════════════════════════════════');
});
