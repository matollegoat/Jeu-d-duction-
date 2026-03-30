/**
 * server.js — Backend du jeu de déduction sociale
 * Stack : Node.js + Express + Socket.io
 * Toutes les données sont stockées en mémoire (pas de base de données)
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Servir les fichiers statiques du dossier public/
app.use(express.static('public'));

// ─────────────────────────────────────────────
// STOCKAGE EN MÉMOIRE
// ─────────────────────────────────────────────

/**
 * Structure d'une room :
 * {
 *   code: "4821",
 *   hostId: "socket-id",
 *   state: "waiting" | "question" | "answering" | "results",
 *   players: [{ id, name, hasAnswered }],
 *   currentQuestion: "",
 *   answers: [{ text, playerId }]
 * }
 */
const rooms = {};

// ─────────────────────────────────────────────
// UTILITAIRES
// ─────────────────────────────────────────────

/**
 * Génère un code de room à 4 chiffres unique (non déjà utilisé).
 */
function generateCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms[code]);
  return code;
}

/**
 * Mélange un tableau en place avec l'algorithme Fisher-Yates.
 * @param {Array} array
 * @returns {Array} le même tableau mélangé
 */
function shuffleFisherYates(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

/**
 * Retourne la liste publique des joueurs (sans données sensibles).
 * @param {Array} players
 */
function publicPlayers(players) {
  return players.map(p => ({ id: p.id, name: p.name }));
}

/**
 * Vérifie si tous les joueurs restants ont répondu.
 * @param {Object} room
 * @returns {boolean}
 */
function allAnswered(room) {
  return room.players.length > 0 && room.players.every(p => p.hasAnswered);
}

/**
 * Déclenche la phase résultats : mélange les réponses et les envoie sans noms.
 * @param {Object} room
 */
function showResults(room) {
  room.state = 'results';
  const shuffled = shuffleFisherYates([...room.answers]).map(a => a.text);
  console.log(`[Room ${room.code}] Résultats envoyés — ${shuffled.length} réponse(s).`);
  io.to(room.code).emit('show-results', { answers: shuffled });
}

// ─────────────────────────────────────────────
// GESTION DES CONNEXIONS SOCKET.IO
// ─────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[Connexion] Socket connecté : ${socket.id}`);

  // ── CREATE-ROOM ──────────────────────────────
  /**
   * Un joueur crée une nouvelle room.
   * Payload : { name }
   * Réponse : room-created { code }
   */
  socket.on('create-room', ({ name }) => {
    const trimmedName = (name || '').trim();
    if (!trimmedName) {
      return socket.emit('error', { message: 'Le prénom ne peut pas être vide.' });
    }

    const code = generateCode();
    rooms[code] = {
      code,
      hostId: socket.id,
      state: 'waiting',
      players: [{ id: socket.id, name: trimmedName, hasAnswered: false }],
      currentQuestion: '',
      answers: []
    };

    socket.join(code);
    // On stocke le code de room sur le socket pour le retrouver à la déconnexion
    socket.roomCode = code;

    console.log(`[Room ${code}] Créée par "${trimmedName}" (${socket.id})`);
    socket.emit('room-created', { code });
    // Envoyer aussi room-joined pour que le client initialise son état
    socket.emit('room-joined', {
      players: publicPlayers(rooms[code].players),
      state: rooms[code].state,
      isHost: true
    });
  });

  // ── JOIN-ROOM ────────────────────────────────
  /**
   * Un joueur rejoint une room existante.
   * Payload : { code, name }
   * Réponse : room-joined { players, state, isHost } ou error
   */
  socket.on('join-room', ({ code, name }) => {
    const trimmedName = (name || '').trim();
    const trimmedCode = (code || '').trim();

    if (!trimmedName) {
      return socket.emit('error', { message: 'Le prénom ne peut pas être vide.' });
    }
    if (!trimmedCode || !/^\d{4}$/.test(trimmedCode)) {
      return socket.emit('error', { message: 'Le code doit être composé de 4 chiffres.' });
    }

    const room = rooms[trimmedCode];
    if (!room) {
      return socket.emit('error', { message: 'Code de partie invalide.' });
    }
    if (room.state !== 'waiting') {
      return socket.emit('error', { message: 'La partie a déjà commencé.' });
    }

    room.players.push({ id: socket.id, name: trimmedName, hasAnswered: false });
    socket.join(trimmedCode);
    socket.roomCode = trimmedCode;

    console.log(`[Room ${trimmedCode}] "${trimmedName}" (${socket.id}) a rejoint. Joueurs : ${room.players.length}`);

    // Confirmer au joueur qui vient de rejoindre
    socket.emit('room-joined', {
      players: publicPlayers(room.players),
      state: room.state,
      isHost: false,
      code: trimmedCode
    });

    // Notifier tous les autres joueurs de la room
    socket.to(trimmedCode).emit('player-joined', {
      players: publicPlayers(room.players)
    });
  });

  // ── START-GAME ───────────────────────────────
  /**
   * L'hôte lance la partie.
   * Payload : { code }
   * Réponse : game-started à toute la room, ou error
   */
  socket.on('start-game', ({ code }) => {
    const room = rooms[code];
    if (!room) return; // room inexistante, on ignore

    // Seul l'hôte peut lancer
    if (room.hostId !== socket.id) return;

    if (room.players.length < 2) {
      return socket.emit('error', { message: 'Il faut au minimum 2 joueurs pour lancer la partie.' });
    }

    room.state = 'question';
    console.log(`[Room ${code}] Partie lancée par l'hôte.`);
    io.to(code).emit('game-started');
  });

  // ── SUBMIT-QUESTION ──────────────────────────
  /**
   * L'hôte envoie la question de la manche.
   * Payload : { code, question }
   * Réponse : question-received { question } à toute la room
   */
  socket.on('submit-question', ({ code, question }) => {
    const room = rooms[code];
    if (!room) return;
    if (room.hostId !== socket.id) return; // Non-hôte → on ignore

    const trimmedQ = (question || '').trim();
    if (!trimmedQ) {
      return socket.emit('error', { message: 'La question ne peut pas être vide.' });
    }

    room.currentQuestion = trimmedQ;
    room.state = 'answering';
    // Réinitialiser les réponses et les statuts
    room.answers = [];
    room.players.forEach(p => p.hasAnswered = false);

    console.log(`[Room ${code}] Question envoyée : "${trimmedQ}"`);
    io.to(code).emit('question-received', { question: trimmedQ });
  });

  // ── SUBMIT-ANSWER ────────────────────────────
  /**
   * Un joueur envoie sa réponse.
   * Payload : { code, answer }
   * Réponse : answer-recorded { answeredCount, totalCount } à toute la room
   *           show-results quand tout le monde a répondu
   */
  socket.on('submit-answer', ({ code, answer }) => {
    const room = rooms[code];
    if (!room || room.state !== 'answering') return;

    const trimmedAnswer = (answer || '').trim();
    if (!trimmedAnswer) {
      return socket.emit('error', { message: 'La réponse ne peut pas être vide.' });
    }

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return; // Joueur inconnu

    // Ignorer la double réponse
    if (player.hasAnswered) {
      console.log(`[Room ${code}] Double réponse ignorée de "${player.name}".`);
      return;
    }

    player.hasAnswered = true;
    room.answers.push({ text: trimmedAnswer, playerId: socket.id });

    const answeredCount = room.players.filter(p => p.hasAnswered).length;
    const totalCount = room.players.length;

    console.log(`[Room ${code}] Réponse reçue de "${player.name}" (${answeredCount}/${totalCount}).`);

    // Notifier toute la room de la progression
    io.to(code).emit('answer-recorded', { answeredCount, totalCount });

    // Si tout le monde a répondu, afficher les résultats
    if (allAnswered(room)) {
      showResults(room);
    }
  });

  // ── NEW-ROUND ────────────────────────────────
  /**
   * L'hôte lance une nouvelle manche sans recréer la room.
   * Payload : { code }
   * Réponse : game-started à toute la room (on repasse à la phase question)
   */
  socket.on('new-round', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    if (room.hostId !== socket.id) return;

    room.state = 'question';
    room.currentQuestion = '';
    room.answers = [];
    room.players.forEach(p => p.hasAnswered = false);

    console.log(`[Room ${code}] Nouvelle manche lancée par l'hôte.`);
    io.to(code).emit('game-started');
  });

  // ── DISCONNECT ───────────────────────────────
  /**
   * Gestion de la déconnexion d'un joueur.
   * Cas : waiting, answering, hôte parti, room vide.
   */
  socket.on('disconnect', () => {
    console.log(`[Déconnexion] Socket : ${socket.id}`);

    const code = socket.roomCode;
    if (!code || !rooms[code]) return;

    const room = rooms[code];

    // Si l'hôte se déconnecte → on prévient tout le monde et on supprime la room
    if (room.hostId === socket.id) {
      console.log(`[Room ${code}] L'hôte s'est déconnecté. Room supprimée.`);
      io.to(code).emit('error', { message: "L'hôte a quitté la partie. La session est terminée." });
      delete rooms[code];
      return;
    }

    // Retirer le joueur de la liste
    room.players = room.players.filter(p => p.id !== socket.id);
    console.log(`[Room ${code}] Un joueur s'est déconnecté. Joueurs restants : ${room.players.length}`);

    // Si la room est vide (hors hôte), on la supprime
    if (room.players.length === 0) {
      console.log(`[Room ${code}] Room vide, supprimée.`);
      delete rooms[code];
      return;
    }

    // Notifier les joueurs restants
    if (room.state === 'waiting') {
      io.to(code).emit('player-left', { players: publicPlayers(room.players) });
    }

    // En phase de réponse : vérifier si les restants ont tous répondu
    if (room.state === 'answering') {
      io.to(code).emit('player-left', { players: publicPlayers(room.players) });
      if (allAnswered(room)) {
        showResults(room);
      }
    }
  });
});

// ─────────────────────────────────────────────
// DÉMARRAGE DU SERVEUR
// ─────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Serveur démarré sur le port ${PORT}`);
});
