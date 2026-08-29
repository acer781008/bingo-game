const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

const adminSessions = new Set();
const rooms = new Map();
const timers = new Map();

app.use(express.json());

function readCookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

function isAdmin(req) {
  const token = readCookies(req).admin_session;
  return !!token && adminSessions.has(token);
}

function getTimers(roomId) {
  if (!timers.has(roomId)) timers.set(roomId, {});
  return timers.get(roomId);
}

function clearRoomTimers(roomId) {
  const t = getTimers(roomId);
  clearTimeout(t.schedule);
  clearTimeout(t.countdown);
  clearTimeout(t.end);
  clearInterval(t.draw);
  timers.set(roomId, {});
}

function roomInfo(room) {
  return {
    roomId: room.id,
    size: room.size,
    phase: room.phase,
    scheduledAt: room.scheduledAt,
    countdownSeconds: room.countdownSeconds,
    countdownEndsAt: room.countdownEndsAt || null,
    gameSeconds: room.gameSeconds,
    gameEndsAt: room.gameEndsAt || null,
    drawIntervalMs: room.drawIntervalMs,
    currentNumber: room.currentNumber || null,
    drawToken: room.drawToken || 0
  };
}

function ranking(room) {
  return [...room.players.values()]
    .sort((a, b) =>
      (b.bingoLines - a.bingoLines) ||
      (b.hitCount - a.hitCount) ||
      ((a.finishAt || Infinity) - (b.finishAt || Infinity))
    )
    .map((p, i) => ({
      rank: i + 1,
      name: p.name,
      hitCount: p.hitCount,
      bingoLines: p.bingoLines,
      finishAt: p.finishAt || null
    }));
}

function emitRanking(room) {
  io.to(room.id).emit("rankingUpdate", ranking(room));
}

function finishGame(room) {
  if (!room || room.phase === "ended") return;
  clearRoomTimers(room.id);
  room.phase = "ended";
  room.currentNumber = null;
  io.to(room.id).emit("gameEnded", { ranking: ranking(room) });
}

function drawNext(room) {
  if (!room || room.phase !== "playing") return;

  const remaining = [];
  for (let n = 1; n <= room.size; n++) {
    if (!room.drawn.includes(n)) remaining.push(n);
  }
  if (!remaining.length) return finishGame(room);

  const number = remaining[Math.floor(Math.random() * remaining.length)];
  room.drawn.push(number);
  room.currentNumber = number;
  room.drawToken += 1;

  io.to(room.id).emit("numberDrawn", {
    number,
    token: room.drawToken
  });
}

function startGame(room) {
  if (!room || room.phase !== "countdown") return;

  room.phase = "playing";
  room.gameEndsAt = Date.now() + room.gameSeconds * 1000;

  io.to(room.id).emit("gameStarted", {
    gameEndsAt: room.gameEndsAt
  });

  drawNext(room);

  const t = getTimers(room.id);
  t.draw = setInterval(() => drawNext(room), room.drawIntervalMs);
  t.end = setTimeout(() => finishGame(room), room.gameSeconds * 1000);
}

function startCountdown(room) {
  if (!room || room.phase !== "waiting") return;

  room.phase = "countdown";
  room.countdownEndsAt = Date.now() + room.countdownSeconds * 1000;

  io.to(room.id).emit("countdownStarted", {
    countdownEndsAt: room.countdownEndsAt,
    countdownSeconds: room.countdownSeconds
  });

  const t = getTimers(room.id);
  clearTimeout(t.schedule);
  t.countdown = setTimeout(() => startGame(room), room.countdownSeconds * 1000);
}

app.post("/api/admin/login", (req, res) => {
  if (String(req.body.password || "") !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: "管理員密碼錯誤" });
  }

  const token = crypto.randomBytes(24).toString("hex");
  adminSessions.add(token);
  res.setHeader("Set-Cookie", `admin_session=${token}; HttpOnly; Path=/; SameSite=Lax`);
  res.json({ success: true });
});

app.get("/admin.html", (req, res) => {
  if (!isAdmin(req)) return res.redirect("/admin-login.html");
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.post("/api/admin/create-room", (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ success: false, message: "未登入管理員" });
  }

  const roomId = String(req.body.roomId || "").trim();
  const playerPassword = String(req.body.playerPassword || "").trim();
  const size = Number(req.body.size);
  const scheduledAt = Number(req.body.scheduledAt);
  const countdownSeconds = Number(req.body.countdownSeconds);
  const gameSeconds = Number(req.body.gameSeconds);
  const drawIntervalMs = Number(req.body.drawIntervalMs);

  if (!roomId) return res.status(400).json({ success: false, message: "請輸入房間號碼" });
  if (!playerPassword) return res.status(400).json({ success: false, message: "請輸入房間密碼" });
  if (rooms.has(roomId)) return res.status(400).json({ success: false, message: "房間號碼已存在" });
  if (![25, 36, 49, 64].includes(size)) return res.status(400).json({ success: false, message: "盤面格數錯誤" });
  if (![30, 60, 90].includes(countdownSeconds)) return res.status(400).json({ success: false, message: "倒數秒數錯誤" });
  if (![60, 90, 120].includes(gameSeconds)) return res.status(400).json({ success: false, message: "遊戲秒數錯誤" });
  if (![1000,1500,2000,2500,3000,3500,4000,4500,5000].includes(drawIntervalMs)) {
    return res.status(400).json({ success: false, message: "開獎速度錯誤" });
  }
  if (!Number.isFinite(scheduledAt)) {
    return res.status(400).json({ success: false, message: "請選擇正確的開賽日期時間" });
  }
  if (scheduledAt <= Date.now()) {
    return res.status(400).json({ success: false, message: "開賽日期時間必須晚於現在" });
  }

  const room = {
    id: roomId,
    playerPassword,
    version: "original",
    size,
    scheduledAt,
    countdownSeconds,
    gameSeconds,
    drawIntervalMs,
    phase: "waiting",
    countdownEndsAt: null,
    gameEndsAt: null,
    currentNumber: null,
    drawToken: 0,
    drawn: [],
    players: new Map()
  };

  rooms.set(roomId, room);

  const t = getTimers(roomId);
  t.schedule = setTimeout(() => {
    const current = rooms.get(roomId);
    if (current && current.phase === "waiting") startCountdown(current);
  }, Math.max(0, scheduledAt - Date.now()));

  res.json({
    success: true,
    room: roomInfo(room)
  });
});

app.get("/api/admin/room/:roomId", (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ success: false, message: "未登入管理員" });
  }
  const room = rooms.get(String(req.params.roomId || "").trim());
  if (!room) return res.status(404).json({ success: false, message: "找不到房間" });

  res.json({
    success: true,
    room: {
      ...roomInfo(room),
      playerCount: room.players.size,
      ranking: ranking(room)
    }
  });
});

app.use(express.static(path.join(__dirname, "public")));

io.on("connection", socket => {
  socket.on("watchRoom", ({ roomId }) => {
    const room = rooms.get(String(roomId || "").trim());
    if (!room) return;

    socket.join(room.id);
    socket.emit("roomState", {
      ...roomInfo(room),
      ranking: ranking(room),
      playerCount: room.players.size
    });
  });

  socket.on("joinRoom", ({ roomId, name, password, clientId }) => {
    const room = rooms.get(String(roomId || "").trim());
    const cleanName = String(name || "").trim();
    const cleanClientId = String(clientId || "").trim();

    if (!room) return socket.emit("joinError", "找不到這個房間");
    if (!cleanName) return socket.emit("joinError", "請輸入玩家名稱");
    if (!cleanClientId) return socket.emit("joinError", "玩家識別資料遺失，請重新整理後再試");
    if (String(password || "") !== room.playerPassword) {
      return socket.emit("joinError", "房間密碼錯誤");
    }

    const existing = room.players.get(cleanClientId);

    // 遊戲正式開始後：只有開始前已經加入過的同一位玩家可以重新連線。
    if ((room.phase === "playing" || room.phase === "ended") && !existing) {
      return socket.emit("joinError", room.phase === "ended"
        ? "本場遊戲已結束"
        : "本場遊戲已開始，無法加入");
    }

    // 同一房間不可用不同裝置/分頁重複同名，避免排行榜混淆。
    for (const [id, player] of room.players.entries()) {
      if (id !== cleanClientId && player.name === cleanName) {
        return socket.emit("joinError", "這個玩家名稱已有人使用");
      }
    }

    const player = existing || {
      clientId: cleanClientId,
      name: cleanName,
      hitCount: 0,
      bingoLines: 0,
      finishAt: null
    };

    player.name = cleanName;
    player.socketId = socket.id;
    room.players.set(cleanClientId, player);

    socket.data.roomId = room.id;
    socket.data.clientId = cleanClientId;
    socket.join(room.id);

    socket.emit("joinSuccess", {
      ...roomInfo(room),
      name: player.name,
      hitCount: player.hitCount,
      bingoLines: player.bingoLines
    });

    emitRanking(room);
  });

  socket.on("addScore", ({ hitCount, bingoLines, token }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.phase !== "playing") return;

    const player = room.players.get(socket.data.clientId);
    if (!player) return;

    // 只接受目前這一期號碼的點擊結果。
    if (Number(token) !== room.drawToken) return;

    const newHits = Math.max(player.hitCount, Number(hitCount) || 0);
    const newLines = Math.max(player.bingoLines, Number(bingoLines) || 0);

    if (newLines > player.bingoLines && !player.finishAt) {
      player.finishAt = Date.now();
    }

    player.hitCount = newHits;
    player.bingoLines = newLines;

    emitRanking(room);
  });

  socket.on("disconnect", () => {
    // 不刪除玩家資格。
    // index.html 跳到 game.html、重新整理、短暫斷線時，都能用 clientId 接回同一玩家。
    const room = rooms.get(socket.data.roomId);
    if (room) emitRanking(room);
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Bingo New：http://localhost:${PORT}`);
});
