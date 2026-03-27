// ═══════════════════════════════════════════════════════════
//  Hospital Secure LAN - Client
// ═══════════════════════════════════════════════════════════

const socket = io('/');

let myName = '', myDept = '', myRole = '', mySocketId = '';
let localStream = null, screenStream = null;
const peers = {};         // socketId -> RTCPeerConnection
const dataChannels = {};  // socketId -> RTCDataChannel
let allUsers = [];

// File receive state
const incomingFiles = {};  // socketId -> { meta, chunks }

// ── Config ──────────────────────────────────────────────────
const RTC_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.stunprotocol.org:3478' }
    ]
};

const DEPT_COLORS = {
    Emergency: 'bg-red-800 text-red-200',
    ICU: 'bg-purple-800 text-purple-200',
    Radiology: 'bg-indigo-800 text-indigo-200',
    Surgery: 'bg-yellow-800 text-yellow-200',
    Pharmacy: 'bg-green-800 text-green-200',
    Laboratory: 'bg-cyan-800 text-cyan-200',
    Cardiology: 'bg-pink-800 text-pink-200',
    Pediatrics: 'bg-orange-800 text-orange-200',
    Administration: 'bg-slate-600 text-slate-200',
    Nursing: 'bg-teal-800 text-teal-200'
};

// ── Login ────────────────────────────────────────────────────
(async () => {
    const cfg = await fetch('/api/config').then(r => r.json());
    const deptSel = document.getElementById('login-dept');
    const roleSel = document.getElementById('login-role');
    const chanSel = document.getElementById('chat-channel');

    cfg.departments.forEach(d => {
        deptSel.innerHTML += `<option value="${d}">${d}</option>`;
        chanSel.innerHTML += `<option value="${d}">🏢 ${d}</option>`;
    });
    cfg.roles.forEach(r => {
        roleSel.innerHTML += `<option value="${r}">${r}</option>`;
    });
})();

document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('login-name').addEventListener('keydown', e => e.key === 'Enter' && doLogin());

function doLogin() {
    const name = document.getElementById('login-name').value.trim();
    const dept = document.getElementById('login-dept').value;
    const role = document.getElementById('login-role').value;
    if (!name || !dept || !role) {
        document.getElementById('login-err').classList.remove('hidden');
        return;
    }
    myName = name; myDept = dept; myRole = role;
    document.getElementById('login-err').classList.add('hidden');
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('main-app').classList.remove('hidden');
    document.getElementById('main-app').classList.add('flex');
    document.getElementById('user-badge').textContent = `${role} · ${dept}`;
    document.getElementById('local-name-tag').textContent = name;
    socket.emit('register', { name, department: dept, role });
    initLocalMedia();
}

// ── Media ────────────────────────────────────────────────────
async function initLocalMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: { echoCancellation: true, noiseSuppression: true }
        });
        const lv = document.getElementById('local-video');
        lv.srcObject = localStream;
        document.getElementById('local-video-wrap').classList.remove('hidden');
    } catch (e) {
        console.warn('Media error:', e.message);
    }
}

// ── Peer Connections ─────────────────────────────────────────
function createPC(targetId, initiator) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    peers[targetId] = pc;

    if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    if (screenStream) screenStream.getTracks().forEach(t => pc.addTrack(t, screenStream));

    pc.onicecandidate = e => {
        if (e.candidate) socket.emit('ice-candidate', { target: targetId, candidate: e.candidate });
    };

    pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed') pc.restartIce();
    };

    pc.ontrack = e => {
        const stream = e.streams[0];
        if (!stream) return;
        let wrap = document.getElementById('vid-wrap-' + stream.id);
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = 'vid-wrap-' + stream.id;
            wrap.className = 'relative rounded-xl overflow-hidden bg-black border border-slate-700 flex items-end';
            const vid = document.createElement('video');
            vid.id = 'vid-' + stream.id;
            vid.className = 'w-full h-full object-cover';
            vid.srcObject = stream; vid.autoplay = true; vid.playsInline = true;
            const user = allUsers.find(u => u.socketId === targetId);
            const label = document.createElement('div');
            label.className = 'absolute bottom-2 left-2 bg-black/70 px-2 py-1 rounded text-xs font-medium';
            label.textContent = user ? `${user.name} · ${user.department}` : `Peer ${targetId.slice(0,4)}`;
            wrap.appendChild(vid); wrap.appendChild(label);
            document.getElementById('video-grid').appendChild(wrap);
            updateGridLayout();
        }
    };

    if (initiator) {
        const dc = pc.createDataChannel('hospital-data');
        setupDC(dc, targetId);
    } else {
        pc.ondatachannel = e => setupDC(e.channel, targetId);
    }

    return pc;
}

// ── DataChannel ──────────────────────────────────────────────
function setupDC(dc, targetId) {
    dc.binaryType = 'arraybuffer';
    dataChannels[targetId] = dc;
    updateFileTargetList();

    dc.onopen = () => updateFileTargetList();
    dc.onclose = () => updateFileTargetList();

    dc.onmessage = e => {
        if (typeof e.data === 'string') {
            if (e.data.startsWith('META:')) {
                const meta = JSON.parse(e.data.slice(5));
                incomingFiles[targetId] = { meta, chunks: [] };
            } else if (e.data === 'EOF') {
                const { meta, chunks } = incomingFiles[targetId] || {};
                if (!meta) return;
                const blob = new Blob(chunks, { type: meta.mime || 'application/octet-stream' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = meta.name; a.click();
                URL.revokeObjectURL(url);
                addFileLog(`📥 Received <strong>${escHtml(meta.name)}</strong> (${fmtSize(meta.size)}) from <strong>${escHtml(meta.senderName)}</strong>`);
                delete incomingFiles[targetId];
            } else {
                const msg = JSON.parse(e.data);
                appendChat(msg);
            }
        } else {
            if (incomingFiles[targetId]) incomingFiles[targetId].chunks.push(e.data);
        }
    };
}

// ── Signaling ────────────────────────────────────────────────
socket.on('register-ok', ({ socketId }) => {
    mySocketId = socketId;
    loadPastLogs();
    startTelemetry();
});

socket.on('peer-joined', async (newId) => {
    if (peers[newId]) return;
    const pc = createPC(newId, true);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { target: newId, sdp: pc.localDescription });
    socket.emit('call-started', { targetId: newId });
});

socket.on('offer', async ({ callerId, sdp }) => {
    if (peers[callerId]) return;
    const pc = createPC(callerId, false);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { target: callerId, sdp: pc.localDescription });
});

socket.on('answer', async ({ responderId, sdp }) => {
    const pc = peers[responderId];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on('ice-candidate', async ({ senderId, candidate }) => {
    const pc = peers[senderId];
    if (pc) try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
});

socket.on('peer-left', (id) => {
    if (peers[id]) { peers[id].close(); delete peers[id]; }
    if (dataChannels[id]) delete dataChannels[id];
    // Remove video elements
    document.querySelectorAll('[id^="vid-wrap-"]').forEach(el => {
        const vid = el.querySelector('video');
        if (vid && vid.srcObject && vid.srcObject.getTracks().every(t => t.readyState === 'ended')) {
            el.remove(); updateGridLayout();
        }
    });
    // Remove after short delay for tracks to end
    setTimeout(() => {
        document.querySelectorAll('[id^="vid-wrap-"]').forEach(el => {
            const vid = el.querySelector('video');
            if (!vid || !vid.srcObject || !vid.srcObject.active) { el.remove(); updateGridLayout(); }
        });
    }, 500);
    socket.emit('call-ended', { targetId: id });
    updateFileTargetList();
});

// ── Users ────────────────────────────────────────────────────
socket.on('users-updated', (users) => {
    allUsers = users;
    renderUserList(users);
    document.getElementById('online-count').textContent = `${users.length} online`;
    updateFileTargetList();
});

function renderUserList(users) {
    const el = document.getElementById('user-list');
    el.innerHTML = '';
    const me = users.find(u => u.socketId === mySocketId);
    const others = users.filter(u => u.socketId !== mySocketId);
    const sorted = me ? [me, ...others] : others;

    sorted.forEach(u => {
        const isSelf = u.socketId === mySocketId;
        const colorCls = DEPT_COLORS[u.department] || 'bg-slate-700 text-slate-200';
        const div = document.createElement('div');
        div.className = `flex flex-col gap-0.5 p-1.5 rounded-lg ${isSelf ? 'bg-slate-700/60' : 'hover:bg-slate-700/30'} cursor-pointer`;
        div.innerHTML = `
          <div class="flex items-center gap-1.5">
            <span class="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0"></span>
            <span class="font-medium truncate">${escHtml(u.name)}${isSelf ? ' (you)' : ''}</span>
          </div>
          <div class="flex gap-1 pl-3">
            <span class="dept-badge ${colorCls}">${escHtml(u.department)}</span>
            <span class="dept-badge bg-slate-600 text-slate-300">${escHtml(u.role)}</span>
          </div>`;
        if (!isSelf) div.title = 'Connected peer';
        el.appendChild(div);
    });
}

// ── Chat ─────────────────────────────────────────────────────
socket.on('chat-message', msg => appendChat(msg));

document.getElementById('chat-send').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', e => e.key === 'Enter' && sendChat());

function sendChat() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    const channel = document.getElementById('chat-channel').value;
    if (!text) return;
    socket.emit('chat-message', { text, channel });
    input.value = '';
}

function appendChat(msg) {
    const el = document.getElementById('chat-messages');
    const isMe = msg.from === myName;
    const colorCls = DEPT_COLORS[msg.department] || 'bg-slate-700 text-slate-200';
    const d = document.createElement('div');
    d.className = `p-2 rounded-lg ${isMe ? 'bg-blue-900/50' : 'bg-slate-700/50'}`;
    const ts = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    d.innerHTML = `
      <div class="flex items-center gap-1.5 mb-0.5">
        <span class="font-semibold text-blue-300">${escHtml(msg.from)}</span>
        <span class="dept-badge ${colorCls}">${escHtml(msg.department)}</span>
        <span class="text-slate-500 ml-auto">${ts}</span>
      </div>
      <p class="text-slate-200 break-words">${escHtml(msg.text)}</p>`;
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
}

// ── File Transfer ─────────────────────────────────────────────
document.getElementById('file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const targetId = document.getElementById('file-target').value;
    if (!targetId) { alert('Select a recipient first.'); return; }
    const dc = dataChannels[targetId];
    if (!dc || dc.readyState !== 'open') { alert('Data channel not ready. Try again.'); return; }

    const CHUNK = 16384;
    const buf = await file.arrayBuffer();
    const meta = { name: file.name, size: file.size, mime: file.type, senderName: myName };

    const prog = document.getElementById('file-progress');
    const bar = document.getElementById('file-progress-bar');
    const pct = document.getElementById('file-progress-pct');
    const fname = document.getElementById('file-progress-name');

    prog.classList.remove('hidden');
    fname.textContent = file.name;

    dc.send(`META:${JSON.stringify(meta)}`);
    const total = Math.ceil(buf.byteLength / CHUNK);
    for (let i = 0; i < buf.byteLength; i += CHUNK) {
        dc.send(buf.slice(i, i + CHUNK));
        const done = Math.ceil((i + CHUNK) / CHUNK);
        const p = Math.min(100, Math.round(done / total * 100));
        bar.style.width = p + '%';
        pct.textContent = p + '%';
        await new Promise(r => setTimeout(r, 2));
    }
    dc.send('EOF');

    socket.emit('file-sent', { fileName: file.name, fileSize: file.size, targetId });

    prog.classList.add('hidden');
    bar.style.width = '0%';
    const recv = allUsers.find(u => u.socketId === targetId);
    addFileLog(`📤 Sent <strong>${escHtml(file.name)}</strong> (${fmtSize(file.size)}) to <strong>${escHtml(recv ? recv.name : targetId.slice(0,6))}</strong>`);
    e.target.value = '';
});

function updateFileTargetList() {
    const sel = document.getElementById('file-target');
    const prev = sel.value;
    sel.innerHTML = '<option value="">Select recipient…</option>';
    allUsers.filter(u => u.socketId !== mySocketId).forEach(u => {
        const dc = dataChannels[u.socketId];
        const ready = dc && dc.readyState === 'open';
        const opt = document.createElement('option');
        opt.value = u.socketId;
        opt.textContent = `${u.name} (${u.department})${ready ? '' : ' – connecting…'}`;
        opt.disabled = !ready;
        sel.appendChild(opt);
    });
    if (prev) sel.value = prev;
}

function addFileLog(html) {
    const el = document.getElementById('file-log');
    const d = document.createElement('div');
    d.className = 'p-2 bg-slate-700/40 rounded text-xs';
    d.innerHTML = `<span class="text-slate-400">${new Date().toLocaleTimeString()}</span> ${html}`;
    el.prepend(d);
}

// ── Controls ─────────────────────────────────────────────────
document.getElementById('btn-video').addEventListener('click', () => {
    if (!localStream) return;
    const t = localStream.getVideoTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    document.getElementById('btn-video').classList.toggle('opacity-50', !t.enabled);
});

document.getElementById('btn-audio').addEventListener('click', () => {
    if (!localStream) return;
    const t = localStream.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    document.getElementById('btn-audio').classList.toggle('opacity-50', !t.enabled);
});

document.getElementById('btn-screen').addEventListener('click', async () => {
    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const track = screenStream.getVideoTracks()[0];
        Object.values(peers).forEach(pc => pc.addTrack(track, screenStream));
        document.getElementById('btn-hangup').classList.remove('hidden');
        track.onended = stopScreen;
    } catch {}
});

document.getElementById('btn-hangup').addEventListener('click', stopScreen);

function stopScreen() {
    if (!screenStream) return;
    const track = screenStream.getVideoTracks()[0];
    Object.values(peers).forEach(pc => {
        const s = pc.getSenders().find(s => s.track === track);
        if (s) pc.removeTrack(s);
    });
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
    document.getElementById('btn-hangup').classList.add('hidden');
}

// ── Tabs ─────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const t = btn.dataset.tab;
        ['chat', 'files', 'logs'].forEach(id => {
            document.getElementById('tab-' + id).classList.toggle('hidden', id !== t);
        });
    });
});

// ── Audit Log ────────────────────────────────────────────────
socket.on('log-entry', appendLogEntry);

document.getElementById('log-filter').addEventListener('change', async () => {
    const type = document.getElementById('log-filter').value;
    const entries = await fetch(`/api/logs?limit=200&type=${type}`).then(r => r.json());
    const el = document.getElementById('log-entries');
    el.innerHTML = '';
    entries.forEach(appendLogEntry);
});

async function loadPastLogs() {
    const entries = await fetch('/api/logs?limit=100').then(r => r.json());
    entries.reverse().forEach(appendLogEntry);
}

function appendLogEntry(entry) {
    const el = document.getElementById('log-entries');
    const ts = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const typeColors = {
        JOIN: 'text-green-400', LEAVE: 'text-red-400',
        CALL_START: 'text-purple-400', CALL_END: 'text-purple-300',
        CHAT: 'text-sky-400', FILE_TRANSFER: 'text-orange-400'
    };
    const d = document.createElement('div');
    d.className = `p-1.5 pl-2 rounded bg-slate-700/30 log-${entry.type}`;
    d.innerHTML = `<span class="text-slate-500">${ts}</span> <span class="${typeColors[entry.type] || 'text-slate-300'}">[${entry.type}]</span> <span class="text-slate-200">${escHtml(entry.actor)}</span> <span class="text-slate-400">${escHtml(JSON.stringify(entry.details))}</span>`;
    el.prepend(d);
    // Cap display at 300
    while (el.children.length > 300) el.lastChild.remove();
}

// ── Telemetry ────────────────────────────────────────────────
function startTelemetry() {
    setInterval(async () => {
        const id = Object.keys(peers)[0];
        if (!id) return;
        const stats = await peers[id].getStats();
        stats.forEach(r => {
            if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime) {
                document.getElementById('rtt-val').textContent = Math.round(r.currentRoundTripTime * 1000);
            }
        });
    }, 3000);
}

// ── Layout ────────────────────────────────────────────────────
function updateGridLayout() {
    const grid = document.getElementById('video-grid');
    const n = grid.children.length;
    grid.className = 'flex-1 grid gap-2 p-3 overflow-hidden';
    if (n === 0) {
        grid.classList.add('grid-cols-1');
    } else if (n === 1) {
        grid.classList.add('grid-cols-1');
    } else if (n <= 4) {
        grid.classList.add('grid-cols-2');
    } else {
        grid.classList.add('grid-cols-3');
    }
}

// ── Utilities ─────────────────────────────────────────────────
function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
    return (b/1048576).toFixed(1) + ' MB';
}
