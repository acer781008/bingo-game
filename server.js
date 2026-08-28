const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ==============================
// 管理員密碼
// ==============================
const ADMIN_PASSWORD = "1100829";

// 已登入管理員
const adminSessions = new Set();

// 遊戲房間
const rooms = {};

app.use(express.json());

// ==============================
// Cookie
// ==============================
function getCookies(req) {
    const cookies = {};
    const cookieHeader = req.headers.cookie;

    if (!cookieHeader) {
        return cookies;
    }

    cookieHeader.split(";").forEach(cookie => {
        const parts = cookie.trim().split("=");
        cookies[parts[0]] = parts.slice(1).join("=");
    });

    return cookies;
}

// ==============================
// 檢查管理員
// ==============================
function isAdmin(req) {
    const cookies = getCookies(req);
    const token = cookies.admin_session;

    return token && adminSessions.has(token);
}

// ==============================
// 管理員登入
// ==============================
app.post("/api/admin/login", (req, res) => {
    const password = req.body.password;

    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({
            success: false,
            message: "管理員密碼錯誤"
        });
    }

    const token = crypto.randomBytes(32).toString("hex");

    adminSessions.add(token);

    res.setHeader(
        "Set-Cookie",
        `admin_session=${token}; HttpOnly; Path=/; SameSite=Lax`
    );

    res.json({
        success: true
    });
});

// ==============================
// 管理員登出
// ==============================
app.post("/api/admin/logout", (req, res) => {
    const cookies = getCookies(req);
    const token = cookies.admin_session;

    if (token) {
        adminSessions.delete(token);
    }

    res.setHeader(
        "Set-Cookie",
        "admin_session=; HttpOnly; Path=/; Max-Age=0"
    );

    res.json({
        success: true
    });
});

// ==============================
// 保護主控室
// ==============================
app.get("/admin.html", (req, res) => {
    if (!isAdmin(req)) {
        return res.redirect("/admin-login.html");
    }

    res.sendFile(
        path.join(__dirname, "public", "admin.html")
    );
});

// ==============================
// 建立房間 API
// ==============================
app.post("/api/admin/create-room", (req, res) => {

    if (!isAdmin(req)) {
        return res.status(401).json({
            success: false,
            message: "未登入管理員"
        });
    }

    const roomId = String(req.body.roomId || "").trim();
    const size = Number(req.body.size);

    const allowedSizes = [25, 36, 49, 64];

    if (!roomId) {
        return res.status(400).json({
            success: false,
            message: "請輸入房間號碼"
        });
    }

    if (!allowedSizes.includes(size)) {
        return res.status(400).json({
            success: false,
            message: "格數錯誤"
        });
    }

    if (rooms[roomId]) {
        return res.status(400).json({
            success: false,
            message: "房間已存在"
        });
    }

    rooms[roomId] = {
        roomId: roomId,
        size: size,
        players: {},
        drawn: [],
        started: false
    };

    res.json({
        success: true,
        room: {
            roomId: roomId,
            size: size,
            playerCount: 0
        }
    });
});
// ==============================
// 開始遊戲 API
// ==============================
app.post("/api/admin/start-game", (req, res) => {
    if (!isAdmin(req)) {
        return res.status(401).json({
            success: false,
            message: "未登入管理員"
        });
    }

    const roomId = String(req.body.roomId || "").trim();
    const room = rooms[roomId];

    if (!room) {
        return res.status(404).json({
            success: false,
            message: "找不到房間"
        });
    }

    room.started = true;

    io.to(roomId).emit("gameStarted");

    res.json({
        success: true
    });
});// ==============================
// 開下一個號碼 API
// ==============================
app.post("/api/admin/draw-number", (req, res) => {
    if (!isAdmin(req)) {
        return res.status(401).json({
            success: false,
            message: "未登入管理員"
        });
    }

    const roomId = String(req.body.roomId || "").trim();
    const room = rooms[roomId];

    if (!room) {
        return res.status(404).json({
            success: false,
            message: "找不到房間"
        });
    }

    if (!room.started) {
        return res.status(400).json({
            success: false,
            message: "遊戲尚未開始"
        });
    }

    const available = [];

    for (let i = 1; i <= room.size; i++) {
        if (!room.drawn.includes(i)) {
            available.push(i);
        }
    }

    if (available.length === 0) {
        return res.status(400).json({
            success: false,
            message: "所有號碼都已開完"
        });
    }

    const number =
        available[Math.floor(Math.random() * available.length)];

    room.drawn.push(number);

    io.to(roomId).emit("numberDrawn", {
        number: number
    });

    res.json({
        success: true,
        number: number
    });
}); 
// ==============================
// 查詢房間
// ==============================
app.get("/api/room/:roomId", (req, res) => {

    const roomId = req.params.roomId;
    const room = rooms[roomId];

    if (!room) {
        return res.status(404).json({
            success: false,
            message: "找不到房間"
        });
    }

    res.json({
        success: true,
        room: {
            roomId: room.roomId,
            size: room.size,
            playerCount: Object.keys(room.players).length,
            started: room.started
        }
    });
});

// 一般網頁
app.use(express.static("public"));

// ==============================
// Socket.IO
// ==============================
io.on("connection", (socket) => {

    console.log("有人連線：" + socket.id);

    // 玩家加入房間
    socket.on("joinRoom", ({ roomId, name }) => {

        roomId = String(roomId || "").trim();
        name = String(name || "").trim();

        const room = rooms[roomId];

        if (!room) {
            socket.emit("joinError", "找不到這個房間");
            return;
        }

        if (!name) {
            socket.emit("joinError", "請輸入玩家名稱");
            return;
        }
if (room.started) {
    socket.emit("joinError", "遊戲已開始，無法再加入");
    return;
}
        socket.join(roomId);
for (const id in room.players) {
    if (room.players[id].name === name) {
        delete room.players[id];
    }
}

        room.players[socket.id] = {
            id: socket.id,
            name: name,
            score: 0
        };

        socket.data.roomId = roomId;

        socket.emit("joinSuccess", {
            roomId: room.roomId,
            size: room.size
        });

        io.to(roomId).emit("playersUpdate", {
            count: Object.keys(room.players).length,
            players: Object.values(room.players)
        });
    });
// 玩家按對號碼，加 1 分
socket.on("addScore", (stats) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms[roomId];
    if (!room) return;

    const player = room.players[socket.id];
    if (!player) return;

    player.hitCount = Number(stats.hitCount) || 0;
player.bingoLines = Number(stats.bingoLines) || 0;

    const ranking = Object.values(room.players)
    .sort((a, b) => {
        if ((b.bingoLines || 0) !== (a.bingoLines || 0)) {
            return (b.bingoLines || 0) - (a.bingoLines || 0);
        }

        return (b.hitCount || 0) - (a.hitCount || 0);
    });

    io.to(roomId).emit("playersUpdate", {
        count: ranking.length,
        players: ranking
    });
});
    // 離線
    socket.on("disconnect", () => {

        const roomId = socket.data.roomId;

        if (!roomId) {
            return;
        }

        const room = rooms[roomId];

        if (!room) {
            return;
        }

        delete room.players[socket.id];

        io.to(roomId).emit("playersUpdate", {
            count: Object.keys(room.players).length,
            players: Object.values(room.players)
        });

        console.log("玩家離線：" + socket.id);
    });
});

// ==============================
// 啟動伺服器
// ==============================
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log("==========================");
    console.log("數字賓果伺服器啟動成功！");
    console.log("http://localhost:3000");
    console.log("==========================");
});