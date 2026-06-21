const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;

// ── HTTP サーバー（index.html を配信） ──────────────────────────
const httpServer = http.createServer((req, res) => {
  const filePath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

// ── WebSocket サーバー ───────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

// rooms: Map<roomId, Room>
// Room: { hostWs, text, textName, players: Map<ws, Player>, gameState }
// Player: { name, ready, result }
// gameState: 'waiting' | 'playing' | 'finished'
const rooms = new Map();

function genRoomId() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const ws of room.players.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function roomState(room, roomId) {
  const players = [];
  for (const [ws, p] of room.players) {
    players.push({ name: p.name, ready: p.ready, isHost: ws === room.hostWs });
  }
  return { type: 'ROOM_STATE', roomId, players, gameState: room.gameState };
}

wss.on('connection', (ws) => {
  let currentRoomId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ハンドルネーム・課題文名をサーバー側でも正規化する
    // （クライアントのmaxlengthは回避され得るため、サーバーでも上限を設ける）
    const sanitizeName = (s) => {
      if (typeof s !== 'string') return '名無し';
      const trimmed = s.replace(/[\r\n\t]/g, ' ').trim().slice(0, 20);
      return trimmed.length > 0 ? trimmed : '名無し';
    };
    if (typeof msg.name === 'string') msg.name = sanitizeName(msg.name);
    if (typeof msg.textName === 'string') msg.textName = msg.textName.replace(/[\r\n\t]/g, ' ').trim().slice(0, 80);

    switch (msg.type) {

      // ── ルーム作成 ───────────────────────────────────────────
      case 'CREATE_ROOM': {
        const roomId = genRoomId();
        const room = {
          hostWs: ws,
          text: msg.text || '',
          textName: msg.textName || '課題文',
          defaultRule: msg.defaultRule || 'warpro',
          players: new Map(),
          gameState: 'waiting',
          timerInterval: null,
        };
        room.players.set(ws, { name: msg.name, ready: false, result: null });
        rooms.set(roomId, room);
        currentRoomId = roomId;
        ws.send(JSON.stringify({ type: 'ROOM_CREATED', roomId }));
        broadcast(room, roomState(room, roomId));
        console.log(`Room created: ${roomId} by ${msg.name}`);
        break;
      }

      // ── ルーム参加 ───────────────────────────────────────────
      case 'JOIN_ROOM': {
        const room = rooms.get(msg.roomId);
        if (!room) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'ルームが見つかりません' }));
          return;
        }
        if (room.gameState !== 'waiting') {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'ゲームはすでに開始しています' }));
          return;
        }
        room.players.set(ws, { name: msg.name, ready: false, result: null });
        currentRoomId = msg.roomId;
        ws.send(JSON.stringify({ type: 'JOIN_OK', roomId: msg.roomId, textName: room.textName }));
        broadcast(room, roomState(room, msg.roomId));
        console.log(`${msg.name} joined room ${msg.roomId}`);
        break;
      }

      // ── スタンバイ切り替え ───────────────────────────────────
      case 'SET_READY': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const player = room.players.get(ws);
        if (!player) return;
        player.ready = msg.ready;
        broadcast(room, roomState(room, currentRoomId));
        break;
      }

      // ── ゲーム開始（ホストのみ） ─────────────────────────────
      case 'START_GAME': {
        const room = rooms.get(currentRoomId);
        if (!room || ws !== room.hostWs) return;

        // 全員スタンバイチェック（ホスト自身は対象外）
        // msg.force が true の場合は警告を無視して開始する
        const notReady = [];
        for (const [pw, p] of room.players) {
          if (pw === room.hostWs) continue; // ホストは対象外
          if (!p.ready) notReady.push(p.name);
        }
        if (notReady.length > 0 && !msg.force) {
          ws.send(JSON.stringify({
            type: 'NOT_READY_WARNING',
            notReady,
          }));
          return;
        }

        room.gameState = 'playing';
        const startAt = Date.now() + 3000; // 3秒カウントダウン後開始
        broadcast(room, {
          type: 'GAME_START',
          startAt,
          text: room.text,
          textName: room.textName,
          defaultRule: room.defaultRule,
        });
        console.log(`Game started in room ${currentRoomId}`);

        // サーバー側タイマー（600秒後に強制終了）
        room.timerInterval = setTimeout(() => {
          if (rooms.has(currentRoomId)) {
            room.gameState = 'finished';
            broadcast(room, { type: 'TIME_UP' });
          }
        }, 600000 + 3000);
        break;
      }

      // ── 結果送信 ─────────────────────────────────────────────
      case 'SUBMIT_RESULT': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const player = room.players.get(ws);
        if (!player) return;
        player.result = {
          totalChars: msg.totalChars,
          scores: msg.scores, // {warpro:{points,miss}, mainichi:{...}, intersteno:{...}}
        };
        // 全員の結果を集計して配信
        const results = [];
        for (const [, p] of room.players) {
          results.push({
            name: p.name,
            totalChars: p.result ? p.result.totalChars : null,
            scores: p.result ? p.result.scores : null,
          });
        }
        broadcast(room, { type: 'RESULTS_UPDATE', results });
        break;
      }

      // ── ルームに戻る（再戦） ─────────────────────────────────
      case 'RETURN_TO_LOBBY': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        // ゲーム状態リセット
        if (ws === room.hostWs) {
          clearTimeout(room.timerInterval);
          room.gameState = 'waiting';
          for (const [, p] of room.players) {
            p.ready = false;
            p.result = null;
          }
          broadcast(room, roomState(room, currentRoomId));
        }
        break;
      }
    }
  });

  // ── 切断処理 ─────────────────────────────────────────────────
  ws.on('close', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    room.players.delete(ws);
    if (room.players.size === 0) {
      clearTimeout(room.timerInterval);
      rooms.delete(currentRoomId);
      console.log(`Room ${currentRoomId} deleted (empty)`);
    } else {
      // ホストが抜けた場合は次のプレイヤーをホストにする
      if (ws === room.hostWs) {
        room.hostWs = room.players.keys().next().value;
      }
      broadcast(room, roomState(room, currentRoomId));
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
