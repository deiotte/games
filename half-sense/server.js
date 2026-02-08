#!/usr/bin/env node
/**
 * Half Sense - Collaborative Puzzle Game Server
 *
 * A WebSocket server that manages game state for a two-player cooperative
 * puzzle game where each player has partial information.
 *
 * Usage:
 *   node server.js [port]
 *
 * Serves the client HTML and handles WebSocket connections.
 * Players on the same LAN can connect via http://<your-ip>:<port>
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.argv[2]) || 3000;

// ─── Level Generators ──────────────────────────────────────────────────────────

const LEVELS = {

  // Level 1: Split Code
  // Each player sees half the digits of a code. They must verbally share
  // and then both enter the full code.
  splitCode(seed) {
    const rng = makeRng(seed);
    const len = 6;
    const code = Array.from({ length: len }, () => rng() % 10).join('');
    const maskA = [];
    const maskB = [];
    const indices = Array.from({ length: len }, (_, i) => i);
    shuffle(indices, rng);
    for (let i = 0; i < len; i++) {
      if (i < len / 2) {
        maskA.push(indices[i]);
        maskB.push(null);
      } else {
        maskA.push(null);
        maskB.push(indices[i]);
      }
    }
    // Sort masks to show digits in order
    const playerA = code.split('').map((ch, i) => maskA.includes(i) ? ch : '_');
    const playerB = code.split('').map((ch, i) => maskB.includes(i) ? ch : '_');
    return {
      type: 'splitCode',
      answer: code,
      views: {
        A: { code: playerA.join(''), hint: 'You see some digits. Your partner sees the rest.' },
        B: { code: playerB.join(''), hint: 'You see some digits. Your partner sees the rest.' },
      },
      instructions: 'Each of you sees part of a secret code. Share what you see with your partner (verbally!) and both enter the full code.',
    };
  },

  // Level 2: Color Filter
  // A grid has cells colored red, blue, or green. Player A only sees red cells,
  // Player B only sees blue cells. Green cells are visible to both.
  // Together they must identify all marked cells.
  colorFilter(seed) {
    const rng = makeRng(seed);
    const size = 5;
    const grid = [];
    const answer = [];
    for (let r = 0; r < size; r++) {
      const row = [];
      for (let c = 0; c < size; c++) {
        const val = rng() % 100;
        if (val < 20) {
          row.push('red');
          answer.push(`${r},${c}`);
        } else if (val < 40) {
          row.push('blue');
          answer.push(`${r},${c}`);
        } else if (val < 50) {
          row.push('green');
          answer.push(`${r},${c}`);
        } else {
          row.push('none');
        }
      }
      grid.push(row);
    }

    const viewA = grid.map(row => row.map(c => (c === 'red' || c === 'green') ? c : 'none'));
    const viewB = grid.map(row => row.map(c => (c === 'blue' || c === 'green') ? c : 'none'));

    return {
      type: 'colorFilter',
      answer: answer.sort().join(';'),
      fullGrid: grid,
      views: {
        A: { grid: viewA, hint: 'You can only see RED and GREEN cells. Your partner sees BLUE and GREEN.' },
        B: { grid: viewB, hint: 'You can only see BLUE and GREEN cells. Your partner sees RED and GREEN.' },
      },
      instructions: 'A grid of colored cells is hidden. Each of you sees only certain colors. Select ALL colored cells together.',
    };
  },

  // Level 3: Fragmented Map
  // A path through a grid. Player A sees the first half of the path,
  // Player B sees the second half. They must reconstruct the full route.
  fragmentedMap(seed) {
    const rng = makeRng(seed);
    const size = 6;
    // Generate a random walk path
    const pathCells = [];
    let r = 0, c = 0;
    pathCells.push(`${r},${c}`);
    for (let i = 0; i < 8; i++) {
      const dirs = [];
      if (r > 0) dirs.push([-1, 0]);
      if (r < size - 1) dirs.push([1, 0]);
      if (c > 0) dirs.push([0, -1]);
      if (c < size - 1) dirs.push([0, 1]);
      const [dr, dc] = dirs[rng() % dirs.length];
      r += dr;
      c += dc;
      const cell = `${r},${c}`;
      if (!pathCells.includes(cell)) pathCells.push(cell);
    }

    const half = Math.ceil(pathCells.length / 2);
    const viewA = pathCells.slice(0, half);
    const viewB = pathCells.slice(half);

    return {
      type: 'fragmentedMap',
      answer: pathCells.join(';'),
      size,
      views: {
        A: { path: viewA, size, hint: 'You see the START of the path. Your partner sees the END.' },
        B: { path: viewB, size, hint: 'You see the END of the path. Your partner sees the START.' },
      },
      instructions: 'A path is drawn through a grid. Each of you sees only half. Reconstruct the full path together.',
    };
  },

  // Level 4: Symbol Sequence
  // A sequence of symbols. Player A sees odd-indexed symbols, player B sees even-indexed.
  // They must reconstruct the full sequence in order.
  symbolSequence(seed) {
    const rng = makeRng(seed);
    const symbols = ['★', '◆', '▲', '●', '■', '♥', '⬟', '✦'];
    const len = 6;
    const sequence = Array.from({ length: len }, () => symbols[rng() % symbols.length]);

    const viewA = sequence.map((s, i) => i % 2 === 0 ? s : '?');
    const viewB = sequence.map((s, i) => i % 2 === 1 ? s : '?');

    return {
      type: 'symbolSequence',
      answer: sequence.join(''),
      symbols,
      views: {
        A: { sequence: viewA, symbols, hint: 'You see symbols at positions 1, 3, 5. Your partner sees 2, 4, 6.' },
        B: { sequence: viewB, symbols, hint: 'You see symbols at positions 2, 4, 6. Your partner sees 1, 3, 5.' },
      },
      instructions: 'A sequence of symbols is split between you. Each of you sees alternating positions. Reconstruct the full sequence.',
    };
  },

  // Level 5: Jigsaw Whisper
  // A short secret phrase split into words. Player A gets some words with positions,
  // Player B gets the remaining words with positions.
  jigsawWhisper(seed) {
    const rng = makeRng(seed);
    const phrases = [
      'the quick brown fox jumps high',
      'bright stars light the dark sky',
      'calm waves crash on soft sand',
      'cold wind blows through tall trees',
      'deep blue ocean meets the shore',
      'wild birds sing at early dawn',
    ];
    const phrase = phrases[rng() % phrases.length];
    const words = phrase.split(' ');
    const indices = Array.from({ length: words.length }, (_, i) => i);
    shuffle(indices, rng);

    const half = Math.ceil(words.length / 2);
    const indicesA = indices.slice(0, half).sort((a, b) => a - b);
    const indicesB = indices.slice(half).sort((a, b) => a - b);

    const viewA = indicesA.map(i => ({ pos: i + 1, word: words[i] }));
    const viewB = indicesB.map(i => ({ pos: i + 1, word: words[i] }));

    return {
      type: 'jigsawWhisper',
      answer: phrase,
      views: {
        A: { words: viewA, total: words.length, hint: 'You have some words with their positions. Your partner has the rest.' },
        B: { words: viewB, total: words.length, hint: 'You have some words with their positions. Your partner has the rest.' },
      },
      instructions: 'A secret phrase is split between you. Each of you has some words and their positions. Piece together the full phrase.',
    };
  },
};

// ─── Utilities ──────────────────────────────────────────────────────────────────

function makeRng(seed) {
  let s = seed;
  return function () {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s;
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng() % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ─── Game State ─────────────────────────────────────────────────────────────────

const rooms = new Map();

function createRoom(roomCode) {
  const levelOrder = ['splitCode', 'colorFilter', 'fragmentedMap', 'symbolSequence', 'jigsawWhisper'];
  return {
    code: roomCode,
    players: {},       // { A: ws, B: ws }
    playerNames: {},   // { A: name, B: name }
    levelIndex: 0,
    levelOrder,
    currentLevel: null,
    state: 'waiting',  // waiting | playing | levelComplete | gameComplete
    submissions: {},   // { A: answer, B: answer }
  };
}

function generateRoomCode() {
  return crypto.randomBytes(2).toString('hex').toUpperCase();
}

function startLevel(room) {
  const levelName = room.levelOrder[room.levelIndex];
  const seed = Date.now() ^ (parseInt(room.code, 16) || 42);
  room.currentLevel = LEVELS[levelName](seed);
  room.submissions = {};
  room.state = 'playing';
  broadcastState(room);
}

function broadcastState(room) {
  for (const role of ['A', 'B']) {
    const ws = room.players[role];
    if (!ws) continue;
    const level = room.currentLevel;
    const msg = {
      type: 'gameState',
      state: room.state,
      role,
      partnerName: room.playerNames[role === 'A' ? 'B' : 'A'] || null,
      levelIndex: room.levelIndex,
      totalLevels: room.levelOrder.length,
      level: level ? {
        type: level.type,
        instructions: level.instructions,
        view: level.views[role],
      } : null,
      submitted: !!room.submissions[role],
      partnerSubmitted: !!room.submissions[role === 'A' ? 'B' : 'A'],
    };
    send(ws, msg);
  }
}

function broadcastLobby(room) {
  for (const role of ['A', 'B']) {
    const ws = room.players[role];
    if (!ws) continue;
    send(ws, {
      type: 'lobby',
      roomCode: room.code,
      role,
      playerName: room.playerNames[role],
      partnerName: room.playerNames[role === 'A' ? 'B' : 'A'] || null,
      ready: room.players.A && room.players.B,
    });
  }
}

function send(ws, data) {
  if (ws.readyState === 1) { // WebSocket.OPEN
    ws.send(JSON.stringify(data));
  }
}

// ─── WebSocket Handling (raw, no dependencies) ──────────────────────────────────

function acceptWebSocket(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  const magic = '258EAFA5-E914-47DA-95CA-5AB5FE8D3963';
  const accept = crypto.createHash('sha1').update(key + magic).digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n'
  );

  const ws = new WsConnection(socket);
  return ws;
}

class WsConnection {
  constructor(socket) {
    this.socket = socket;
    this.readyState = 1;
    this._buffer = Buffer.alloc(0);
    this._onMessage = null;
    this._onClose = null;

    socket.on('data', (chunk) => this._handleData(chunk));
    socket.on('close', () => { this.readyState = 3; if (this._onClose) this._onClose(); });
    socket.on('error', () => { this.readyState = 3; if (this._onClose) this._onClose(); });
  }

  set onmessage(fn) { this._onMessage = fn; }
  set onclose(fn) { this._onClose = fn; }

  send(data) {
    if (this.readyState !== 1) return;
    const payload = Buffer.from(data);
    const frame = this._encodeFrame(payload);
    this.socket.write(frame);
  }

  close() {
    this.readyState = 2;
    try {
      const frame = Buffer.alloc(2);
      frame[0] = 0x88;
      frame[1] = 0x00;
      this.socket.write(frame);
    } catch (_) {}
    this.socket.end();
  }

  _encodeFrame(payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
  }

  _handleData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    while (this._buffer.length >= 2) {
      const firstByte = this._buffer[0];
      const opcode = firstByte & 0x0f;
      const masked = (this._buffer[1] & 0x80) !== 0;
      let payloadLen = this._buffer[1] & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this._buffer.length < 4) return;
        payloadLen = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._buffer.length < 10) return;
        payloadLen = Number(this._buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      const totalLen = offset + maskLen + payloadLen;
      if (this._buffer.length < totalLen) return;

      const maskKey = masked ? this._buffer.slice(offset, offset + maskLen) : null;
      const payload = this._buffer.slice(offset + maskLen, totalLen);

      if (masked) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      this._buffer = this._buffer.slice(totalLen);

      if (opcode === 0x08) {
        this.readyState = 3;
        this.socket.end();
        if (this._onClose) this._onClose();
        return;
      }
      if (opcode === 0x09) { // ping
        const pong = Buffer.alloc(2);
        pong[0] = 0x8a;
        pong[1] = 0;
        this.socket.write(pong);
        continue;
      }
      if (opcode === 0x01 && this._onMessage) {
        this._onMessage({ data: payload.toString('utf8') });
      }
    }
  }
}

// ─── HTTP Server ────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading client');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.on('upgrade', (req, socket, head) => {
  const ws = acceptWebSocket(req, socket, head);
  handleConnection(ws);
});

// ─── Connection Handler ─────────────────────────────────────────────────────────

function handleConnection(ws) {
  let currentRoom = null;
  let currentRole = null;

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (_) { return; }

    switch (msg.type) {
      case 'createRoom': {
        const code = generateRoomCode();
        const room = createRoom(code);
        room.players.A = ws;
        room.playerNames.A = msg.name || 'Player 1';
        rooms.set(code, room);
        currentRoom = room;
        currentRole = 'A';
        broadcastLobby(room);
        break;
      }

      case 'joinRoom': {
        const room = rooms.get(msg.code.toUpperCase());
        if (!room) {
          send(ws, { type: 'error', message: 'Room not found. Check the code and try again.' });
          return;
        }
        if (room.players.A && room.players.B) {
          send(ws, { type: 'error', message: 'Room is full.' });
          return;
        }
        const role = room.players.A ? 'B' : 'A';
        room.players[role] = ws;
        room.playerNames[role] = msg.name || 'Player 2';
        currentRoom = room;
        currentRole = role;
        broadcastLobby(room);
        break;
      }

      case 'startGame': {
        if (!currentRoom || currentRoom.state !== 'waiting') return;
        if (!currentRoom.players.A || !currentRoom.players.B) return;
        startLevel(currentRoom);
        break;
      }

      case 'submit': {
        if (!currentRoom || currentRoom.state !== 'playing') return;
        currentRoom.submissions[currentRole] = msg.answer;
        broadcastState(currentRoom);

        // Check if both submitted
        if (currentRoom.submissions.A !== undefined && currentRoom.submissions.B !== undefined) {
          const level = currentRoom.currentLevel;
          let correct = false;

          if (level.type === 'splitCode') {
            correct = currentRoom.submissions.A === level.answer &&
                      currentRoom.submissions.B === level.answer;
          } else if (level.type === 'colorFilter') {
            // Both must select the same full set of colored cells
            const a = normalizeAnswer(currentRoom.submissions.A);
            const b = normalizeAnswer(currentRoom.submissions.B);
            correct = a === normalizeAnswer(level.answer) && b === normalizeAnswer(level.answer);
          } else if (level.type === 'fragmentedMap') {
            const a = normalizeAnswer(currentRoom.submissions.A);
            const b = normalizeAnswer(currentRoom.submissions.B);
            correct = a === normalizeAnswer(level.answer) && b === normalizeAnswer(level.answer);
          } else if (level.type === 'symbolSequence') {
            correct = currentRoom.submissions.A === level.answer &&
                      currentRoom.submissions.B === level.answer;
          } else if (level.type === 'jigsawWhisper') {
            const a = currentRoom.submissions.A.toLowerCase().trim();
            const b = currentRoom.submissions.B.toLowerCase().trim();
            correct = a === level.answer && b === level.answer;
          }

          if (correct) {
            currentRoom.levelIndex++;
            if (currentRoom.levelIndex >= currentRoom.levelOrder.length) {
              currentRoom.state = 'gameComplete';
              broadcastResult(currentRoom, true, true);
            } else {
              currentRoom.state = 'levelComplete';
              broadcastResult(currentRoom, true, false);
              // Auto-advance after a short delay
              setTimeout(() => {
                if (currentRoom.state === 'levelComplete') {
                  startLevel(currentRoom);
                }
              }, 3000);
            }
          } else {
            // Wrong answer, let them retry
            currentRoom.submissions = {};
            broadcastResult(currentRoom, false, false);
            setTimeout(() => {
              if (currentRoom.state === 'playing') {
                broadcastState(currentRoom);
              }
            }, 2000);
          }
        }
        break;
      }

      case 'playAgain': {
        if (!currentRoom) return;
        currentRoom.levelIndex = 0;
        currentRoom.state = 'waiting';
        currentRoom.currentLevel = null;
        currentRoom.submissions = {};
        broadcastLobby(currentRoom);
        break;
      }
    }
  };

  ws.onclose = () => {
    if (currentRoom) {
      if (currentRoom.players[currentRole] === ws) {
        currentRoom.players[currentRole] = null;
        currentRoom.playerNames[currentRole] = null;
      }
      // Notify partner
      const other = currentRole === 'A' ? 'B' : 'A';
      if (currentRoom.players[other]) {
        send(currentRoom.players[other], { type: 'partnerDisconnected' });
      }
      // Clean up empty rooms
      if (!currentRoom.players.A && !currentRoom.players.B) {
        rooms.delete(currentRoom.code);
      }
    }
  };
}

function normalizeAnswer(str) {
  return str.split(';').sort().join(';');
}

function broadcastResult(room, correct, gameWon) {
  for (const role of ['A', 'B']) {
    const ws = room.players[role];
    if (!ws) continue;
    send(ws, {
      type: 'result',
      correct,
      gameWon,
      levelIndex: room.levelIndex,
      totalLevels: room.levelOrder.length,
    });
  }
}

// ─── Start ──────────────────────────────────────────────────────────────────────

const os = require('os');
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║        🧩  HALF SENSE  🧩               ║`);
  console.log(`  ║   Collaborative Puzzle Game Server       ║`);
  console.log(`  ╠══════════════════════════════════════════╣`);
  console.log(`  ║                                          ║`);
  console.log(`  ║  Local:   http://localhost:${PORT}          ║`);
  console.log(`  ║  Network: http://${ip}:${PORT}     ║`);
  console.log(`  ║                                          ║`);
  console.log(`  ║  Share the Network URL with your partner ║`);
  console.log(`  ║  to play on the same WiFi network!       ║`);
  console.log(`  ║                                          ║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);
});
