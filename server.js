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

function generateRoomId() {
  let id;
  do {
    id = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(id));
  return id;
}


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
  clearTimeout(t.cleanup);
  timers.set(roomId, {});
}

function roomInfo(room) {
  return {
    roomId: room.id,
    version: room.version || "number",
    theme: room.theme || null,
    items: room.items || null,
    size: room.size,
    phase: room.phase,
    scheduledAt: room.scheduledAt,
    countdownSeconds: room.countdownSeconds,
    countdownEndsAt: room.countdownEndsAt || null,
    gameSeconds: room.gameSeconds,
    gameEndsAt: room.gameEndsAt || null,
    drawIntervalMs: room.drawIntervalMs,
    currentNumber: room.currentNumber || null,
    drawToken: room.drawToken || 0,
    targetLines: room.targetLines || 1,
    endedAt: room.endedAt || null
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

function scheduleRoomCleanup(room) {
  if (!room) return;
  const t = getTimers(room.id);
  clearTimeout(t.cleanup);
  t.cleanup = setTimeout(() => {
    clearRoomTimers(room.id);
    rooms.delete(room.id);
    timers.delete(room.id);
  }, 10 * 60 * 1000);
}

function finishGame(room) {
  if (!room || room.phase === "ended") return;
  clearRoomTimers(room.id);
  room.phase = "ended";
  room.currentNumber = null;
  room.endedAt = Date.now();
  io.to(room.id).emit("gameEnded", { ranking: ranking(room), cleanupAt: room.endedAt + 10 * 60 * 1000 });
  scheduleRoomCleanup(room);
}

function drawNext(room) {
  if (!room || room.phase !== "playing") return;

  // 若本期叫號已有人達成完成條件，先讓同一期的其他玩家完成回報，
  // 到下一次叫號時間點再統一結束，避免網路快慢決定勝負。
  if (room.winningToken && room.winningToken === room.drawToken) {
    return finishGame(room);
  }

  const numberPoolMax = ({25:50, 36:60, 49:75, 64:90})[room.size] || room.size;
  const pool = room.version === "picture"
    ? MAHJONG_ITEMS.map(item => item.id)
    : Array.from({length: numberPoolMax}, (_, i) => i + 1);
  const remaining = pool.filter(value => !room.drawn.includes(value));
  if (!remaining.length) return finishGame(room);

  const value = remaining[Math.floor(Math.random() * remaining.length)];
  room.drawn.push(value);
  room.currentNumber = value;
  room.drawToken += 1;

  io.to(room.id).emit("numberDrawn", {
    number: value,
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

  const t = getTimers(room.id);

  drawNext(room);
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


const MAHJONG_ITEMS = [
  {id:"white",face:"白",group:"字",name:"白",file:"01-white-dragon.svg"},
  {id:"green",face:"發",group:"字",name:"發",file:"02-green-dragon.svg"},
  {id:"red",face:"中",group:"字",name:"中",file:"03-red-dragon.svg"},
  {id:"east",face:"東",group:"字",name:"東",file:"04-east-wind.svg"},
  {id:"south",face:"南",group:"字",name:"南",file:"05-south-wind.svg"},
  {id:"west",face:"西",group:"字",name:"西",file:"06-west-wind.svg"},
  {id:"north",face:"北",group:"字",name:"北",file:"07-north-wind.svg"},
  {id:"wan1",face:"1萬",group:"萬",name:"1萬",file:"08-characters-1.svg"},
  {id:"wan2",face:"2萬",group:"萬",name:"2萬",file:"09-characters-2.svg"},
  {id:"wan3",face:"3萬",group:"萬",name:"3萬",file:"10-characters-3.svg"},
  {id:"wan4",face:"4萬",group:"萬",name:"4萬",file:"11-characters-4.svg"},
  {id:"wan5",face:"5萬",group:"萬",name:"5萬",file:"12-characters-5.svg"},
  {id:"wan6",face:"6萬",group:"萬",name:"6萬",file:"13-characters-6.svg"},
  {id:"tong1",face:"1筒",group:"筒",name:"1筒",file:"17-circles-1.svg"},
  {id:"tong2",face:"2筒",group:"筒",name:"2筒",file:"18-circles-2.svg"},
  {id:"tong3",face:"3筒",group:"筒",name:"3筒",file:"19-circles-3.svg"},
  {id:"tong4",face:"4筒",group:"筒",name:"4筒",file:"20-circles-4.svg"},
  {id:"tong5",face:"5筒",group:"筒",name:"5筒",file:"21-circles-5.svg"},
  {id:"tong6",face:"6筒",group:"筒",name:"6筒",file:"22-circles-6.svg"},
  {id:"tiao1",face:"1條",group:"條",name:"1條",file:"26-bamboos-1.svg"},
  {id:"tiao2",face:"2條",group:"條",name:"2條",file:"27-bamboos-2.svg"},
  {id:"tiao3",face:"3條",group:"條",name:"3條",file:"28-bamboos-3.svg"},
  {id:"tiao4",face:"4條",group:"條",name:"4條",file:"29-bamboos-4.svg"},
  {id:"tiao5",face:"5條",group:"條",name:"5條",file:"30-bamboos-5.svg"},
  {id:"tiao6",face:"6條",group:"條",name:"6條",file:"31-bamboos-6.svg"},
  {id:"wan7",face:"7萬",group:"萬",name:"7萬",file:"14-characters-7.svg"},
  {id:"wan8",face:"8萬",group:"萬",name:"8萬",file:"15-characters-8.svg"},
  {id:"wan9",face:"9萬",group:"萬",name:"9萬",file:"16-characters-9.svg"},
  {id:"tong7",face:"7筒",group:"筒",name:"7筒",file:"23-circles-7.svg"},
  {id:"tong8",face:"8筒",group:"筒",name:"8筒",file:"24-circles-8.svg"},
  {id:"tong9",face:"9筒",group:"筒",name:"9筒",file:"25-circles-9.svg"},
  {id:"tiao7",face:"7條",group:"條",name:"7條",file:"32-bamboos-7.svg"},
  {id:"tiao8",face:"8條",group:"條",name:"8條",file:"33-bamboos-8.svg"},
  {id:"tiao9",face:"9條",group:"條",name:"9條",file:"34-bamboos-9.svg"},
  {id:"spring",face:"春",group:"花",name:"春",file:"35-spring.svg"},
  {id:"summer",face:"夏",group:"花",name:"夏",file:"36-summer.svg"},
  {id:"autumn",face:"秋",group:"花",name:"秋",file:"37-autumn.svg"},
  {id:"winter",face:"冬",group:"花",name:"冬",file:"38-winter.svg"},
  {id:"plum",face:"梅",group:"花",name:"梅",file:"39-plum.svg"},
  {id:"orchid",face:"蘭",group:"花",name:"蘭",file:"40-orchid.svg"},
  {id:"chrysanthemum",face:"菊",group:"花",name:"菊",file:"41-chrysanthemum.svg"},
  {id:"bambooFlower",face:"竹",group:"花",name:"竹",file:"42-bamboo.svg"}
];

app.get("/api/admin/new-room-id", (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ success: false, message: "未登入管理員" });
  res.json({ success: true, roomId: generateRoomId() });
});

app.post("/api/admin/create-room", (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ success: false, message: "未登入管理員" });
  }

  const roomId = String(req.body.roomId || generateRoomId()).trim();
  const size = Number(req.body.size);
  const scheduledAt = (req.body.scheduledAt === null || req.body.scheduledAt === undefined || req.body.scheduledAt === "")
    ? null
    : Number(req.body.scheduledAt);
  const countdownSeconds = Number(req.body.countdownSeconds);
  const gameSeconds = Number(req.body.gameSeconds);
  const drawIntervalMs = Number(req.body.drawIntervalMs);
  const note = String(req.body.note || "").trim();
  const targetLines = Number(req.body.targetLines || 1);
  const version = req.body.version === "picture" ? "picture" : "number";
  const theme = version === "picture" ? "mahjong" : null;

  if (!roomId) return res.status(400).json({ success: false, message: "請輸入房間號碼" });
  if (rooms.has(roomId)) return res.status(400).json({ success: false, message: "房間號碼已存在" });
  if (![25, 36, 49, 64].includes(size)) return res.status(400).json({ success: false, message: "盤面格數錯誤" });
  if (version === "picture" && ![25,36].includes(size)) return res.status(400).json({success:false,message:"麻將版目前只開放 5×5、6×6"});
  if (![30, 60, 90].includes(countdownSeconds)) return res.status(400).json({ success: false, message: "倒數秒數錯誤" });
  if (![1,2,3,5,99].includes(targetLines)) return res.status(400).json({ success: false, message: "完成線數設定錯誤" });
  if (![60, 90, 120].includes(gameSeconds)) return res.status(400).json({ success: false, message: "遊戲秒數錯誤" });
  if (![1000,1500,2000,2500,3000,3500,4000,4500,5000].includes(drawIntervalMs)) {
    return res.status(400).json({ success: false, message: "開獎速度錯誤" });
  }
  if (scheduledAt !== null && !Number.isFinite(scheduledAt)) {
    return res.status(400).json({ success: false, message: "開賽日期時間格式錯誤" });
  }
  if (scheduledAt !== null && scheduledAt <= Date.now()) {
    return res.status(400).json({ success: false, message: "開賽日期時間必須晚於現在" });
  }

  const room = {
    id: roomId,
    version,
    theme,
    items: version === "picture" ? MAHJONG_ITEMS.slice() : null,
    size,
    scheduledAt,
    countdownSeconds,
    gameSeconds,
    drawIntervalMs,
    note,
    targetLines,
    winningToken: null,
    winningAt: null,
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
  if (scheduledAt !== null) {
    t.schedule = setTimeout(() => {
      const current = rooms.get(roomId);
      if (current && current.phase === "waiting") startCountdown(current);
    }, Math.max(0, scheduledAt - Date.now()));
  }

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

app.post("/api/admin/start-room/:roomId", (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ success: false, message: "未登入管理員" });
  const room = rooms.get(String(req.params.roomId || "").trim());
  if (!room) return res.status(404).json({ success: false, message: "找不到房間" });
  if (room.phase !== "waiting") {
    return res.status(400).json({ success: false, message: room.phase === "countdown" ? "遊戲已在倒數" : room.phase === "playing" ? "遊戲已開始" : "遊戲已結束" });
  }
  startCountdown(room);
  res.json({ success: true, room: roomInfo(room) });
});

app.post("/api/admin/end-room/:roomId", (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ success: false, message: "未登入管理員" });
  const room = rooms.get(String(req.params.roomId || "").trim());
  if (!room) return res.status(404).json({ success: false, message: "找不到房間" });
  if (room.phase === "ended") return res.json({ success: true, room: roomInfo(room) });
  finishGame(room);
  res.json({ success: true, room: roomInfo(room) });
});

app.delete("/api/admin/room/:roomId", (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ success: false, message: "未登入管理員" });
  const roomId = String(req.params.roomId || "").trim();
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ success: false, message: "找不到房間" });
  clearRoomTimers(roomId);
  io.to(roomId).emit("roomDeleted");
  rooms.delete(roomId);
  timers.delete(roomId);
  res.json({ success: true });
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

  socket.on("joinRoom", ({ roomId, name, clientId }) => {
    const room = rooms.get(String(roomId || "").trim());
    const cleanName = String(name || "").trim();
    const cleanClientId = String(clientId || "").trim();

    if (!room) return socket.emit("joinError", "找不到這個房間");
    if (!cleanName) return socket.emit("joinError", "請輸入玩家名稱");
    if (!cleanClientId) return socket.emit("joinError", "玩家識別資料遺失，請重新整理後再試");
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

    // 完成條件：1/2/3/5 代表 Bingo 線數；99 代表整張盤面全部點完。
    const completed = room.targetLines === 99
      ? newHits >= room.size
      : newLines >= room.targetLines;

    if (completed && !player.finishAt) {
      // 同一個叫號期間達標者使用相同完成時間，視為共同完成，
      // 不讓 Socket 回報速度影響名次。
      if (!room.winningToken) {
        room.winningToken = room.drawToken;
        room.winningAt = Date.now();
      }
      if (room.winningToken === room.drawToken) {
        player.finishAt = room.winningAt;
      }
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
