#!/usr/bin/env node
/**
 * Half Sense - Collaborative Puzzle Game Server
 *
 * Usage: node server.js [port]
 * Players on the same LAN connect via http://<your-ip>:<port>
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.argv[2]) || 3000;

// ─── Puzzle Data ────────────────────────────────────────────────────────────────

const SHAPE_IDS = [
  'solidCircle', 'hollowStar', 'crescent', 'spikeBall',
  'halfDiamond', 'thickArrow', 'bolt', 'droplet',
];

const CLUE_SETS = [
  {
    phrase: 'bright stars fill the night sky',
    clues: [
      'Shining, not dim',
      'They twinkle above',
      'To make completely full',
      'A small common word before nouns',
      'When the sun goes down',
      'Look up to see it',
    ],
  },
  {
    phrase: 'wild horses gallop across green fields',
    clues: [
      'Untamed, not domesticated',
      'Animals that neigh',
      'A fast running gait',
      'From one side to the other',
      'The color of grass',
      'Open meadows',
    ],
  },
  {
    phrase: 'gentle waves crash on the rocky shore',
    clues: [
      'Soft and kind, not rough',
      'What the ocean makes',
      'A loud collision sound',
      'Resting upon a surface',
      'A small word before nouns',
      'Covered in stones, not sandy',
      'Where ocean meets land',
    ],
  },
  {
    phrase: 'ancient trees guard the hidden path',
    clues: [
      'Very very old',
      'Tall plants with trunks and bark',
      'To protect like a sentinel',
      'A small common article word',
      'Concealed, not visible',
      'A trail to walk on',
    ],
  },
  {
    phrase: 'silver moonlight dances on still water',
    clues: [
      'A shiny gray metal',
      'Glow from the moon',
      'Moves gracefully, like ballet',
      'Resting upon a surface',
      'Calm, not moving',
      'H2O, what you drink',
    ],
  },
  {
    phrase: 'heavy clouds drift before the storm',
    clues: [
      'Weighing a lot, not light',
      'Gray things floating in the sky',
      'Float slowly without direction',
      'Coming earlier in time',
      'A small common article word',
      'Thunder and lightning event',
    ],
  },
  {
    phrase: 'quiet foxes creep through dark forests',
    clues: [
      'Making very little noise',
      'Clever orange-furred animals',
      'Move slowly and carefully',
      'Passing between things',
      'Without much light',
      'Dense areas of many trees',
    ],
  },
  {
    phrase: 'frozen rivers gleam under pale winter sun',
    clues: [
      'Turned to ice',
      'Flowing bodies of water',
      'Shine or glint softly',
      'Below, beneath',
      'Light and washed out, not vivid',
      'The cold season',
      'Our closest star',
    ],
  },
];

// ─── Level Generators ───────────────────────────────────────────────────────────

const LEVELS = {

  // Level 1: Split Code - alphanumeric
  splitCode(seed) {
    const rng = makeRng(seed);
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const len = 6;
    const code = Array.from({ length: len }, () => chars[rng() % chars.length]).join('');
    const indices = Array.from({ length: len }, (_, i) => i);
    shuffle(indices, rng);
    const setA = new Set(indices.slice(0, len / 2));
    const setB = new Set(indices.slice(len / 2));
    const playerA = code.split('').map((ch, i) => setA.has(i) ? ch : '_');
    const playerB = code.split('').map((ch, i) => setB.has(i) ? ch : '_');
    return {
      type: 'splitCode',
      answer: code,
      views: {
        A: { code: playerA.join(''), hint: 'You see 3 characters. Your partner sees the other 3. Tell each other what you see AND where you see it.' },
        B: { code: playerB.join(''), hint: 'You see 3 characters. Your partner sees the other 3. Tell each other what you see AND where you see it.' },
      },
      instructions: 'A secret code is split between you. Each of you sees only half the characters. Describe your characters and their positions to your partner, then BOTH of you enter the full combined code.',
    };
  },

  // Level 2: Color Filter
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
      views: {
        A: { grid: viewA, hint: 'You only see RED and GREEN cells. Your partner sees BLUE and GREEN. Don\'t show each other your screens!' },
        B: { grid: viewB, hint: 'You only see BLUE and GREEN cells. Your partner sees RED and GREEN. Don\'t show each other your screens!' },
      },
      instructions: 'Time for a real challenge! A grid of colored cells is hidden between you. You each see only certain colors. Figure out a way to describe the grid to each other - agree on a system first! Select ALL colored cells. No peeking at each other\'s screen!',
    };
  },

  // Level 3: Shape Sequence (moved from pos 4, reworked)
  shapeSequence(seed) {
    const rng = makeRng(seed);
    const len = 6;
    const sequence = Array.from({ length: len }, () => SHAPE_IDS[rng() % SHAPE_IDS.length]);

    const viewA = sequence.map((s, i) => i % 2 === 0 ? s : '?');
    const viewB = sequence.map((s, i) => i % 2 === 1 ? s : '?');

    return {
      type: 'shapeSequence',
      answer: sequence.join(','),
      views: {
        A: { sequence: viewA, allShapes: SHAPE_IDS, hint: 'You see shapes at positions 1, 3, 5. Describe them carefully to your partner - they look similar!' },
        B: { sequence: viewB, allShapes: SHAPE_IDS, hint: 'You see shapes at positions 2, 4, 6. Describe them carefully to your partner - they look similar!' },
      },
      instructions: 'A sequence of strange shapes is split between you. You can\'t just say "the star" - look closely! Is it filled? Hollow? Spiky? Curved? Describe each shape so your partner can identify the exact one.',
    };
  },

  // Level 4: Hazard Navigation
  hazardNav(seed) {
    const rng = makeRng(seed);
    const size = 5;
    const fuel = 16;

    // Generate hazards and verify solvability
    let hazardsA, hazardsB, allHazardSet;
    let attempts = 0;
    do {
      hazardsA = [];
      hazardsB = [];
      const usedCells = new Set(['0,0', `${size - 1},${size - 1}`]);

      for (let i = 0; i < 4; i++) {
        let cell;
        do {
          cell = `${rng() % size},${rng() % size}`;
        } while (usedCells.has(cell));
        usedCells.add(cell);
        hazardsA.push(cell);
      }
      for (let i = 0; i < 4; i++) {
        let cell;
        do {
          cell = `${rng() % size},${rng() % size}`;
        } while (usedCells.has(cell));
        usedCells.add(cell);
        hazardsB.push(cell);
      }

      allHazardSet = new Set([...hazardsA, ...hazardsB]);
      attempts++;
    } while (!hasValidPath(size, allHazardSet, fuel) && attempts < 50);

    // Fallback: if no solvable puzzle found, use no hazards
    if (attempts >= 50) {
      hazardsA = [];
      hazardsB = [];
      allHazardSet = new Set();
    }

    return {
      type: 'hazardNav',
      size,
      fuel,
      allHazards: [...allHazardSet],
      views: {
        A: {
          hazards: hazardsA, size, fuel,
          hint: 'You see YOUR hazards (red). Your partner sees DIFFERENT hazards. You must avoid ALL of them!',
        },
        B: {
          hazards: hazardsB, size, fuel,
          hint: 'You see YOUR hazards (blue). Your partner sees DIFFERENT hazards. You must avoid ALL of them!',
        },
      },
      instructions: 'Navigate from top-left to bottom-right! Each of you sees different hazards. Moves alternate: horizontal (left/right), then vertical (up/down), then horizontal, etc. Tell each other where your hazards are, plan a route together, and both submit the same path. You have limited fuel!',
    };
  },

  // Level 5: Clue Words (hardest)
  clueWords(seed) {
    const rng = makeRng(seed);
    const set = CLUE_SETS[rng() % CLUE_SETS.length];
    const words = set.phrase.split(' ');
    const clues = set.clues.slice(0, words.length);

    // Player A gets clues with slot numbers (but not the words)
    const clueList = clues.map((clue, i) => ({ slot: i + 1, clue }));

    // Player B gets words in shuffled order (but no positions or clues)
    const shuffledWords = [...words];
    shuffle(shuffledWords, rng);

    return {
      type: 'clueWords',
      answer: set.phrase,
      views: {
        A: {
          clues: clueList,
          totalWords: words.length,
          hint: 'You have the CLUES and slot numbers, but not the words. Read your clues to your partner - they have the words!',
        },
        B: {
          words: shuffledWords,
          totalWords: words.length,
          hint: 'You have the WORDS but no clues or positions. Listen to your partner\'s clues and figure out which word goes where!',
        },
      },
      instructions: 'The hardest puzzle! A secret phrase is hidden. One of you has numbered clues describing each word. The other has the actual words in random order. Read clues aloud, match them to words, agree on the order, and both type the full phrase.',
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

function hasValidPath(size, hazardSet, fuel) {
  const queue = [[0, 0, 0, 0]]; // r, c, parity, moves
  const visited = new Set();
  visited.add('0,0,0');

  while (queue.length > 0) {
    const [r, c, parity, moves] = queue.shift();
    if (r === size - 1 && c === size - 1) return true;
    if (moves >= fuel) continue;

    const dirs = parity === 0 ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]];
    for (const [dr, dc] of dirs) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
      if (hazardSet.has(`${nr},${nc}`)) continue;
      const np = 1 - parity;
      const sk = `${nr},${nc},${np}`;
      if (visited.has(sk)) continue;
      visited.add(sk);
      queue.push([nr, nc, np, moves + 1]);
    }
  }
  return false;
}

function validateHazardNavPath(pathStr, level) {
  const cells = pathStr.split(';');
  const { size, fuel, allHazards } = level;
  const hazardSet = new Set(allHazards);

  if (cells.length < 2) return false;
  if (cells.length - 1 > fuel) return false;
  if (cells[0] !== '0,0') return false;
  if (cells[cells.length - 1] !== `${size - 1},${size - 1}`) return false;

  const visited = new Set();
  for (let i = 0; i < cells.length; i++) {
    if (hazardSet.has(cells[i])) return false;
    if (visited.has(cells[i])) return false;
    visited.add(cells[i]);

    if (i > 0) {
      const [pr, pc] = cells[i - 1].split(',').map(Number);
      const [cr, cc] = cells[i].split(',').map(Number);
      const dr = cr - pr, dc = cc - pc;
      if (Math.abs(dr) + Math.abs(dc) !== 1) return false;
      const moveNum = i - 1;
      const mustBeHorizontal = moveNum % 2 === 0;
      if (mustBeHorizontal && dr !== 0) return false;
      if (!mustBeHorizontal && dc !== 0) return false;
    }
  }
  return true;
}

// ─── Game State ─────────────────────────────────────────────────────────────────

const rooms = new Map();
const REJOIN_TIMEOUT = 120000; // 2 minutes

function createRoom(roomCode) {
  const levelOrder = ['splitCode', 'colorFilter', 'shapeSequence', 'hazardNav', 'clueWords'];
  return {
    code: roomCode,
    players: {},
    playerNames: {},
    levelIndex: 0,
    levelOrder,
    currentLevel: null,
    state: 'waiting',
    submissions: {},
    disconnectTimers: {},
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
    wsSend(ws, {
      type: 'gameState',
      state: room.state,
      role,
      roomCode: room.code,
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
    });
  }
}

function broadcastLobby(room) {
  for (const role of ['A', 'B']) {
    const ws = room.players[role];
    if (!ws) continue;
    wsSend(ws, {
      type: 'lobby',
      roomCode: room.code,
      role,
      playerName: room.playerNames[role],
      partnerName: room.playerNames[role === 'A' ? 'B' : 'A'] || null,
      ready: !!(room.players.A && room.players.B),
    });
  }
}

function wsSend(ws, data) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastResult(room, correct, gameWon) {
  for (const role of ['A', 'B']) {
    const ws = room.players[role];
    if (!ws) continue;
    wsSend(ws, {
      type: 'result',
      correct,
      gameWon,
      levelIndex: room.levelIndex,
      totalLevels: room.levelOrder.length,
    });
  }
}

function normalizeAnswer(str) {
  return str.split(';').sort().join(';');
}

function checkSubmissions(room) {
  if (room.submissions.A === undefined || room.submissions.B === undefined) return;

  const level = room.currentLevel;
  let correct = false;

  switch (level.type) {
    case 'splitCode':
    case 'shapeSequence':
      correct = room.submissions.A === level.answer &&
                room.submissions.B === level.answer;
      break;

    case 'colorFilter':
      correct = normalizeAnswer(room.submissions.A) === normalizeAnswer(level.answer) &&
                normalizeAnswer(room.submissions.B) === normalizeAnswer(level.answer);
      break;

    case 'hazardNav':
      correct = room.submissions.A === room.submissions.B &&
                validateHazardNavPath(room.submissions.A, level);
      break;

    case 'clueWords':
      correct = room.submissions.A.toLowerCase().trim() === level.answer &&
                room.submissions.B.toLowerCase().trim() === level.answer;
      break;
  }

  if (correct) {
    room.levelIndex++;
    if (room.levelIndex >= room.levelOrder.length) {
      room.state = 'gameComplete';
      broadcastResult(room, true, true);
    } else {
      room.state = 'levelComplete';
      broadcastResult(room, true, false);
      setTimeout(() => {
        if (room.state === 'levelComplete') {
          startLevel(room);
        }
      }, 3000);
    }
  } else {
    room.submissions = {};
    broadcastResult(room, false, false);
    setTimeout(() => {
      if (room.state === 'playing') {
        broadcastState(room);
      }
    }, 2000);
  }
}

// ─── HTTP Server ────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(500); res.end('Error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// ─── WebSocket Server ───────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let currentRoom = null;
  let currentRole = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }

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
        const code = (msg.code || '').toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          wsSend(ws, { type: 'error', message: 'Room not found.' });
          return;
        }
        if (room.players.A && room.players.B) {
          wsSend(ws, { type: 'error', message: 'Room is full.' });
          return;
        }
        const role = room.players.A ? 'B' : 'A';
        // Clear disconnect timer if we're filling a slot that was waiting for rejoin
        if (room.disconnectTimers[role]) {
          clearTimeout(room.disconnectTimers[role]);
          delete room.disconnectTimers[role];
        }
        room.players[role] = ws;
        room.playerNames[role] = msg.name || 'Player 2';
        currentRoom = room;
        currentRole = role;
        if (room.state === 'waiting') {
          broadcastLobby(room);
        } else {
          // Rejoin mid-game
          broadcastState(room);
          const other = role === 'A' ? 'B' : 'A';
          if (room.players[other]) {
            wsSend(room.players[other], { type: 'partnerReconnected' });
          }
        }
        break;
      }

      case 'rejoinRoom': {
        const code = (msg.code || '').toUpperCase();
        const name = msg.name || '';
        const room = rooms.get(code);
        if (!room) {
          wsSend(ws, { type: 'rejoinFailed' });
          return;
        }
        let role = null;
        for (const r of ['A', 'B']) {
          if (!room.players[r] && room.playerNames[r] === name) {
            role = r;
            break;
          }
        }
        if (!role) {
          wsSend(ws, { type: 'rejoinFailed' });
          return;
        }
        if (room.disconnectTimers[role]) {
          clearTimeout(room.disconnectTimers[role]);
          delete room.disconnectTimers[role];
        }
        room.players[role] = ws;
        currentRoom = room;
        currentRole = role;
        const other = role === 'A' ? 'B' : 'A';
        if (room.players[other]) {
          wsSend(room.players[other], { type: 'partnerReconnected' });
        }
        if (room.state === 'waiting') {
          broadcastLobby(room);
        } else {
          broadcastState(room);
        }
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
        checkSubmissions(currentRoom);
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
  });

  ws.on('close', () => {
    if (!currentRoom) return;
    if (currentRoom.players[currentRole] !== ws) return;

    currentRoom.players[currentRole] = null;
    // Keep playerName for rejoin window
    const role = currentRole;
    const room = currentRoom;

    // Notify partner
    const other = role === 'A' ? 'B' : 'A';
    if (room.players[other]) {
      wsSend(room.players[other], { type: 'partnerDisconnected', roomCode: room.code });
    }

    // Start rejoin timeout
    room.disconnectTimers[role] = setTimeout(() => {
      room.playerNames[role] = null;
      delete room.disconnectTimers[role];
      // Clean up fully empty rooms
      if (!room.players.A && !room.players.B &&
          !room.playerNames.A && !room.playerNames.B) {
        rooms.delete(room.code);
      }
      // Notify remaining player the slot is now open
      if (room.players[other] && room.state === 'waiting') {
        broadcastLobby(room);
      }
    }, REJOIN_TIMEOUT);
  });
});

// ─── Start ──────────────────────────────────────────────────────────────────────

const os = require('os');
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
  console.log('');
  console.log('  ┌──────────────────────────────────────────┐');
  console.log('  │         HALF SENSE                       │');
  console.log('  │   Collaborative Puzzle Game Server        │');
  console.log('  ├──────────────────────────────────────────┤');
  console.log('  │                                          │');
  console.log(`  │  Local:   ${pad('http://localhost:' + PORT, 29)}│`);
  console.log(`  │  Network: ${pad('http://' + ip + ':' + PORT, 29)}│`);
  console.log('  │                                          │');
  console.log('  │  Share the Network URL with your partner │');
  console.log('  │  to play on the same WiFi network!       │');
  console.log('  │                                          │');
  console.log('  └──────────────────────────────────────────┘');
  console.log('');
});
