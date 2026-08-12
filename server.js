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

  // 静的な画像ファイル（public/ 直下）の配信
  const IMAGE_EXT_TYPES = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  };
  const imageExt = Object.keys(IMAGE_EXT_TYPES).find(ext => url.toLowerCase().endsWith(ext));
  if (imageExt && !url.includes('..') && url.indexOf('/', 1) === -1) {
    const filePath = path.join(__dirname, 'public', decodeURIComponent(url.slice(1)));
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': IMAGE_EXT_TYPES[imageExt] });
      res.end(data);
    });
    return;
  }

  // index.html以外の独立したページ（ルール説明・アップデート内容など）。
  // 拡張子ありなしの両方（/rules.html と /rules）で開けるようにする。
  // ここに列挙したものだけを配信し、public/配下の任意のファイルは公開しない。
  const SUB_PAGES = ['rules', 'updates', 'qa'];
  const pageName = url.replace(/^\//, '').replace(/\.html$/i, '');
  if (SUB_PAGES.includes(pageName)) {
    const filePath = path.join(__dirname, 'public', pageName + '.html');
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
// Player: { id, name, ready, result }
// gameState: 'waiting' | 'playing' | 'finished'
const rooms = new Map();

function genRoomId() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

// プレイヤーの識別子。ハンドルネームは重複しうる（未入力時は全員「名無し」になる）ため、
// 「リザルトのどの行が自分か」をクライアント側で判別するために使う。
function genPlayerId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const ws of room.players.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// 団体戦のチーム名を正規化する。空欄は「チームA」「チームB」…で補う。
// チーム数は2〜10のみ許可し、範囲外・非配列は団体戦として成立しないため null を返す。
function sanitizeTeams(raw) {
  if (!Array.isArray(raw)) return null;
  if (raw.length < 2 || raw.length > 10) return null;
  return raw.map((t, i) => {
    const s = (typeof t === 'string') ? t.replace(/[\r\n\t]/g, ' ').trim().slice(0, 20) : '';
    return s.length > 0 ? s : 'チーム' + String.fromCharCode(65 + i); // チームA..チームJ
  });
}

function roomState(room, roomId) {
  const players = [];
  for (const [ws, p] of room.players) {
    players.push({ name: p.name, imeRule: p.imeRule, ready: p.ready,
                   isHost: ws === room.hostWs, teamId: p.teamId });
  }
  return { type: 'ROOM_STATE', roomId, players, gameState: room.gameState,
           textName: room.textName, serverName: room.serverName || null,
           duration: room.duration, defaultRule: room.defaultRule,
           mode: room.mode, teams: room.teams };
}

function buildResults(room) {
  const results = [];
  for (const [, p] of room.players) {
    results.push({
      id: p.id,
      name: p.name,
      imeRule: p.imeRule,
      teamId: p.teamId,
      totalChars: p.result ? p.result.totalChars : null,
      scores: p.result ? p.result.scores : null,
      // 入力内容そのものを配る。各クライアントが手元の課題文と突き合わせて
      // 正誤判定（diff）を描画するため、整形済みHTMLではなく素のテキストを渡す。
      input: p.result ? p.result.input : null,
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
        // プレイ時間は1〜10分（60〜600秒）の1分刻みのみ許可。
        // 範囲外・非整数・未指定はすべて既定の10分にフォールバックする。
        const durationMin = Math.round(Number(msg.duration) / 60);
        const duration = (Number.isInteger(durationMin) && durationMin >= 1 && durationMin <= 10)
          ? durationMin * 60 : 600;
        // IMEレギュレーションは3種のみ許可、未指定・不正値は normal にフォールバック
        const IME_ALLOWED = ['normal','mainichi','warpro','kanjichoku'];
        let imeRule = 'normal';
        if (msg.imeRule != null) {
          if (IME_ALLOWED.includes(msg.imeRule)) imeRule = msg.imeRule;
          else console.warn(`[CREATE_ROOM] Invalid imeRule '${msg.imeRule}' from ${msg.name}, falling back to 'normal'`);
        }
        // サーバー上の課題文ファイル名が指定されていれば、リストと照合してダウンロード可否を確定
        const serverName = (typeof msg.serverName === 'string' && availableTexts.some(t => t.name === msg.serverName))
          ? msg.serverName : null;
        // 団体戦はチーム名リストが正しく揃っている場合のみ成立させ、
        // 不正な場合は個人戦にフォールバックする（チーム無しの団体戦を作らせない）
        const teams = (msg.mode === 'team') ? sanitizeTeams(msg.teams) : null;
        const mode = teams ? 'team' : 'individual';
        if (msg.mode === 'team' && !teams) {
          console.warn(`[CREATE_ROOM] Invalid teams from ${msg.name}, falling back to individual mode`);
        }
        const room = {
          hostWs: ws,
          text: msg.text || '',
          textName: msg.textName || '課題文',
          serverName,                      // ダウンロード可能なサーバー側ファイル名（無ければnull）
          defaultRule: msg.defaultRule || 'warpro',
          duration,
          mode,                            // 'individual' | 'team'
          teams,                           // 団体戦のチーム名配列（個人戦ではnull）
          players: new Map(),
          gameState: 'waiting',
          timerInterval: null,
          // チャットの連投制限用。ルームのみに保持し、履歴自体は残さない
          // （リレーするだけなのでルーム破棄と同時に自然に消える）
          chatLastSenderId: null,
          chatStreak: 0,
        };
        const hostId = genPlayerId();
        room.players.set(ws, { id: hostId, name: msg.name, imeRule, teamId: null, ready: false, result: null, connected: true });
        rooms.set(roomId, room);
        currentRoomId = roomId;
        ws.send(JSON.stringify({ type: 'ROOM_CREATED', roomId, playerId: hostId }));
        broadcast(room, roomState(room, roomId));
        console.log(`Room created: ${roomId} by ${msg.name} (duration ${duration}s, IME ${imeRule}, mode ${mode}${teams ? ` [${teams.join(', ')}]` : ''}, serverName ${serverName || '-'})`);
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
          if (['normal','mainichi','warpro','kanjichoku'].includes(msg.imeRule)) imeRule = msg.imeRule;
          else console.warn(`[JOIN_ROOM] Invalid imeRule '${msg.imeRule}' from ${msg.name}, falling back to 'normal'`);
        }
        const guestId = genPlayerId();
        room.players.set(ws, { id: guestId, name: msg.name, imeRule, teamId: null, ready: false, result: null, connected: true });
        currentRoomId = msg.roomId;
        ws.send(JSON.stringify({ type: 'JOIN_OK', roomId: msg.roomId, textName: room.textName, playerId: guestId }));
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

      // ── チーム選択（団体戦のみ） ─────────────────────────────
      case 'SET_TEAM': {
        const room = rooms.get(currentRoomId);
        if (!room || room.mode !== 'team') return;
        // 開始後の変更は順位表の集計と食い違うため、ロビー段階のみ受け付ける
        if (room.gameState !== 'waiting') return;
        const player = room.players.get(ws);
        if (!player) return;
        const t = msg.teamId;
        if (t == null) player.teamId = null;                                   // チームなし
        else if (Number.isInteger(t) && t >= 0 && t < room.teams.length) player.teamId = t;
        else return;                                                           // 不正値は黙って無視
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
          // リザルトのチーム合計得点で使う。開始後は ROOM_STATE が届かない場合があるため
          // ここでも配り、各クライアントが確実にチーム名を持てるようにする
          mode: room.mode,
          teams: room.teams,
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
          // 他プレイヤーの正誤判定表示用。課題文より極端に長い入力は
          // 中継する意味がないため、念のため上限を設けて切り詰める。
          input: (typeof msg.input === 'string') ? msg.input.slice(0, 20000) : '',
        };
        broadcast(room, { type: 'RESULTS_UPDATE', results: buildResults(room) });
        break;
      }

      // ── ロビーチャット ───────────────────────────────────────
      case 'CHAT_MESSAGE': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const player = room.players.get(ws);
        if (!player) return;

        // 改行・制御文字を除去し、最大200文字に切り詰める。
        // HTMLエスケープはクライアント側でtextContent描画により行うため、
        // ここでは長さ・空文字のみをチェックする。
        const raw = typeof msg.text === 'string' ? msg.text : '';
        const text = raw.replace(/[\r\n\t]/g, ' ').trim().slice(0, 200);
        if (!text) return;

        // 連投制限：同一プレイヤーの連続投稿は15回まで。他プレイヤーが発言するとリセットされる
        if (room.chatLastSenderId !== player.id) {
          room.chatLastSenderId = player.id;
          room.chatStreak = 0;
        }
        if (room.chatStreak >= 15) {
          ws.send(JSON.stringify({
            type: 'CHAT_ERROR',
            message: '連続投稿は15回までです。他の人が発言すると解除されます。',
          }));
          return;
        }
        room.chatStreak++;

        broadcast(room, { type: 'CHAT_MESSAGE', playerId: player.id, name: player.name, text });
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
