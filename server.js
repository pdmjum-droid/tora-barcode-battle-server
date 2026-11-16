// とらのバーコードバトル — ネットたいせん 中継サーバー
// ベース: とらのごもく あいことば対戦 中継サーバー（部屋管理の枠組みを流用）
// 役割: 部屋（4桁番号）の管理、部屋名・プライベート設定、クイックマッチ、
//       両者のチーム（バーコード列）と じゅんびOK の集約、対戦シードの配布、
//       相手への中継、切断の通知。
// バトル自体はオートで、各端末が「同じバーコード→同じ戦士」の生成と
// 共有シードで再現する前提なので、サーバーは手を打つ中継をしない。
// 個人情報は一切扱わない。部屋はメモリ上のみ、解散/切断で消える。
"use strict";
const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8377;
// 相手が来ない部屋の寿命 (user spec 2026-11-15: 10分で自動解散)
// テスト用に環境変数で短縮できる (本番は既定の10分)。
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS) || 10 * 60 * 1000;
// 対戦相手がそろった後の無操作タイムアウト: 片方が10分間うごかないと、
// 両方に idle_timeout を知らせて部屋を閉じる。
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS) || 10 * 60 * 1000;
const IDLE_SWEEP_MS = Math.max(250, Math.min(30000, Math.floor(IDLE_TIMEOUT_MS / 2)));

const rooms = new Map(); // code -> room

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(room, obj) {
  room.players.forEach((p) => p && send(p.ws, obj));
}
function cleanupRoom(room) {
  if (room.ttl) clearTimeout(room.ttl);
  rooms.delete(room.code);
}
function genCode() {
  for (let tries = 0; tries < 50; tries++) {
    const code = String(Math.floor(1000 + Math.random() * 9000)); // 4桁
    if (!rooms.has(code)) return code;
  }
  return String(Math.floor(100000 + Math.random() * 900000)); // 混雑時は6桁
}
function cleanName(name) {
  const s = String(name || "").replace(/[<>&"'-]/g, "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 10);
  return s || "たのしい へや";
}
function validTeam(team) {
  return Array.isArray(team) && team.length >= 1 && team.length <= 5 &&
    team.every((c) => typeof c === "string" && (/^\d{13}$/.test(c) || /^\d{8}$/.test(c)));
}

function makeRoom(code, hostWs, { name, isPrivate, team }) {
  const room = {
    code,
    name,
    isPrivate: !!isPrivate,
    players: [{ ws: hostWs, team, ready: false }], // [0]=ホスト, [1]=ゲスト
    started: false,
    seed: null,
    rematchWants: new Set(),
    ttl: null,
    lastActivity: Date.now(),
  };
  room.ttl = setTimeout(() => {
    if (room.players.length < 2) {
      send(hostWs, { type: "room_expired" });
      cleanupRoom(room);
    }
  }, ROOM_TTL_MS);
  hostWs._room = room;
  rooms.set(code, room);
  return room;
}

function joinRoom(room, guestWs, team) {
  room.players.push({ ws: guestWs, team, ready: false });
  guestWs._room = room;
  room.lastActivity = Date.now();
  const guest = room.players[1];
  send(guest.ws, { type: "joined", code: room.code, name: room.name, isPrivate: room.isPrivate, hostTeamSize: room.players[0].team.length });
  send(room.players[0].ws, { type: "opponent_joined", teamSize: team.length });
}

function readyState(room) {
  return { type: "ready_state", ready: room.players.map((p) => !!p.ready) };
}

function startBattle(room) {
  room.started = true;
  room.seed = Math.floor(Math.random() * 0x7fffffff);
  room.lastActivity = Date.now();
  if (room.ttl) { clearTimeout(room.ttl); room.ttl = null; }
  broadcast(room, { type: "start", seed: room.seed, teams: room.players.map((p) => p.team) });
}

function leaveRoom(ws) {
  const room = ws._room;
  if (!room) return;
  ws._room = null;
  const idx = room.players.findIndex((p) => p && p.ws === ws);
  const isHost = idx === 0;
  // 対戦開始前にゲストが抜けた場合は部屋を残し、ホストは待機に戻る（同じ番号・クイックマッチで入り直せる）
  const roomAlive = !isHost && !room.started && room.players.length >= 2;
  // 相手への通知は全フェーズで行う（待機中・対戦中・結果待ちすべて）。
  room.players.forEach((p) => { if (p && p.ws !== ws) send(p.ws, { type: "opponent_left", roomAlive }); });
  if (!roomAlive) { cleanupRoom(room); return; }
  room.players.splice(idx, 1);
  room.players.forEach((p) => { if (p) p.ready = false; });
  room.lastActivity = Date.now();
  if (room.ttl) clearTimeout(room.ttl);
  room.ttl = setTimeout(() => {
    if (room.players.length < 2) {
      send(room.players[0].ws, { type: "room_expired" });
      cleanupRoom(room);
    }
  }, ROOM_TTL_MS);
}

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  } else {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("tora-barcode-battle net server");
  }
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: 4096 });
wss.on("connection", (ws) => {
  ws._room = null;
  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch (e) { return; }
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "create") {
      if (!validTeam(msg.team)) { send(ws, { type: "error", reason: "bad_team" }); return; }
      if (ws._room) leaveRoom(ws);
      const code = genCode();
      const room = makeRoom(code, ws, { name: cleanName(msg.name), isPrivate: msg.isPrivate, team: msg.team });
      send(ws, { type: "created", code: room.code, name: room.name, isPrivate: room.isPrivate });
      return;
    }
    if (msg.type === "join") {
      const code = String(msg.code || "");
      if (!/^\d{4,6}$/.test(code)) { send(ws, { type: "error", reason: "bad_code" }); return; }
      if (!validTeam(msg.team)) { send(ws, { type: "error", reason: "bad_team" }); return; }
      const room = rooms.get(code);
      if (!room) { send(ws, { type: "error", reason: "no_room" }); return; }
      if (room.players.length >= 2) { send(ws, { type: "error", reason: "full" }); return; }
      if (room.started) { send(ws, { type: "error", reason: "started" }); return; }
      if (ws._room) leaveRoom(ws);
      joinRoom(room, ws, msg.team);
      return;
    }
    if (msg.type === "quick") {
      if (!validTeam(msg.team)) { send(ws, { type: "error", reason: "bad_team" }); return; }
      if (ws._room) leaveRoom(ws);
      // 公開の待機部屋（ホスト1人だけ・未開始）があればそこへ、なければ自分がホストで待つ
      let target = null;
      rooms.forEach((room) => {
        if (!target && !room.isPrivate && !room.started && room.players.length === 1) target = room;
      });
      if (target) { joinRoom(target, ws, msg.team); return; }
      const code = genCode();
      const room = makeRoom(code, ws, { name: "クイックマッチ", isPrivate: false, team: msg.team });
      send(ws, { type: "created", code: room.code, name: room.name, isPrivate: false, via: "quick" });
      return;
    }
    if (msg.type === "list") {
      // クイックマッチの部屋リスト用：入れる部屋（公開・未開始・ホスト1人待ち）の一覧を返す
      const list = [];
      rooms.forEach((room) => {
        if (!room.isPrivate && !room.started && room.players.length === 1) {
          list.push({ code: room.code, name: room.name, teamSize: room.players[0].team.length });
        }
      });
      send(ws, { type: "rooms", rooms: list });
      return;
    }
    const room = ws._room;
    if (!room) return;
    const me = room.players.find((p) => p && p.ws === ws);
    if (!me) return;

    if (msg.type === "ready") {
      if (room.started || room.players.length < 2) return;
      me.ready = true;
      room.lastActivity = Date.now();
      broadcast(room, readyState(room));
      if (room.players.every((p) => p.ready)) startBattle(room);
      return;
    }
    if (msg.type === "rematch") {
      if (!room.started) return;
      if (validTeam(msg.team)) me.team = msg.team;
      me.ready = false;
      room.lastActivity = Date.now();
      room.rematchWants.add(room.players.indexOf(me));
      if (room.rematchWants.size >= 2) {
        room.rematchWants.clear();
        room.started = false;
        room.seed = null;
        room.players.forEach((p) => { p.ready = false; });
        broadcast(room, { type: "rematch_ok" });
      } else {
        room.players.forEach((p) => { if (p && p.ws !== ws) send(p.ws, { type: "rematch_offer" }); });
      }
      return;
    }
    if (msg.type === "stamp") {
      const STAMPS = ["よろしく！", "ありがとう！", "すごい！", "もういちど！"];
      if (STAMPS.includes(msg.stamp)) {
        room.lastActivity = Date.now();
        room.players.forEach((pl) => { if (pl && pl.ws !== ws) send(pl.ws, { type: "stamp", stamp: msg.stamp }); });
      }
      return;
    }
    if (msg.type === "leave") { leaveRoom(ws); return; }
  });
  ws.on("close", () => leaveRoom(ws));
  ws.on("error", () => leaveRoom(ws));
});

// 無操作の部屋を見回る: 対戦相手がそろった部屋で最後の活動から
// IDLE_TIMEOUT_MS 経つと、両方へ idle_timeout を送って部屋を閉じる。
// 相手が来ない部屋は TTL (room_expired) が担当するので、ここでは扱わない。
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room) => {
    if (room.players.length < 2) return;
    if (now - room.lastActivity > IDLE_TIMEOUT_MS) {
      broadcast(room, { type: "idle_timeout" });
      room.players.forEach((p) => { if (p) p.ws._room = null; });
      cleanupRoom(room);
    }
  });
}, IDLE_SWEEP_MS);

httpServer.listen(PORT, () => {
  console.log("barcode-battle net server listening on :" + PORT);
});
