/*
  ╔══════════════════════════════════════════════════════╗
  ║           SHOW — Game Server                         ║
  ║  Stack: Node.js + Express + Socket.IO                ║
  ╚══════════════════════════════════════════════════════╝

  FLOW:
  ─────
  1. Players join waiting.html (lobby)
  2. Creator clicks "Start" → start_game event
  3. Server deals cards to all players → emits game_started
  4. waiting.html redirects everyone to game.html
  5. Players re-register from game.html → server re-sends deal_hand
  6. Players see their cards, click "Let's play!" → player_ready
  7. When ALL players ready → all_ready → redirect to main-game.html
  8. Server calls startRound() → turn loop begins
  9. After round ends → leaderboard → lobby.html
 10. Host clicks Start again → reset_for_new_game → new round
*/

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 3000;

const rooms = {};

// ─── Helpers ──────────────────────────────────────────────────

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');
  } while (rooms[code]);
  return code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const TOPIC_ITEMS = {
  chocolates: [
    'KitKat','Dairy Milk','Snickers','Ferrero',
    'Twix','Bounty','Mars','Toblerone','Milky Bar','Crunch'
  ],
  movies: [
    'Action','Comedy','Horror','Romance',
    'Thriller','Sci-Fi','Drama','Animation','Fantasy','Mystery'
  ],
  countries: [
    'India','USA','Japan','Brazil',
    'Germany','France','Australia','Canada','Italy','Spain'
  ],
  cartoons: [
    'Tom & Jerry','Doraemon','SpongeBob','Shinchan',
    'Naruto','Phineas & Ferb','Ben 10','Oggy','Motu Patlu','Chhota Bheem'
  ],
  fruits: [
    'Apple','Banana','Mango','Grapes',
    'Orange','Strawberry','Watermelon','Pineapple','Papaya','Kiwi'
  ],
  animals: [
    'Lion','Tiger','Elephant','Zebra',
    'Giraffe','Penguin','Dolphin','Cheetah','Panda','Kangaroo'
  ]
};

// ──────────────────────────────────────────────────────────────
//  buildDeck — pick numPlayers items, 4 copies each
// ──────────────────────────────────────────────────────────────
function buildDeck(topic, numPlayers) {
  const allItems      = TOPIC_ITEMS[topic] || TOPIC_ITEMS['chocolates'];
  const shuffledItems = shuffle([...allItems]);
  const selectedItems = shuffledItems.slice(0, numPlayers);

  const deck = [];
  selectedItems.forEach((label, itemIdx) => {
    for (let copy = 0; copy < 4; copy++) {
      deck.push({
        uniqueId: `card_${itemIdx}_${copy}_${Date.now()}_${Math.random()}`,
        itemIdx,
        label
      });
    }
  });

  return shuffle(shuffle(deck));
}

// ──────────────────────────────────────────────────────────────
//  dealDeck — distribute cards ensuring no 4-of-a-kind at start
// ──────────────────────────────────────────────────────────────
function dealDeck(deck, numPlayers) {
  const MAX_ATTEMPTS = 200;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const shuffled = shuffle(deck);
    const hands    = Array.from({ length: numPlayers }, () => []);

    shuffled.forEach((card, i) => {
      hands[i % numPlayers].push(card);
    });

    const valid = hands.every(hand => {
      const counts = {};
      hand.forEach(c => { counts[c.itemIdx] = (counts[c.itemIdx] || 0) + 1; });
      return Object.values(counts).every(v => v < 4);
    });

    if (valid) {
      console.log(`[DEAL] Valid distribution found on attempt ${attempt + 1}`);
      return hands;
    }
  }

  console.warn('[DEAL] Falling back to forced safe deal');
  return forceSafeDeal(deck, numPlayers);
}

function forceSafeDeal(deck, numPlayers) {
  const hands = Array.from({ length: numPlayers }, () => []);
  const groups = {};
  deck.forEach(card => {
    if (!groups[card.itemIdx]) groups[card.itemIdx] = [];
    groups[card.itemIdx].push(card);
  });
  Object.keys(groups).forEach(key => { groups[key] = shuffle(groups[key]); });
  Object.values(groups).forEach((group) => {
    group.forEach((card, copyIdx) => {
      hands[copyIdx % numPlayers].push(card);
    });
  });
  return hands.map(hand => shuffle(hand));
}

function hasNOfAKind(hand, n) {
  const counts = {};
  hand.forEach(c => { counts[c.itemIdx] = (counts[c.itemIdx] || 0) + 1; });
  return Object.values(counts).some(v => v >= n);
}

// ──────────────────────────────────────────────────────────────
//  dealAndBroadcast
//  Builds deck, deals hands, sends deal_hand to each player.
//  Does NOT start the turn loop — that waits for all_ready.
// ──────────────────────────────────────────────────────────────
function dealAndBroadcast(room) {
  const numPlayers = room.players.length;
  const deck       = buildDeck(room.topic, numPlayers);
  room.hands       = dealDeck(deck, numPlayers);

  const usedLabels = [...new Set(deck.map(c => c.label))];
  room.roundLabels = usedLabels;
  room.lastReceivedUid = new Array(numPlayers).fill(null);

  console.log(`[DEAL] Room ${room.code}: dealt hands to ${numPlayers} players`);

  room.players.forEach((p, i) => {
    if (p.socketId) {
      io.to(p.socketId).emit('deal_hand', {
        hand:        room.hands[i],
        roundLabels: usedLabels,
        numPlayers
      });
    }
  });
}

// ─── Game flow ────────────────────────────────────────────────

function startRound(room) {
  room.showCalled     = false;
  room.showCallerIdx  = -1;
  room.puzzleResults  = [];
  room.roundNum++;

  const numPlayers = room.players.length;

  // ── Determine first turn ──
  // If host explicitly picked a startPlayerIndex for this round, use it.
  // Otherwise fall back to the rotating startedBy logic.
  let startIdx = 0;

  if (typeof room.nextStartPlayerIndex === 'number' && room.nextStartPlayerIndex >= 0) {
    // Host picked a specific player to start
    startIdx = room.nextStartPlayerIndex % numPlayers;
    room.nextStartPlayerIndex = null; // consume it — next round will rotate normally
    console.log(`[GAME START] Room ${room.code} | round ${room.roundNum} | host-picked start: player ${startIdx}`);
  } else {
    // Rotating logic
    if (room.startedBy.length > 0) {
      const last = room.startedBy[room.startedBy.length - 1];
      for (let i = 1; i <= numPlayers; i++) {
        const candidate = (last + i) % numPlayers;
        if (!room.startedBy.includes(candidate)) { startIdx = candidate; break; }
      }
      if (room.startedBy.length >= numPlayers) {
        room.startedBy = [];
        startIdx = (last + 1) % numPlayers;
      }
    }
    console.log(`[GAME START] Room ${room.code} | round ${room.roundNum} | rotating start: player ${startIdx}`);
  }

  room.startedBy.push(startIdx);
  room.turnIndex = startIdx;

  // Small delay so clients have time to settle on main-game.html
  setTimeout(() => advanceTurn(room), 2000);
}

function advanceTurn(room) {
  clearTimeout(room.turnTimer);
  if (room.showCalled) return;

  const activeIdx = room.turnIndex;
  console.log(`[TURN] room ${room.code} → player ${activeIdx} (${room.players[activeIdx]?.name})`);

  io.to(room.code).emit('turn_update', {
    activeTurnIndex: activeIdx,
    timerSeconds:    15
  });

  room.turnTimer = setTimeout(() => {
    autoPassForPlayer(room, activeIdx);
  }, 17000);
}

function autoPassForPlayer(room, playerIdx) {
  const hand    = room.hands[playerIdx];
  if (!hand || hand.length === 0) return;
  const lastUid = room.lastReceivedUid[playerIdx];
  const valid   = hand.filter(c => c.uniqueId !== lastUid);
  if (valid.length === 0) return;
  const card = valid[Math.floor(Math.random() * valid.length)];
  processPass(room, playerIdx, card.uniqueId);
}

function processPass(room, fromIdx, cardUid) {
  clearTimeout(room.turnTimer);

  const hand    = room.hands[fromIdx];
  const cardIdx = hand.findIndex(c => c.uniqueId === cardUid);
  if (cardIdx === -1) return;

  const [card] = hand.splice(cardIdx, 1);
  const toIdx  = (fromIdx + 1) % room.players.length;

  room.hands[toIdx].push(card);
  room.lastReceivedUid[toIdx] = card.uniqueId;

  const receiver = room.players[toIdx];
  if (receiver?.socketId) {
    io.to(receiver.socketId).emit('receive_card', { card });
  }

  const sender = room.players[fromIdx];
  if (sender?.socketId) {
    io.to(sender.socketId).emit('pass_accepted', { cardUid });
  }

  room.turnIndex = toIdx;

  if (hasNOfAKind(room.hands[toIdx], 4) && receiver?.socketId) {
    io.to(receiver.socketId).emit('show_available');
  }

  setTimeout(() => advanceTurn(room), 300);
}

// ──────────────────────────────────────────────────────────────
//  buildRankings
//
//  Rank 1  → SHOW caller                         → 1000 pts
//  Rank 2  → 1st puzzle solver (correct first,   → 800 pts
//             tiebreak by time)
//  Rank 3  →                                     → 700 pts
//  …
//  Rank N  → last / wrong / timed-out            → min 100 pts
//
//  Formula: score = 1000 - rank * 100, floor 100
// ──────────────────────────────────────────────────────────────
function buildRankings(room) {
  const n = room.players.length;

  // Sort puzzle results:
  //   correct answers ranked above wrong / timeout
  //   among equals: faster submission time = better rank
  const sorted = [...room.puzzleResults].sort((a, b) => {
    if (a.correct && !b.correct) return -1;
    if (!a.correct && b.correct) return  1;
    return a.timeTaken - b.timeTaken;
  });

  const rankings = [];

  // ── Rank 1: SHOW caller always gets 1000 ──
  rankings.push({
    playerIndex: room.showCallerIdx,
    playerName:  room.players[room.showCallerIdx]?.name || ('Player ' + (room.showCallerIdx + 1)),
    rank:        1,
    score:       1000
  });

  // ── Ranks 2..N: each puzzle solver in submission order ──
  // score = 1000 - rank*100, minimum 100
  sorted.forEach((result, i) => {
    const rank  = i + 2;
    const score = Math.max(100, 1000 - rank * 100);
    rankings.push({
      playerIndex: result.playerIndex,
      playerName:  room.players[result.playerIndex]?.name || ('Player ' + (result.playerIndex + 1)),
      rank,
      score
    });
  });

  // ── Anyone who never submitted (disconnected / timed out) ──
  for (let i = 0; i < n; i++) {
    if (i === room.showCallerIdx) continue;
    const alreadyCovered = rankings.some(r => r.playerIndex === i);
    if (!alreadyCovered) {
      rankings.push({
        playerIndex: i,
        playerName:  room.players[i]?.name || ('Player ' + (i + 1)),
        rank:        rankings.length + 1,
        score:       100
      });
    }
  }

  return rankings;
}

// ══════════════════════════════════════════════════════
//  MIDDLEWARE + STATIC
// ══════════════════════════════════════════════════════
app.use(express.json());
app.use(express.static(__dirname));

// ══════════════════════════════════════════════════════
//  REST
// ══════════════════════════════════════════════════════
app.post('/api/create-room', (req, res) => {
  const { name, maxPlayers, topic } = req.body;
  if (!name || !maxPlayers || !topic)
    return res.status(400).json({ error: 'Missing required fields.' });

  const mp = parseInt(maxPlayers);
  if (mp < 2 || mp > 10)
    return res.status(400).json({ error: 'Players must be between 2 and 10.' });

  const topicItems = TOPIC_ITEMS[topic];
  if (!topicItems)
    return res.status(400).json({ error: 'Invalid topic.' });

  const code = generateCode();
  rooms[code] = {
    code, topic,
    maxPlayers:           mp,
    creatorSocketId:      null,
    players:              [{ socketId: null, name, profilePic: null, isCreator: true }],
    gameStarted:          false,
    dealSent:             false,
    hands:                [],
    turnIndex:            0,
    turnTimer:            null,
    lastReceivedUid:      [],
    showCalled:           false,
    showCallerIdx:        -1,
    roundNum:             0,
    roundLabels:          [],
    startedBy:            [],
    puzzleResults:        [],
    readyPlayers:         new Set(),
    nextStartPlayerIndex: null   // host-picked start player for next game
  };

  console.log(`[ROOM CREATED] ${code} | topic: ${topic} | max: ${mp}`);
  res.json({ code, playerIndex: 0 });
});

app.post('/api/join-room', (req, res) => {
  const { name, code } = req.body;
  if (!name || !code)
    return res.status(400).json({ error: 'Missing name or code.' });

  const room = rooms[code.toUpperCase()];
  if (!room)
    return res.status(404).json({ error: 'Room not found. Check your game code.' });
  if (room.players.length >= room.maxPlayers)
    return res.status(400).json({ error: 'Room is full.' });

  const playerIndex = room.players.length;
  room.players.push({ socketId: null, name, profilePic: null, isCreator: false });

  console.log(`[PLAYER JOINED] ${name} → room ${code} (${room.players.length}/${room.maxPlayers})`);
  res.json({
    code:           room.code,
    playerIndex,
    topic:          room.topic,
    maxPlayers:     room.maxPlayers,
    currentPlayers: room.players.length,
    players:        room.players.map(p => ({ name: p.name, profilePic: p.profilePic }))
  });
});

app.get('/api/room/:code', (req, res) => {
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  res.json({
    code: room.code, topic: room.topic,
    maxPlayers: room.maxPlayers, currentPlayers: room.players.length,
    players: room.players.map(p => ({ name: p.name, profilePic: p.profilePic }))
  });
});

// ══════════════════════════════════════════════════════
//  SOCKET.IO
// ══════════════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`[SOCKET] connected: ${socket.id}`);

  // ──────────────────────────────────────────────────────────────
  //  register — called by every page on connect/reconnect
  // ──────────────────────────────────────────────────────────────
  socket.on('register', ({ code, playerIndex, profilePic }) => {
    const room = rooms[code];
    if (!room) return;

    if (room.players[playerIndex]) {
      room.players[playerIndex].socketId = socket.id;
      if (profilePic?.length > 0) room.players[playerIndex].profilePic = profilePic;
    }
    if (playerIndex === 0) room.creatorSocketId = socket.id;

    socket.join(code);
    socket.data.code        = code;
    socket.data.playerIndex = playerIndex;

    console.log(`[REGISTER] ${room.players[playerIndex]?.name} | room ${code} | gameStarted: ${room.gameStarted} | dealSent: ${room.dealSent}`);

    // ── Broadcast updated player list ──
    // Use socket.to() (not io.to()) so the registering player themselves
    // does NOT receive a player_disconnected-style update that triggers a toast.
    // Everyone in the room (including the registering socket now) gets lobby_update.
    io.to(code).emit('lobby_update', {
      currentPlayers: room.players.filter(p => p.socketId).length,
      maxPlayers:     room.maxPlayers,
      players:        room.players.map(p => ({ name: p.name, profilePic: p.profilePic }))
    });

    // ── If game is in progress (mid-round), re-send hand for reconnect ──
    if (room.gameStarted && room.dealSent) {
      if (room.hands && room.hands[playerIndex] && room.hands[playerIndex].length > 0) {
        console.log(`[RE-DEAL] Sending existing hand to player ${playerIndex} (reconnect)`);
        socket.emit('deal_hand', {
          hand:        room.hands[playerIndex],
          roundLabels: room.roundLabels,
          numPlayers:  room.players.length
        });
      }
      return;
    }

    // ── Cards dealt but game not yet started (waiting for all_ready) ──
    if (!room.gameStarted && room.dealSent) {
      if (room.hands && room.hands[playerIndex] && room.hands[playerIndex].length > 0) {
        console.log(`[RE-DEAL] Sending pre-dealt hand to player ${playerIndex} (game.html load)`);
        socket.emit('deal_hand', {
          hand:        room.hands[playerIndex],
          roundLabels: room.roundLabels,
          numPlayers:  room.players.length
        });
      }
    }
  });

  // ──────────────────────────────────────────────────────────────
  //  reset_for_new_game
  //
  //  Called from lobby.html when the host clicks "Start" for a
  //  subsequent game (room already exists, round already played).
  //  Resets all round state so the normal start_game → game_started
  //  → waiting.html → game.html → player_ready → all_ready flow
  //  can run again cleanly.
  //
  //  Payload: { code, numPlayers, topic, startPlayerIndex }
  // ──────────────────────────────────────────────────────────────
  socket.on('reset_for_new_game', ({ code, numPlayers, topic, startPlayerIndex }) => {
    const room = rooms[code];
    if (!room) return;
    if (socket.id !== room.creatorSocketId) {
      console.log(`[RESET REJECTED] Non-creator tried to reset room ${code}`);
      return;
    }

    const np = parseInt(numPlayers) || room.players.length;
    const t  = topic || room.topic;

    console.log(`[RESET] Room ${code} → new game | players: ${np} | topic: ${t} | startPlayer: ${startPlayerIndex}`);

    // ── Update room settings ──
    room.topic      = t;
    room.maxPlayers = np;

    // ── Reset all round state ──
    clearTimeout(room.turnTimer);
    room.gameStarted          = false;
    room.dealSent             = false;
    room.hands                = [];
    room.turnIndex            = 0;
    room.turnTimer            = null;
    room.lastReceivedUid      = [];
    room.showCalled           = false;
    room.showCallerIdx        = -1;
    room.roundLabels          = [];
    room.puzzleResults        = [];
    room.readyPlayers         = new Set();
    room.nextStartPlayerIndex = (typeof startPlayerIndex === 'number') ? startPlayerIndex : null;

    // ── Tell all clients to go to waiting.html ──
    // We re-use the same 'game_started' event that waiting.html already
    // listens for — so the flow is identical to a first game start.
    // lobby.html will also listen for 'new_game_starting' to redirect itself.
    io.to(code).emit('new_game_starting', {
      numPlayers: np,
      topic:      t,
      players:    room.players.map(p => ({ name: p.name, profilePic: p.profilePic }))
    });
  });

  // ──────────────────────────────────────────────────────────────
  //  start_game — creator clicks "Start" in waiting.html
  //  (first game only — subsequent games use reset_for_new_game
  //   which then triggers the same waiting.html → game.html flow)
  // ──────────────────────────────────────────────────────────────
  socket.on('start_game', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    if (socket.id !== room.creatorSocketId) {
      console.log(`[START REJECTED] Non-creator tried to start room ${code}`);
      return;
    }
    if (room.dealSent) {
      console.log(`[START IGNORED] Room ${code} already dealt`);
      return;
    }

    console.log(`[START GAME] Room ${code} — dealing cards and redirecting to game.html`);

    room.dealSent = true;
    dealAndBroadcast(room);

    io.to(code).emit('game_started');
  });

  // ──────────────────────────────────────────────────────────────
  //  player_ready — player clicks "Let's play!" in game.html
  // ──────────────────────────────────────────────────────────────
  socket.on('player_ready', ({ code, playerIndex }) => {
    const room = rooms[code];
    if (!room || room.gameStarted) return;

    room.readyPlayers.add(playerIndex);
    console.log(`[READY] Player ${playerIndex} ready in room ${code} (${room.readyPlayers.size}/${room.maxPlayers})`);

    io.to(code).emit('player_ready_update', { readyIndex: playerIndex });

    if (room.readyPlayers.size >= room.maxPlayers) {
      room.gameStarted = true;
      console.log(`[ALL READY] Room ${code} — starting game!`);
      io.to(code).emit('all_ready');
      startRound(room);
    }
  });

  // ──────────────────────────────────────────────────────────────
  //  pass_card
  // ──────────────────────────────────────────────────────────────
  socket.on('pass_card', ({ code, playerIndex, cardUid }) => {
    const room = rooms[code];
    if (!room || !room.gameStarted) return;
    if (room.turnIndex !== playerIndex) {
      console.log(`[PASS REJECTED] player ${playerIndex} tried to pass but turn is ${room.turnIndex}`);
      return;
    }
    if (cardUid === room.lastReceivedUid[playerIndex]) {
      console.log(`[PASS REJECTED] player ${playerIndex} tried to pass the card they just received`);
      return;
    }
    processPass(room, playerIndex, cardUid);
  });

  // ──────────────────────────────────────────────────────────────
  //  player_show
  // ──────────────────────────────────────────────────────────────
  socket.on('player_show', ({ code, playerIndex, playerName }) => {
    const room = rooms[code];
    if (!room || !room.gameStarted || room.showCalled) return;
    if (!hasNOfAKind(room.hands[playerIndex], 4)) return;

    clearTimeout(room.turnTimer);
    room.showCalled    = true;
    room.showCallerIdx = playerIndex;

    const puzzleSeed = Math.floor(Math.random() * 1000);
    console.log(`[SHOW] ${playerName} in room ${code}`);

    io.to(code).emit('show_called', {
      callerName:  playerName,
      callerIndex: playerIndex,
      puzzleSeed
    });
  });

  // ──────────────────────────────────────────────────────────────
  //  puzzle_result
  // ──────────────────────────────────────────────────────────────
  socket.on('puzzle_result', ({ code, playerIndex, correct, timeTaken }) => {
    const room = rooms[code];
    if (!room) return;
    if (room.puzzleResults.some(r => r.playerIndex === playerIndex)) return;
    room.puzzleResults.push({ playerIndex, correct: !!correct, timeTaken: timeTaken || 20 });

    const nonShowCount = room.players.length - 1;
    if (room.puzzleResults.length >= nonShowCount) {
      const rankings = buildRankings(room);
      io.to(code).emit('round_results', { rankings });
      console.log(`[ROUND END] room ${code}`);
    }
  });

  // ── Lobby settings broadcast (owner changes settings) ──────
  socket.on('lobby_settings_change', ({ code, numPlayers, topic }) => {
    const room = rooms[code];
    if (!room) return;
    if (socket.id !== room.creatorSocketId) return;
    // Broadcast to everyone else in the room so their dropdowns update
    socket.to(code).emit('settings_update', { numPlayers, topic });
  });

  // ── WebRTC SIGNALING ──────────────────────────────────────────
  socket.on('webrtc_offer', ({ code, fromIndex, toIndex, offer }) => {
    const room = rooms[code];
    if (!room) return;
    const target = room.players[toIndex];
    if (target?.socketId) io.to(target.socketId).emit('webrtc_offer', { fromIndex, offer });
  });

  socket.on('webrtc_answer', ({ code, fromIndex, toIndex, answer }) => {
    const room = rooms[code];
    if (!room) return;
    const target = room.players[toIndex];
    if (target?.socketId) io.to(target.socketId).emit('webrtc_answer', { fromIndex, answer });
  });

  socket.on('webrtc_ice', ({ code, fromIndex, toIndex, candidate }) => {
    const room = rooms[code];
    if (!room) return;
    const target = room.players[toIndex];
    if (target?.socketId) io.to(target.socketId).emit('webrtc_ice', { fromIndex, candidate });
  });

  socket.on('mic_state', ({ code, playerIndex, micOn }) => {
    socket.to(code).emit('mic_state', { playerIndex, micOn });
  });

  // ── CHAT / REACTIONS ─────────────────────────────────────────
  socket.on('reaction', ({ code, name, emoji }) => {
    io.to(code).emit('reaction', { emoji, name });
  });

  socket.on('chat_msg', ({ code, name, msg }) => {
    if (!msg || msg.length > 200) return;
    io.to(code).emit('chat_msg', { name, msg });
  });

  // ── ROOM MANAGEMENT ──────────────────────────────────────────
  socket.on('close_room', ({ code }) => {
    const room = rooms[code];
    if (!room || socket.id !== room.creatorSocketId) return;
    clearTimeout(room.turnTimer);
    io.to(code).emit('room_closed');
    delete rooms[code];
    console.log(`[ROOM CLOSED] ${code}`);
  });

  socket.on('owner_leave', ({ code, playerIndex }) => {
    const room = rooms[code];
    if (!room) return;
    const newOwnerIdx = room.players.findIndex((p, i) => i !== playerIndex && p.socketId);
    if (newOwnerIdx !== -1) {
      room.players[newOwnerIdx].isCreator = true;
      room.creatorSocketId = room.players[newOwnerIdx].socketId;
      io.to(code).emit('new_owner', {
        newOwnerIndex: newOwnerIdx,
        newOwnerName:  room.players[newOwnerIdx].name
      });
    }
    room.players[playerIndex].socketId = null;
    io.to(code).emit('player_disconnected', { playerIndex });
  });

  socket.on('player_leave', ({ code, playerIndex }) => {
    const room = rooms[code];
    if (!room) return;
    room.players[playerIndex].socketId = null;
    io.to(code).emit('player_disconnected', { playerIndex });
  });

  socket.on('disconnect', () => {
    const { code, playerIndex } = socket.data;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (room.players[playerIndex]) room.players[playerIndex].socketId = null;
    console.log(`[SOCKET] disconnected: ${socket.id} from room ${code}`);
    // Only broadcast player_disconnected during an active game.
    // During lobby/leaderboard, do NOT fire this so the toast doesn't appear.
    if (room.gameStarted) {
      io.to(code).emit('player_disconnected', { playerIndex });
    }
  });
});

// ══════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════
server.listen(PORT, () => {
  console.log('');
  console.log('  ███████╗██╗  ██╗ ██████╗ ██╗    ██╗');
  console.log('  ██╔════╝██║  ██║██╔═══██╗██║    ██║');
  console.log('  ███████╗███████║██║   ██║██║ █╗ ██║');
  console.log('  ╚════██║██╔══██║██║   ██║██║███╗██║');
  console.log('  ███████║██║  ██║╚██████╔╝╚███╔███╔╝');
  console.log('  ╚══════╝╚═╝  ╚═╝ ╚═════╝  ╚══╝╚══╝ ');
  console.log('');
  console.log(`  🎮 Server running → http://localhost:${PORT}`);
  console.log('');
});