# 🏥 Hospital Secure LAN

A WebRTC-based internal hospital communication system.

## Features
- **Video calls** — full mesh, everyone can see everyone
- **Secure chat** — all-staff channel + per-department channels
- **Document sharing** — P2P encrypted file transfer (no server storage)
- **Screen sharing** — share your screen with connected peers
- **Audit log** — every join, leave, call, chat, and file transfer is logged to `logs/audit.log` and visible in the Logs tab
- **Department rooms** — Emergency, ICU, Radiology, Surgery, Pharmacy, Lab, Cardiology, Pediatrics, Admin, Nursing

## Setup

### Prerequisites
- Node.js 18+

### Install & run
```bash
npm install
npm start
```

### Connect
Open `https://<server-ip>:3000` on any device on the LAN.  
Accept the self-signed certificate warning (click "Advanced → Proceed").

## Project structure
```
hospital-lan/
├── server.js          # Express + Socket.IO signaling server + audit logger
├── public/
│   ├── index.html     # App UI
│   └── app.js         # WebRTC + chat + file transfer logic
├── security/          #Add yours
│   ├── cert.key       # Self-signed TLS key (HTTPS required for WebRTC)
│   └── cert.pem       # Self-signed TLS cert 
├── logs/
│   └── audit.log      # Persistent audit trail (auto-created)
└── package.json
```

## Audit log
All events are logged with ISO timestamp, event type, actor name, and details:
- `JOIN` / `LEAVE` — user connects/disconnects
- `CALL_START` / `CALL_END` — video call initiated/ended
- `CHAT` — message sent (channel and length, not content)
- `FILE_TRANSFER` — document sent (filename, size, sender, recipient)

Logs are written to `logs/audit.log` and are also available via `GET /api/logs`.

## API endpoints
- `GET /api/users` — currently connected users
- `GET /api/logs?limit=200&type=CALL_START` — filtered audit log
- `GET /api/config` — departments and roles list

## Security notes
- All traffic is TLS encrypted (HTTPS + WSS)
- Video/audio/file data flows P2P via WebRTC (encrypted DTLS/SRTP)
- Chat messages are relayed through the server (Socket.IO)
- For production, replace the self-signed cert with a proper CA certificate
- Consider adding authentication (JWT or session-based) before deploying hospital-wide
