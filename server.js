const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const adminTokens = new Map();
const loginAttempts = new Map();
const ADMIN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

function cleanExpiredTokens() {
  const now = Date.now();
  for (const [token, expiresAt] of adminTokens) {
    if (expiresAt <= now) adminTokens.delete(token);
  }
}

function validAdminToken(token) {
  cleanExpiredTokens();
  if (!token || !adminTokens.has(token)) return false;
  return adminTokens.get(token) > Date.now();
}

app.post('/api/admin/login', (req, res) => {
  const configuredPassword = process.env.ADMIN_PASSWORD;
  if (!configuredPassword) {
    return res.status(503).json({ ok: false, message: '尚未設定管理員密碼（ADMIN_PASSWORD）' });
  }

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const attempt = loginAttempts.get(ip) || { count: 0, resetAt: now + 10 * 60 * 1000 };
  if (now > attempt.resetAt) { attempt.count = 0; attempt.resetAt = now + 10 * 60 * 1000; }
  if (attempt.count >= 10) {
    return res.status(429).json({ ok: false, message: '嘗試次數太多，請稍後再試' });
  }

  const supplied = String(req.body?.password || '');
  const a = Buffer.from(supplied);
  const b = Buffer.from(String(configuredPassword));
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) {
    attempt.count += 1;
    loginAttempts.set(ip, attempt);
    return res.status(401).json({ ok: false, message: '管理密碼錯誤' });
  }

  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  adminTokens.set(token, now + ADMIN_TOKEN_TTL_MS);
  res.json({ ok: true, token, expiresInMs: ADMIN_TOKEN_TTL_MS });
});

app.post('/api/admin/logout', (req, res) => {
  const token = String(req.body?.token || '');
  if (token) adminTokens.delete(token);
  res.json({ ok: true });
});

const rooms = new Map();

function defaultRoom(roomId) {
  return {
    id: roomId,
    sessionNo: roomId || '001',
    difficulty: 'easy',
    durationSec: 60,
    moleIntervalMs: 1000,
    countdownSec: 30,
    startAt: null,
    note: '',
    status: 'waiting',
    startedAt: null,
    endsAt: null,
    players: new Map(),
    activeMoles: [],
    moleTimer: null,
    startTimer: null,
    countdownTimer: null,
    endTimer: null,
    countdown: null
  };
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, defaultRoom(roomId));
  return rooms.get(roomId);
}

function difficultyConfig(difficulty) {
  if (difficulty === 'medium') return { grid: 4, simultaneous: 2, defaultInterval: 800 };
  if (difficulty === 'hard') return { grid: 5, simultaneous: 3, defaultInterval: 550 };
  return { grid: 3, simultaneous: 1, defaultInterval: 1200 };
}

function publicPlayers(room) {
  return [...room.players.values()]
    .map(p => ({ name: p.name, score: p.score, connected: p.connected, joinedAt: p.joinedAt }))
    .sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt)
    .map((p, i) => ({ ...p, rank: i + 1 }));
}

function publicRoom(room) {
  const cfg = difficultyConfig(room.difficulty);
  return {
    id: room.id,
    sessionNo: room.sessionNo,
    difficulty: room.difficulty,
    durationSec: room.durationSec,
    moleIntervalMs: room.moleIntervalMs,
    countdownSec: room.countdownSec,
    startAt: room.startAt,
    note: room.note,
    status: room.status,
    startedAt: room.startedAt,
    endsAt: room.endsAt,
    countdown: room.countdown,
    grid: cfg.grid,
    players: publicPlayers(room),
    activeMoles: room.activeMoles
  };
}

function emitRoom(room) {
  io.to(room.id).emit('room:update', publicRoom(room));
}

function clearTimers(room) {
  for (const key of ['moleTimer','startTimer','countdownTimer','endTimer']) {
    if (room[key]) clearInterval(room[key]);
    if (room[key]) clearTimeout(room[key]);
    room[key] = null;
  }
}

function generateMoles(room) {
  const cfg = difficultyConfig(room.difficulty);
  const total = cfg.grid * cfg.grid;
  const count = Math.min(cfg.simultaneous, total);
  const set = new Set();
  while (set.size < count) set.add(Math.floor(Math.random() * total));
  room.activeMoles = [...set];
  io.to(room.id).emit('moles:update', room.activeMoles);
}

function finishGame(room) {
  if (room.status === 'finished') return;
  if (room.moleTimer) clearInterval(room.moleTimer);
  if (room.endTimer) clearTimeout(room.endTimer);
  room.moleTimer = null;
  room.endTimer = null;
  room.activeMoles = [];
  room.status = 'finished';
  room.countdown = null;
  emitRoom(room);
  io.to(room.id).emit('game:finished', publicRoom(room));
}

function startGame(room) {
  if (room.status === 'playing') return;
  clearTimers(room);
  room.status = 'playing';
  room.startedAt = Date.now();
  room.endsAt = room.startedAt + room.durationSec * 1000;
  room.countdown = null;
  for (const p of room.players.values()) p.score = 0;
  generateMoles(room);
  room.moleTimer = setInterval(() => generateMoles(room), Math.max(250, room.moleIntervalMs));
  room.endTimer = setTimeout(() => finishGame(room), room.durationSec * 1000);
  emitRoom(room);
  io.to(room.id).emit('game:started', publicRoom(room));
}

function beginCountdown(room, seconds = room.countdownSec || 30) {
  clearTimers(room);
  room.status = 'countdown';
  room.countdown = seconds;
  emitRoom(room);
  io.to(room.id).emit('game:countdown', room.countdown);
  room.countdownTimer = setInterval(() => {
    room.countdown -= 1;
    if (room.countdown <= 0) {
      clearInterval(room.countdownTimer);
      room.countdownTimer = null;
      startGame(room);
      return;
    }
    io.to(room.id).emit('game:countdown', room.countdown);
    emitRoom(room);
  }, 1000);
}

function scheduleStart(room) {
  if (!room.startAt) return;
  clearTimers(room);
  const ms = room.startAt - Date.now();
  const countdownMs = room.countdownSec * 1000;
  if (ms <= countdownMs) {
    beginCountdown(room, room.countdownSec);
    return;
  }
  room.status = 'scheduled';
  room.countdown = null;
  room.startTimer = setTimeout(() => beginCountdown(room, room.countdownSec), ms - countdownMs);
  emitRoom(room);
}

io.on('connection', socket => {
  socket.on('admin:join', ({ roomId, token }) => {
    if (!validAdminToken(token)) { socket.emit('admin:authError', '請先輸入正確的管理密碼'); return; }
    roomId = String(roomId || '001').trim();
    const room = getRoom(roomId);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = 'admin';
    socket.data.adminAuthorized = true;
    socket.emit('room:update', publicRoom(room));
  });

  socket.on('player:join', ({ roomId, name }) => {
    roomId = String(roomId || '').trim();
    name = String(name || '').trim().slice(0, 24);
    if (!roomId || !name) return;
    const room = getRoom(roomId);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = 'player';
    socket.data.playerName = name;
    let p = room.players.get(name);
    if (!p) {
      p = { name, score: 0, connected: true, joinedAt: Date.now(), socketIds: new Set() };
      room.players.set(name, p);
    }
    p.connected = true;
    p.socketIds.add(socket.id);
    socket.emit('player:joined', { name, room: publicRoom(room) });
    emitRoom(room);
  });

  socket.on('admin:settings', data => {
    if (!socket.data.adminAuthorized) { socket.emit('admin:authError', '管理員驗證已失效，請重新登入'); return; }
    const roomId = String(data.roomId || socket.data.roomId || '001').trim();
    const room = getRoom(roomId);
    const requestedDuration = Number(data.durationSec);
    const duration = [60, 90, 120].includes(requestedDuration) ? requestedDuration : 60;
    const difficulty = ['easy','medium','hard'].includes(data.difficulty) ? data.difficulty : 'easy';
    const interval = Math.min(5000, Math.max(250, Number(data.moleIntervalMs) || difficultyConfig(difficulty).defaultInterval));
    room.sessionNo = String(data.sessionNo || roomId).trim().slice(0, 30) || roomId;
    room.difficulty = difficulty;
    room.durationSec = duration;
    room.moleIntervalMs = interval;
    room.countdownSec = [30,60,90,120].includes(Number(data.countdownSec)) ? Number(data.countdownSec) : 30;
    room.note = String(data.note || '').slice(0, 500);
    room.startAt = data.startAt ? Number(data.startAt) : null;
    if (room.startAt && room.status !== 'playing') scheduleStart(room);
    else emitRoom(room);
  });

  socket.on('admin:startNow', ({ roomId }) => {
    if (!socket.data.adminAuthorized) { socket.emit('admin:authError', '管理員驗證已失效，請重新登入'); return; }
    const room = getRoom(String(roomId || socket.data.roomId || '001').trim());
    beginCountdown(room, room.countdownSec);
  });

  socket.on('admin:finish', ({ roomId }) => {
    if (!socket.data.adminAuthorized) { socket.emit('admin:authError', '管理員驗證已失效，請重新登入'); return; }
    const room = getRoom(String(roomId || socket.data.roomId || '001').trim());
    finishGame(room);
  });

  socket.on('admin:reset', ({ roomId }) => {
    if (!socket.data.adminAuthorized) { socket.emit('admin:authError', '管理員驗證已失效，請重新登入'); return; }
    const room = getRoom(String(roomId || socket.data.roomId || '001').trim());
    clearTimers(room);
    room.status = 'waiting';
    room.startedAt = null;
    room.endsAt = null;
    room.activeMoles = [];
    room.countdown = null;
    room.startAt = null;
    for (const p of room.players.values()) p.score = 0;
    emitRoom(room);
  });

  socket.on('player:hit', ({ index }) => {
    const roomId = socket.data.roomId;
    const name = socket.data.playerName;
    if (!roomId || !name) return;
    const room = getRoom(roomId);
    if (room.status !== 'playing') return;
    if (!room.activeMoles.includes(Number(index))) return;
    const p = room.players.get(name);
    if (!p) return;
    p.score += 1;
    socket.emit('hit:success', { index: Number(index), points: 1, score: p.score });
    room.activeMoles = room.activeMoles.filter(i => i !== Number(index));
    io.to(room.id).emit('moles:update', room.activeMoles);
    emitRoom(room);
  });

  socket.on('disconnect', () => {
    if (socket.data.role !== 'player') return;
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const p = room.players.get(socket.data.playerName);
    if (!p) return;
    p.socketIds.delete(socket.id);
    p.connected = p.socketIds.size > 0;
    emitRoom(room);
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Whack-a-Mole server running on ${PORT}`));
