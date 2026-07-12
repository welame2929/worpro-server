const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const HEARTBEAT_INTERVAL_MS = 30000;

// ── サーバー側課題文の読み込み ─────────────────────────────────
// public/texts/ 配下の .txt をサーバー起動時に1回スキャンしてメモリに保持
const TEXTS_DIR = path.join(__dirname, 'public', 'texts');
const availableTexts = []; // [{name, content}]
function loadAvailableTexts() {
  availableTexts.length = 0;
  try {
    if (!fs.existsSync(TEXTS_DIR)) {
      console.log(`No texts directory at ${TEXTS_DIR}`);
      return;
    }
    const files = fs.readdirSync(TEXTS_DIR)
      .filter(f => f.toLowerCase().endsWith('.txt'))
      .sort();
    for (const fname of files) {
      try {
        const content = fs.readFileSync(path.join(TEXTS_DIR, fname), 'utf8');
        availableTexts.push({ name: fname, content });
      } catch (e) {
        console.error(`Failed to read ${fname}:`, e.message);
      }
    }
    console.log(`Loaded ${availableTexts.length} server-side text(s): ${availableTexts.map(t => t.name).join(', ')}`);
  } catch (e) {
    console.error('Failed to scan texts directory:', e.message);
  }
}
loadAvailableTexts();

// ── HTTP サーバー ───────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const url = req.url || '/';

  // 課題文一覧 API（ファイル名のみ返す軽量レスポンス）
  if (url === '/api/texts') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ texts: availableTexts.map(t => ({ name: t.name })) }));
    return;
  }

  // 個別課題文ダウンロード（/texts/<filename>）
  if (url.startsWith('/texts/')) {
    const name = decodeURIComponent(url.slice('/texts/'.length));
    // パストラバーサル対策：ファイル名に / や .. を含むものは拒否
    if (name.includes('/') || name.includes('\\') || name.includes('..') || !name.toLowerCase().endsWith('.txt')) {
      res.writeHead(400); res.end('Bad request'); return;
    }
    const found = availableTexts.find(t => t.name === name);
    if (!found) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    res.end(found.content);
    return;
  }

  // アップデート内容ページ
  if (url === '/updates.html' || url === '/updates') {
    const filePath = path.join(__dirname, 'public', 'updates.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // ルートまたはその他のパスは index.html を返す
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
    players.push({ name: p.name, imeRule: p.imeRule, ready: p.ready, isHost: ws === room.hostWs });
  }
  return { type: 'ROOM_STATE', roomId, players, gameState: room.gameState,
           textName: room.textName, serverName: room.serverName || null,
           duration: room.duration, defaultRule: room.defaultRule };
}

function buildResults(room) {
  const results = [];
  for (const [, p] of room.players) {
    results.push({
      name: p.name,
      imeRule: p.imeRule,
      totalChars: p.result ? p.result.totalChars : null,
      scores: p.result ? p.result.scores : null,
    });
  }
  return results;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

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
        // プレイ時間は300秒(5分)または600秒(10分)のみ許可
        const duration = (msg.duration === 300) ? 300 : 600;
        // IMEレギュレーションは3種のみ許可、未指定・不正値は normal にフォールバック
        const IME_ALLOWED = ['normal','mainichi','warpro'];
        let imeRule = 'normal';
        if (msg.imeRule != null) {
          if (IME_ALLOWED.includes(msg.imeRule)) imeRule = msg.imeRule;
          else console.warn(`[CREATE_ROOM] Invalid imeRule '${msg.imeRule}' from ${msg.name}, falling back to 'normal'`);
        }
        // サーバー上の課題文ファイル名が指定されていれば、リストと照合してダウンロード可否を確定
        const serverName = (typeof msg.serverName === 'string' && availableTexts.some(t => t.name === msg.serverName))
          ? msg.serverName : null;
        const room = {
          hostWs: ws,
          text: msg.text || '',
          textName: msg.textName || '課題文',
          serverName,                      // ダウンロード可能なサーバー側ファイル名（無ければnull）
          defaultRule: msg.defaultRule || 'warpro',
          duration,
          players: new Map(),
          gameState: 'waiting',
          timerInterval: null,
        };
        room.players.set(ws, { name: msg.name, imeRule, ready: false, result: null, connected: true });
        rooms.set(roomId, room);
        currentRoomId = roomId;
        ws.send(JSON.stringify({ type: 'ROOM_CREATED', roomId }));
        broadcast(room, roomState(room, roomId));
        console.log(`Room created: ${roomId} by ${msg.name} (duration ${duration}s, IME ${imeRule}, serverName ${serverName || '-'})`);
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
        let imeRule = 'normal';
        if (msg.imeRule != null) {
          if (['normal','mainichi','warpro'].includes(msg.imeRule)) imeRule = msg.imeRule;
          else console.warn(`[JOIN_ROOM] Invalid imeRule '${msg.imeRule}' from ${msg.name}, falling back to 'normal'`);
        }
        room.players.set(ws, { name: msg.name, imeRule, ready: false, result: null, connected: true });
        currentRoomId = msg.roomId;
        ws.send(JSON.stringify({ type: 'JOIN_OK', roomId: msg.roomId, textName: room.textName }));
        broadcast(room, roomState(room, msg.roomId));
        console.log(`${msg.name} joined room ${msg.roomId} (IME ${imeRule})`);
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
        const countdownMs = 3000; // 各クライアントの受信からNミリ秒後に開始
        broadcast(room, {
          type: 'GAME_START',
          countdownMs,
          text: room.text,
          textName: room.textName,
          defaultRule: room.defaultRule,
          duration: room.duration,
        });
        console.log(`Game started in room ${currentRoomId} (duration ${room.duration}s)`);

        // サーバー側タイマー（指定時間後に強制終了、余裕として+5秒）
        room.timerInterval = setTimeout(() => {
          if (rooms.has(currentRoomId)) {
            room.gameState = 'finished';
            broadcast(room, { type: 'TIME_UP' });
          }
        }, room.duration * 1000 + countdownMs + 5000);
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
          scores: msg.scores,
        };
        broadcast(room, { type: 'RESULTS_UPDATE', results: buildResults(room) });
        break;
      }
    }
  });

  // ── 切断処理 ─────────────────────────────────────────────────
  ws.on('close', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    const player = room.players.get(ws);
    if (!player) return;

    if (room.gameState === 'waiting') {
      // ロビー段階の離脱はこれまで通り即座に一覧から削除
      room.players.delete(ws);
    } else {
      // プレイ中／終了後の離脱は結果を順位表に残すため、Mapからは削除せず
      // 接続フラグだけを落とす（ルームは1ゲームごとの使い切りなので、
      // 全員が切断した時点でルームごと破棄される＝下のanyConnectedチェック）
      player.connected = false;
    }

    if (ws === room.hostWs) {
      // ホストが抜けた場合は、まだ接続中の別プレイヤーに委譲する
      const nextHost = [...room.players.entries()].find(([w, p]) => w !== ws && p.connected !== false);
      room.hostWs = nextHost ? nextHost[0] : null;
    }

    const anyConnected = [...room.players.values()].some(p => p.connected !== false);
    if (!anyConnected) {
      clearTimeout(room.timerInterval);
      rooms.delete(currentRoomId);
      console.log(`Room ${currentRoomId} deleted (all players disconnected)`);
      return;
    }

    broadcast(room, roomState(room, currentRoomId));
    // ゲーム開始後の切断なら、結果集計中のランキング表示も更新させる
    if (room.gameState !== 'waiting') {
      broadcast(room, { type: 'RESULTS_UPDATE', results: buildResults(room) });
    }
  });
});

const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; } // 応答なし→強制切断（closeイベントが発火する）
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeatTimer));

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
