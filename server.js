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

// 条件に合うプレイヤーだけに送る。
// リザルトを見ている人とロビーに戻った人が同居するため、
// ゲーム開始・時間切れなどは「そのラウンドの参加者」に限定して届ける必要がある。
function sendTo(room, predicate, msg) {
  const data = JSON.stringify(msg);
  for (const [ws, p] of room.players) {
    if (ws.readyState === WebSocket.OPEN && predicate(p)) ws.send(data);
  }
}

// 現在のラウンドの参加者（接続中のみ）
function activePlayers(room) {
  return [...room.players.values()].filter(p => p.playingRound === room.round && p.connected !== false);
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

// プレイ時間は1〜10分（60〜600秒）の1分刻みのみ許可。
// 範囲外・非整数・未指定はすべて既定の10分にフォールバックする。
function sanitizeDuration(raw) {
  const durationMin = Math.round(Number(raw) / 60);
  return (Number.isInteger(durationMin) && durationMin >= 1 && durationMin <= 10) ? durationMin * 60 : 600;
}

const RULE_ALLOWED = ['warpro', 'mainichi', 'intersteno'];
function sanitizeRule(raw) {
  return RULE_ALLOWED.includes(raw) ? raw : 'warpro';
}

function roomState(room, roomId) {
  const players = [];
  for (const [ws, p] of room.players) {
    // id を含めるのは、クライアントが「一覧のどれが自分か」を確実に判定するため。
    // 名前は重複しうるので、自分の状態を各自が正しく検知するのに必要になる。
    // inLobby はロビーに戻った人／まだリザルトを見ている人の区別に使う。
    players.push({ id: p.id, name: p.name, imeRule: p.imeRule, ready: p.ready,
                   isHost: ws === room.hostWs, teamId: p.teamId,
                   inLobby: p.inLobby !== false, connected: p.connected !== false });
  }
  return { type: 'ROOM_STATE', roomId, players, gameState: room.gameState,
           textName: room.textName, serverName: room.serverName || null,
           duration: room.duration, defaultRule: room.defaultRule,
           mode: room.mode, teams: room.teams,
           // ホストが離脱するとルームは新しいゲームを開始できなくなる。
           // ロビー側で警告を出せるよう、ホストの在室状況を伝える。
           hostPresent: !!room.hostWs };
}

// 現在のラウンドの参加者だけを対象に順位表データを作る。
// 次のラウンドが始まっても、前ラウンドのリザルトを見ている人の画面が
// 書き換わらないよう、メッセージ側にラウンド番号を添えて配る。
function buildResults(room) {
  const results = [];
  for (const [pw, p] of room.players) {
    if (p.playingRound !== room.round) continue;
    results.push({
      id: p.id,
      name: p.name,
      imeRule: p.imeRule,
      teamId: p.teamId,
      // ホスト権は元ホストの切断時に委譲されるため、リザルト側でも都度伝える
      // （締め切りボタンを出す相手を、その時点のホストに追従させるため）
      isHost: pw === room.hostWs,
      // 接続状態。切断済みのプレイヤーは結果を送ってこないため、
      // クライアントが「まだ入力中の人」と区別して集計完了を判定するのに使う。
      connected: p.connected !== false,
      totalChars: p.result ? p.result.totalChars : null,
      scores: p.result ? p.result.scores : null,
      // 入力内容そのものを配る。各クライアントが手元の課題文と突き合わせて
      // 正誤判定（diff）を描画するため、整形済みHTMLではなく素のテキストを渡す。
      input: p.result ? p.result.input : null,
    });
  }
  return results;
}

// 順位表更新メッセージ。集計を締め切ったかどうか(finalized)も併せて配り、
// 未提出者が残っていてもクライアントが待機表示を止められるようにする。
function resultsUpdate(room) {
  return { type: 'RESULTS_UPDATE', round: room.round,
           results: buildResults(room), finalized: !!room.resultsFinalized };
}

// ラウンド終了の確定。時間切れ、または参加者全員の結果が揃った時点で呼ぶ。
// これを経ないと gameState が 'playing' のままになり、次のゲームを開始できない。
function finishRound(room, roomId) {
  if (room.gameState !== 'playing') return;
  clearTimeout(room.timerInterval);
  room.timerInterval = null;
  room.gameState = 'finished';
  broadcast(room, roomState(room, roomId));
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
        // IMEレギュレーションは3種のみ許可、未指定・不正値は normal にフォールバック
        const IME_ALLOWED = ['normal','mainichi','warpro','kanjichoku'];
        let imeRule = 'normal';
        if (msg.imeRule != null) {
          if (IME_ALLOWED.includes(msg.imeRule)) imeRule = msg.imeRule;
          else console.warn(`[CREATE_ROOM] Invalid imeRule '${msg.imeRule}' from ${msg.name}, falling back to 'normal'`);
        }
        // 団体戦はチーム名リストが正しく揃っている場合のみ成立させ、
        // 不正な場合は個人戦にフォールバックする（チーム無しの団体戦を作らせない）
        const teams = (msg.mode === 'team') ? sanitizeTeams(msg.teams) : null;
        const mode = teams ? 'team' : 'individual';
        if (msg.mode === 'team' && !teams) {
          console.warn(`[CREATE_ROOM] Invalid teams from ${msg.name}, falling back to individual mode`);
        }
        const room = {
          hostWs: ws,
          // 課題文・採点方式・プレイ時間はロビーでホストが決める（UPDATE_ROOM_SETTINGS）。
          // 部屋を再戦で使い回せるようにするため、部屋の作成と設定を分離している。
          text: '',
          textName: null,                  // 未選択（選ばれるまでゲームを開始できない）
          serverName: null,                // ダウンロード可能なサーバー側ファイル名（無ければnull）
          defaultRule: 'warpro',
          duration: 600,
          mode,                            // 'individual' | 'team'
          teams,                           // 団体戦のチーム名配列（個人戦ではnull）
          players: new Map(),
          gameState: 'waiting',
          timerInterval: null,
          // ラウンド番号。ゲーム開始ごとに増やし、結果の配信対象を絞るのに使う。
          // これにより、前ラウンドのリザルトを見ている人と次のラウンドの参加者が同居できる。
          round: 0,
          // チャットの連投制限用。ルームのみに保持し、履歴自体は残さない
          // （リレーするだけなのでルーム破棄と同時に自然に消える）
          chatLastSenderId: null,
          chatStreak: 0,
          // ホストが集計を締め切ったか。未提出者が残っていても順位表を確定させるための逃げ道
          resultsFinalized: false,
        };
        const hostId = genPlayerId();
        // inLobby: ロビーにいるか（falseならリザルト画面を見ている＝次のゲームの対象外）
        // playingRound: 参加したラウンド番号（未参加はnull）
        room.players.set(ws, { id: hostId, name: msg.name, imeRule, teamId: null, ready: false,
                               result: null, connected: true, inLobby: true, playingRound: null });
        rooms.set(roomId, room);
        currentRoomId = roomId;
        ws.send(JSON.stringify({ type: 'ROOM_CREATED', roomId, playerId: hostId }));
        broadcast(room, roomState(room, roomId));
        console.log(`Room created: ${roomId} by ${msg.name} (IME ${imeRule}, mode ${mode}${teams ? ` [${teams.join(', ')}]` : ''})`);
        break;
      }

      // ── ルーム設定の更新（ホストのみ・ロビー段階のみ） ───────
      // 課題文・採点方式・プレイ時間はロビーで決める。再戦のたびに変更できる。
      case 'UPDATE_ROOM_SETTINGS': {
        const room = rooms.get(currentRoomId);
        if (!room || ws !== room.hostWs) return;
        // 進行中のゲームと食い違うため、プレイ中の変更は受け付けない
        // （結果表示中は次のラウンドに向けた変更として許可する）
        if (room.gameState === 'playing') return;
        if (typeof msg.text === 'string') {
          room.text = msg.text;
          room.textName = msg.textName || '課題文';
          // サーバー上の課題文ファイル名は一覧と照合してからダウンロード可否を確定する
          room.serverName = (typeof msg.serverName === 'string' && availableTexts.some(t => t.name === msg.serverName))
            ? msg.serverName : null;
        }
        if (msg.defaultRule != null) room.defaultRule = sanitizeRule(msg.defaultRule);
        if (msg.duration != null) room.duration = sanitizeDuration(msg.duration);
        broadcast(room, roomState(room, currentRoomId));
        break;
      }

      // ── ルーム参加 ───────────────────────────────────────────
      case 'JOIN_ROOM': {
        const room = rooms.get(msg.roomId);
        if (!room) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'ルームが見つかりません' }));
          return;
        }
        // ゲーム進行中のみ入室を断る。結果表示中（finished）は次のゲーム待ちなので入室できる。
        if (room.gameState === 'playing') {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'ゲームはすでに開始しています' }));
          return;
        }
        let imeRule = 'normal';
        if (msg.imeRule != null) {
          if (['normal','mainichi','warpro','kanjichoku'].includes(msg.imeRule)) imeRule = msg.imeRule;
          else console.warn(`[JOIN_ROOM] Invalid imeRule '${msg.imeRule}' from ${msg.name}, falling back to 'normal'`);
        }
        const guestId = genPlayerId();
        room.players.set(ws, { id: guestId, name: msg.name, imeRule, teamId: null, ready: false,
                               result: null, connected: true, inLobby: true, playingRound: null });
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
        const player = room.players.get(ws);
        if (!player) return;
        // プレイ中・リザルト表示中の変更は集計と食い違うため、
        // ロビーに戻っている本人のみ受け付ける（次のラウンドに向けた変更）
        if (!player.inLobby) return;
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
        // 二重開始の防止（連打対策）。結果表示中（finished）からは開始できる。
        if (room.gameState === 'playing') return;
        // ホスト自身がロビーに戻っていない（リザルトを見ている）間は開始しない
        const hostPlayer = room.players.get(ws);
        if (!hostPlayer || hostPlayer.inLobby === false) return;
        // 課題文はロビーで選ぶ方式になったため、未選択のまま開始できないようにする
        if (!room.text) {
          ws.send(JSON.stringify({ type: 'ERROR', message: '課題文を選択してください' }));
          return;
        }

        // 参加者はロビーに戻っている人だけ。リザルトを見たまま残っている人は
        // 次のゲームの対象外とし、その画面をそのままにしておく。
        const joining = [...room.players.entries()]
          .filter(([, p]) => p.inLobby !== false && p.connected !== false);
        if (joining.length === 0) return;

        // スタンバイチェックは今回参加する人のみ（ホスト自身は対象外）
        // msg.force が true の場合は警告を無視して開始する
        const notReady = [];
        for (const [pw, p] of joining) {
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
        room.round++;
        room.resultsFinalized = false;
        // 参加者のみ前回の結果を捨ててラウンドに登録する。
        // 非参加者の result/playingRound はそのまま残し、リザルト表示を壊さない。
        for (const [, p] of joining) {
          p.result = null;
          p.ready = false;
          p.inLobby = false;
          p.playingRound = room.round;
        }
        const startedRound = room.round;
        const countdownMs = 3000; // 各クライアントの受信からNミリ秒後に開始
        sendTo(room, p => p.playingRound === startedRound, {
          type: 'GAME_START',
          round: startedRound,
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
        // 残っている人にも進行状況（gameState）を伝える
        broadcast(room, roomState(room, currentRoomId));
        console.log(`Round ${startedRound} started in room ${currentRoomId} (${joining.length} player(s), duration ${room.duration}s)`);

        // サーバー側タイマー（指定時間後に強制終了、余裕として+5秒）
        room.timerInterval = setTimeout(() => {
          if (!rooms.has(currentRoomId) || room.round !== startedRound) return;
          sendTo(room, p => p.playingRound === startedRound, { type: 'TIME_UP' });
          finishRound(room, currentRoomId);
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
        broadcast(room, resultsUpdate(room));
        // 参加者全員の結果が揃ったらラウンドを終了扱いにする。
        // 時間切れを待たずに次のゲームを開始できるようにするため。
        if (activePlayers(room).every(p => p.result)) finishRound(room, currentRoomId);
        break;
      }

      // ── 集計の締め切り（ホストのみ） ─────────────────────────
      // 回線切断などで結果を送ってこないプレイヤーが残っても、
      // ホストの判断で順位表を確定できるようにする。
      // 締め切り後に遅れて届いた結果は通常どおり反映する（弾く理由がないため）。
      case 'FINALIZE_RESULTS': {
        const room = rooms.get(currentRoomId);
        if (!room || ws !== room.hostWs) return;
        if (room.resultsFinalized) return;
        room.resultsFinalized = true;
        broadcast(room, resultsUpdate(room));
        console.log(`Results finalized by host in room ${currentRoomId}`);
        break;
      }

      // ── ロビーへ戻る（各自の任意） ───────────────────────────
      // 戻るタイミングは各プレイヤーが自分で決める。リザルトを見続けたい人は
      // そのまま残ればよく、次のゲームはロビーに戻った人だけで開始される。
      // 結果自体は消さない（残っている人の順位表から自分が消えてしまうため）。
      case 'RETURN_TO_LOBBY': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const player = room.players.get(ws);
        if (!player) return;
        player.inLobby = true;
        player.ready = false;
        ws.send(JSON.stringify({ type: 'RETURN_TO_LOBBY_OK' }));
        broadcast(room, roomState(room, currentRoomId));
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

    const wasPlaying = player.playingRound === room.round;
    if (player.inLobby !== false) {
      // ロビーにいた人の離脱は一覧から削除（順位表に残す結果を持っていない）
      room.players.delete(ws);
    } else {
      // プレイ中／リザルト表示中の離脱は結果を順位表に残すため、Mapからは削除せず
      // 接続フラグだけを落とす（全員が切断した時点でルームごと破棄される）
      player.connected = false;
    }

    if (ws === room.hostWs) {
      // ホストが抜けたらルームはホスト不在になり、新しいゲームを開始できなくなる。
      // 別プレイヤーへ委譲はしない（誰が進行役かが入れ替わると参加者が混乱するため、
      // 「ホストが抜けたらそのルームは終わり」という分かりやすい挙動に揃える）。
      // ロビー側には hostPresent:false が伝わり、警告が表示される。
      room.hostWs = null;
      console.log(`Host left room ${currentRoomId}; no further games can be started`);
    }

    const anyConnected = [...room.players.values()].some(p => p.connected !== false);
    if (!anyConnected) {
      clearTimeout(room.timerInterval);
      rooms.delete(currentRoomId);
      console.log(`Room ${currentRoomId} deleted (all players disconnected)`);
      return;
    }

    broadcast(room, roomState(room, currentRoomId));
    // 進行中ラウンドの参加者が抜けたなら、結果集計中のランキング表示も更新させる
    if (wasPlaying) {
      broadcast(room, resultsUpdate(room));
      // 残った参加者が全員提出済みなら、その時点でラウンドを終了扱いにする
      if (room.gameState === 'playing' && activePlayers(room).every(p => p.result)) {
        finishRound(room, currentRoomId);
      }
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
