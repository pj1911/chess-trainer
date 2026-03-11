// ===== UI chessboard (cm-chessboard) =====
import { Chessboard, COLOR, INPUT_EVENT_TYPE } from "https://unpkg.com/cm-chessboard@8.11.5/src/Chessboard.js";
import { Markers } from "https://unpkg.com/cm-chessboard@8.11.5/src/extensions/markers/Markers.js";
import { PromotionDialog } from "https://unpkg.com/cm-chessboard@8.11.5/src/extensions/promotion-dialog/PromotionDialog.js";
import { Arrows, ARROW_TYPE } from "https://unpkg.com/cm-chessboard@8.11.5/src/extensions/arrows/Arrows.js";

// chess.js is loaded globally via <script> in index.html (Chess constructor)
const ChessCtor = window.Chess;

const ENGINE_WORKER_URL = "./engine/stockfish-18-lite-single.js";
const ASSETS_URL = "https://cdn.jsdelivr.net/npm/cm-chessboard@8.11.5/assets/";

// --- Human-ish engine selection ---
const PLAY_SELECT_DEPTH = 8;     // lower than analysis; faster + more human
const PLAY_SELECT_MULTIPV = 8;    // consider top 4 moves

// Keys in localStorage
const LS_PROFILE = "pct.profile.v1";
const LS_SAVED = "pct.savedGames.v1";

const LS_SHOW_BESTMOVE = "pct.showBestMove.v1";

const EVALBAR_DEPTH = 14;           // increase for stronger eval, but slower
const EVALBAR_DEBOUNCE_MS = 140;    // how often to re-evaluate after position changes
const EVALBAR_CLAMP_CP = 2000;      // clamp for bar scaling (+/- 20 pawns)
const EVALBAR_LOGISTIC_DIV = 250;   // bar sensitivity (smaller => more extreme)

const DEFAULT_PROFILE = {
  userElo: 1000,
  gamesPlayed: 0
};

const TARGET_ELO_OFFSET = 50;

// Playing/search settings (kept simple)
const PLAY_MOVE_TIME_MS = 350;   // engine thinking time per move
const ANALYSIS_DEPTH = 14;       // post-game review depth
const ANALYSIS_MULTIPV = 2;      // get best + 2nd best to detect "great/brilliant"

// --- DOM helpers
const $ = (id) => document.getElementById(id);

const ui = {
  userElo: $("userElo"),
  engineElo: $("engineElo"),

  statusMain: $("statusMain"),
  statusSub: $("statusSub"),

  newGameBtn: $("newGameBtn"),
  resignBtn: $("resignBtn"),
  analyzeBtn: $("analyzeBtn"),
  savedTabBtn: $("savedTabBtn"),

  tabBtns: Array.from(document.querySelectorAll(".tabBtn")),
  tabGame: $("tab-game"),
  tabAnalysis: $("tab-analysis"),
  tabSaved: $("tab-saved"),

  moves: $("moves"),

  analysisSummary: $("analysisSummary"),
  analysisMoves: $("analysisMoves"),
  evalGraph: $("evalGraph"),

  navStart: $("navStart"),
  navPrev: $("navPrev"),
  navNext: $("navNext"),
  navEnd: $("navEnd"),
  navLabel: $("navLabel"),

  exportPgnBtn: $("exportPgnBtn"),
  clearSavedBtn: $("clearSavedBtn"),
  savedList: $("savedList"),
  bestMoveToggle: $("bestMoveToggle"),

  evalBar: $("evalBar"),
  evalFill: $("evalFill"),
  evalText: $("evalText")
};

// Gaussian helper (Box-Muller)
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Split-normal target accuracy: wide lower tail, tight upper tail
function sampleTargetEngineAccuracy() {
  const z = randn();
  const delta = z < 0 ? z * 10 : z * 2.5;  // ~10% std down, ~2–3% up
  return clamp(90 + delta, 75, 93);
}

function avg(arr) {
  return arr.length ? arr.reduce((a,b)=>a+b,0) / arr.length : 0;
}

// ===== Storage =====
function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

// ===== Elo math =====
function expectedScore(playerElo, oppElo) {
  return 1 / (1 + Math.pow(10, (oppElo - playerElo) / 400));
}

function kFactor(gamesPlayed) {
  if (gamesPlayed < 10) return 40; // faster calibration early
  if (gamesPlayed < 30) return 24;
  return 16;
}

function updateElo(playerElo, oppElo, score, gamesPlayed) {
  const exp = expectedScore(playerElo, oppElo);
  const k = kFactor(gamesPlayed);
  return Math.round(playerElo + k * (score - exp));
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTypingInInput() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

function fenAfterPly(game, plyCount) {
  const temp = new ChessCtor();
  const hist = game.history({ verbose: true });
  for (let i = 0; i < plyCount; i++) temp.move(hist[i]);
  return temp.fen();
}

function refreshPlayStatus() {
  if (isGameFinished) {
    setStatus("Game over.", "Go to Analysis for review.");
    return;
  }
  if (isEngineThinking || chess.turn() === "b") {
    setStatus("Engine thinking…", "");
    return;
  }
  setStatus("Your turn.", "Tap a piece to see legal moves.");
}

function setPlayViewPly(ply) {
  if (!chess) return;
  const total = chess.history().length;

  playViewPly = clamp(ply, 0, total);

  // show that historical position
  const fen = fenAfterPly(chess, playViewPly);
  board.setPosition(fen);

  if (playViewPly !== total) {
    setStatus(
      "Reviewing this game…",
      `Ply ${playViewPly}/${total}. Press → to return to live position.`
    );
  } else {
    // back to live
    board.setPosition(chess.fen());
    refreshPlayStatus();

    // if it's black to move and engine isn't thinking, continue
    if (!isGameFinished && !isEngineThinking && chess.turn() === "b") {
      engineMoveIfNeeded();
    }
  }
}

// ===== Stockfish worker wrapper =====
class StockfishClient {
  constructor(workerUrl) {
    this.worker = new Worker(workerUrl);
    this.waiters = [];
    this.isBusy = false;

    this.worker.onmessage = (e) => {
    const raw = (e && typeof e.data !== "undefined") ? e.data : e;
    const text = String(raw ?? "");

    // Stockfish may send multiple lines in a single message:
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

    for (const line of lines) {
      for (let i = 0; i < this.waiters.length; i++) {
        const w = this.waiters[i];
        if (w.predicate(line)) {
          this.waiters.splice(i, 1);
          i--;
          w.resolve(line);
        }
      }
    }
  };
}//

  post(cmd) {
    this.worker.postMessage(cmd);
  }

  waitFor(predicate, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        // remove waiter
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error("Timeout waiting for engine output"));
      }, timeoutMs);

      this.waiters.push({
        predicate,
        resolve: (line) => {
          clearTimeout(t);
          resolve(line);
        }
      });
    });
  }

  async init() {
    this.post("uci");
    await this.waitFor((l) => l === "uciok");
    this.post("isready");
    await this.waitFor((l) => l === "readyok");
  }

  async setOption(name, value) {
    this.post(`setoption name ${name} value ${value}`);
  }

  async isReady() {
    this.post("isready");
    await this.waitFor((l) => l === "readyok");
  }

  async newGame() {
    this.post("ucinewgame");
    await this.isReady();
  }

  // Stockfish UCI_Elo has a minimum of 1320, so we use it when possible.
  // Otherwise fallback to Skill Level. :contentReference[oaicite:3]{index=3}
  async setStrength(targetElo) {
    const elo = Math.round(targetElo);

    // reset relevant knobs
    await this.setOption("UCI_LimitStrength", "false");
    await this.setOption("Skill Level", "20");

    if (elo >= 1320) {
      await this.setOption("UCI_LimitStrength", "true");
      await this.setOption("UCI_Elo", String(clamp(elo, 1320, 3190)));
    } else {
      // fallback: approximate weaker play
      // This is not a perfect Elo mapping; it just makes it more human-like at low levels.
      const skill = clamp(Math.round((elo - 600) / 50), 0, 20); // 600->0, 1600->20
      await this.setOption("UCI_LimitStrength", "false");
      await this.setOption("Skill Level", String(skill));
    }

    await this.isReady();
  }

  // Analyze current position with given depth and MultiPV (1 or 2).
  async analyzePosition(fen, { depth = 12, multiPV = 1 } = {}) {
    if (this.isBusy) {
      // simple serialization: wait until free
      await new Promise((r) => setTimeout(r, 10));
      return this.analyzePosition(fen, { depth, multiPV });
    }
    this.isBusy = true;

    const lines = new Map(); // multipv -> { score:{type, value}, pv:[] }
    let bestMove = null;

    const fenSideToMove = fen.split(" ")[1]; // 'w' or 'b'

    const parseInfo = (line) => {
      if (!line.startsWith("info ")) return;

      const tokens = line.split(/\s+/);
      const idxScore = tokens.indexOf("score");
      const idxPv = tokens.indexOf("pv");
      if (idxScore < 0 || idxPv < 0) return;

      // multipv
      let mpv = 1;
      const idxMp = tokens.indexOf("multipv");
      if (idxMp >= 0 && tokens[idxMp + 1]) mpv = parseInt(tokens[idxMp + 1], 10) || 1;

      const scoreType = tokens[idxScore + 1];
      const scoreVal = parseInt(tokens[idxScore + 2], 10);
      if (!Number.isFinite(scoreVal)) return;

      const pvMoves = tokens.slice(idxPv + 1);

      lines.set(mpv, {
        score: { type: scoreType, value: scoreVal },
        pv: pvMoves
      });
    };

    const onInfo = (line) => parseInfo(line);

    // We can’t “subscribe” here; we just keep a waiter that watches all lines.
    // We'll do it by repeatedly waiting for either "info ..." or "bestmove ...".
    await this.setOption("MultiPV", String(multiPV));
    await this.isReady();

    this.post(`position fen ${fen}`);
    this.post(`go depth ${depth}`);

    while (true) {
      const line = await this.waitFor((l) => l.startsWith("info ") || l.startsWith("bestmove "));
      if (line.startsWith("info ")) {
        onInfo(line);
        continue;
      }
      if (line.startsWith("bestmove ")) {
        const parts = line.split(/\s+/);
        bestMove = parts[1] || null;
        break;
      }
    }

    this.isBusy = false;

    const normalizeToWhiteCp = (scoreObj) => {
      if (!scoreObj) return null;

      // Stockfish UCI score is commonly interpreted as "for side to move".
      // Convert to "white perspective" by flipping sign when black is to move.
      const flip = fenSideToMove === "b" ? -1 : 1;

      if (scoreObj.type === "cp") return flip * scoreObj.value;
      if (scoreObj.type === "mate") {
        // Convert mate scores to a large cp-like number (for graphs & thresholds).
        // Positive mate means side-to-move mates soon.
        const mate = flip * scoreObj.value; // now positive means "white mates soon"
        const sign = Math.sign(mate) || 1;
        const dist = Math.min(50, Math.abs(mate));
        return sign * (100000 - dist * 1000);
      }
      return null;
    };

    const line1 = lines.get(1) || null;
    const line2 = lines.get(2) || null;

    const linesArr = Array.from(lines.entries())
    .sort((a, b) => a[0] - b[0]) // multipv order
    .map(([mpv, obj]) => ({
      multipv: mpv,
      score: obj.score,
      pv: obj.pv,
      evalWhiteCp: normalizeToWhiteCp(obj.score)
    }));

    return {
    fen,
    bestMove,
    line1,
    line2,
    lines: linesArr, // <-- add this
    evalWhiteCp: normalizeToWhiteCp(line1?.score || null),
    eval2WhiteCp: normalizeToWhiteCp(line2?.score || null)
  };
  }

  async bestMove(fen, { movetimeMs = 300 } = {}) {
    if (this.isBusy) {
      await new Promise((r) => setTimeout(r, 10));
      return this.bestMove(fen, { movetimeMs });
    }
    this.isBusy = true;

    let bestMove = null;
    await this.setOption("MultiPV", "1");
    await this.isReady();

    this.post(`position fen ${fen}`);
    this.post(`go movetime ${movetimeMs}`);

    while (true) {
      const line = await this.waitFor((l) => l.startsWith("bestmove "));
      const parts = line.split(/\s+/);
      bestMove = parts[1] || null;
      break;
    }

    this.isBusy = false;
    return bestMove;
  }
}


// ===== Game state =====
let profile = loadJSON(LS_PROFILE, DEFAULT_PROFILE);

let engine = null;
let board = null;
let chess = null;

let engineHuman = {
  targetAcc: 90,
  accList: [] // estimated accuracy per engine move
};

let engineTargetElo = null;
let isEngineThinking = false;
let isGameFinished = false;

let showBestMoveArrow = loadJSON(LS_SHOW_BESTMOVE, false);
let bestMoveReqId = 0;

let evalDebounceTimer = null;
let evalReqId = 0;

// Analysis navigation
let review = {
  fenList: [],
  posEval: [],
  plyEls: new Map(),
  currentPly: 0,
  evalByFen: new Map()
};

let mode = "play";          // "play" | "analysis"
let analysisChess = null;   // chess.js instance used in analysis sandbox
let isAnalysisRunning = false;
let playViewPly = 0; // 0..chess.history().length (which ply is shown while playing)

// ===== UI tabs =====
function setTab(name) {
  ui.tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  ui.tabGame.classList.toggle("active", name === "game");
  ui.tabAnalysis.classList.toggle("active", name === "analysis");
  ui.tabSaved.classList.toggle("active", name === "saved");

  if (name === "analysis") {
  mode = "analysis";
  refreshBestMoveArrow();

  // If we already analyzed a game, go to the selected ply position
  if (review.fenList && review.fenList.length) {
    setReviewPly(review.currentPly);
  showEvalBar(true);
  scheduleEvalBarUpdate();

  } else if (chess) {
    showEvalBar(false);
    // fallback: allow sandbox moves from current position
    analysisChess = new ChessCtor(chess.fen());
    syncBoardToGame(analysisChess);
  }
} else {
  mode = "play";
  if (chess) syncBoardToGame(chess);
  clearBestMoveArrow();
  playViewPly = chess.history().length;
}
}



// ===== Board + move list rendering =====
function setStatus(main, sub = "") {
  ui.statusMain.textContent = main;
  ui.statusSub.textContent = sub;
}

function renderRatings() {
  ui.userElo.textContent = String(profile.userElo);
  ui.engineElo.textContent = String(engineTargetElo ?? "—");
}

function clearMovesUI() {
  ui.moves.innerHTML = "";
}

function addMoveRow(moveNumber, whiteSan, blackSan) {
  const row = document.createElement("div");
  row.className = "moveRow";
  row.innerHTML = `
    <div class="moveNum">${moveNumber}.</div>
    <div class="moveText">
      <span>${whiteSan || ""}</span>
      <span class="muted">${blackSan || ""}</span>
    </div>
  `;
  ui.moves.appendChild(row);
}

function rebuildMovesUIFromHistory() {
  clearMovesUI();
  const hist = chess.history(); // SAN array
  for (let i = 0; i < hist.length; i += 2) {
    const moveNo = i / 2 + 1;
    addMoveRow(moveNo, hist[i], hist[i + 1] || "");
  }
}

function uciToMoveObj(uci) {
  if (!uci || uci.length < 4) return null;
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length >= 5 ? uci[4] : undefined;
  return { from, to, promotion };
}

function makeMove(game, from, to, promotion) {
  const moveObj = promotion ? { from, to, promotion } : { from, to };
  return game.move(moveObj); // returns move object, or null if illegal
}

function syncBoardToGame(game) {
  board.setPosition(game.fen());
}

function getActiveGame() {
  return mode === "analysis" ? analysisChess : chess;
}

// ===== Game over helpers (chess.js 0.10.3) =====
function isGameOver() {
  return chess.game_over();
}
function isCheckmate() {
  return chess.in_checkmate();
}
function isStalemate() {
  return chess.in_stalemate();
}
function isDraw() {
  return chess.in_draw();
}

function gameResultString() {
  if (isCheckmate()) {
    // Side to move is checkmated, so winner is opposite
    const loser = chess.turn(); // 'w' or 'b'
    return loser === "w" ? "0-1" : "1-0";
  }
  if (isStalemate() || isDraw()) return "1/2-1/2";
  return "*";
}

function userScoreFromResult(result) {
  // You always play White in this simple version.
  if (result === "1-0") return 1;
  if (result === "0-1") return 0;
  if (result === "1/2-1/2") return 0.5;
  return 0.5;
}

// ===== Move classification (simple but useful) =====
function badgeClass(label) {
  const m = {
    Brilliant: "brilliant",
    Great: "great",
    Best: "best",
    Excellent: "excellent",
    Good: "good",
    Inaccuracy: "inaccuracy",
    Mistake: "mistake",
    Blunder: "blunder"
  };
  return m[label] || "good";
}

function cpLossForMove(bestEvalWhiteCp, afterEvalWhiteCp, moverColor) {
  // moverColor: 'w' or 'b'
  if (bestEvalWhiteCp == null || afterEvalWhiteCp == null) return 0;

  if (moverColor === "w") return Math.max(0, bestEvalWhiteCp - afterEvalWhiteCp);
  return Math.max(0, afterEvalWhiteCp - bestEvalWhiteCp);
}

function approxAccuracyFromCpl(cpl) {
  if (cpl <= 10) return 100;
  if (cpl <= 25) return 95;
  if (cpl <= 50) return 90;
  if (cpl <= 100) return 80;
  if (cpl <= 200) return 65;
  if (cpl <= 300) return 50;
  if (cpl <= 500) return 35;
  return 20;
}


function pickHumanEngineMove(res, moverColor, state) {
  const lines = res?.lines || [];
  const candidates = [];

  for (const l of lines) {
    const uci = l?.pv?.[0];
    if (!uci || uci === "(none)") continue;

    candidates.push({
      uci,
      evalWhiteCp: l.evalWhiteCp ?? 0
    });
  }

  // de-dupe
  const seen = new Set();
  const uniq = candidates.filter(c => (seen.has(c.uci) ? false : (seen.add(c.uci), true)));

  if (!uniq.length) return res.bestMove;

  const bestEval = uniq[0].evalWhiteCp;
  for (const c of uniq) {
    c.cpl = cpLossForMove(bestEval, c.evalWhiteCp, moverColor);
  }

  const gap = uniq.length > 1 ? Math.abs(uniq[0].evalWhiteCp - uniq[1].evalWhiteCp) : 0;
  const difficulty = clamp((gap - 60) / 260, 0, 1); // big gap => only-move-ish => "hard"

  const current = avg(state.accList) || 92;
  const target = state.targetAcc || 90;

  // If we're playing "too accurately", increase mistake chance.
  const over = clamp((current - target) / 12, -1, 1);
  const overPos = Math.max(0, over);

  // Probability of NOT playing the best move:
  let pNonBest = 0.10 + 0.28 * difficulty + 0.22 * overPos;
  pNonBest = clamp(pNonBest, 0.05, 0.55);

  let choice = uniq[0];

  if (uniq.length > 1 && Math.random() < pNonBest) {
    const pool = uniq.slice(1);

    // Prefer small inaccuracies over huge blunders
    const weights = pool.map(c => Math.exp(-c.cpl / 70)); // scale controls "how human"
    const sum = weights.reduce((a,b)=>a+b,0) || 1;

    let r = Math.random() * sum;
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) { choice = pool[i]; break; }
    }
  }

  // Track “expected” accuracy for this move (rough proxy)
  state.accList.push(approxAccuracyFromCpl(choice.cpl || 0));

  return choice.uci;
}

function materialFromFen(fen) {
  const temp = new ChessCtor(fen);
  const b = temp.board();
  const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const sum = { w: 0, b: 0 };
  for (const row of b) {
    for (const piece of row) {
      if (!piece) continue;
      sum[piece.color] += values[piece.type] ?? 0;
    }
  }
  return sum;
}

function classifyMove({ isBest, gapCp, cpl, sacrificed }) {
  // chess.com-style labeling (simplified heuristics)
  if (isBest && sacrificed && gapCp >= 120) return "Brilliant";
  if (isBest && gapCp >= 200) return "Great";
  if (isBest) return "Best";

  if (cpl <= 20) return "Excellent";
  if (cpl <= 50) return "Good";
  if (cpl <= 100) return "Inaccuracy";
  if (cpl <= 300) return "Mistake";
  return "Blunder";
}

// ===== Post-game analysis =====
function drawEvalGraph(evalCpList) {
  const canvas = ui.evalGraph;
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;

  ctx.clearRect(0, 0, W, H);

  // Background grid
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;

  // draw center line (0 eval)
  ctx.strokeStyle = "#2a344f";
  ctx.beginPath();
  ctx.moveTo(0, H / 2);
  ctx.lineTo(W, H / 2);
  ctx.stroke();

  // Clamp eval to +/- 800cp for visibility
  const clampCp = (cp) => clamp(cp, -800, 800);

  const points = evalCpList.map((cp, i) => {
    const x = (i / Math.max(1, evalCpList.length - 1)) * (W - 20) + 10;
    const y = H / 2 - (clampCp(cp) / 800) * (H / 2 - 12);
    return { x, y };
  });

  ctx.strokeStyle = "#7aa2ff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, idx) => {
    if (idx === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();
}

function updateAnalysisNavLabel() {
  if (!analysisChess) {
    ui.navLabel.textContent = "—";
    return;
  }
  const base = review.currentPly || 0;
  const extra = analysisChess.history().length;

  if (base === 0 && extra === 0) ui.navLabel.textContent = "Start";
  else if (extra === 0) ui.navLabel.textContent = `After ply ${base}`;
  else ui.navLabel.textContent = `After ply ${base} +${extra}`;
}

function setReviewPly(plyIndex) {
  review.currentPly = clamp(plyIndex, 0, Math.max(0, review.fenList.length - 1));

  const fen = review.fenList[review.currentPly];
  if (fen) {
    // Reset analysis sandbox at that exact position
    analysisChess = new ChessCtor(fen);
    syncBoardToGame(analysisChess);
  }

  updateAnalysisNavLabel();

  // highlight selected move in the two-column list
  if (review.plyEls) {
    for (const el of review.plyEls.values()) el.classList.remove("selected");
    const sel = review.plyEls.get(review.currentPly);
    if (sel) sel.classList.add("selected");
  }

  // update best move arrow + eval bar for the current analysis position
  refreshBestMoveArrow();
  scheduleEvalBarUpdate();
}

function clearBestMoveArrow() {
  if (board && typeof board.removeArrows === "function") board.removeArrows();
}

function showEvalBar(visible) {
  if (!ui.evalBar) return;
  ui.evalBar.classList.toggle("show", !!visible);
}

function clampEvalCp(cp) {
  return clamp(cp, -EVALBAR_CLAMP_CP, EVALBAR_CLAMP_CP);
}

// Convert centipawn eval (white perspective) -> 0..1 where 1 means winning for White.
function evalCpToPercent(cp) {
  const c = clampEvalCp(cp);
  return 1 / (1 + Math.exp(-c / EVALBAR_LOGISTIC_DIV));
}

function formatEvalLabel(res) {
  const score = res?.line1?.score;
  const fenSide = res?.fen?.split(" ")[1] || "w"; // w/b to move
  const flip = fenSide === "b" ? -1 : 1;

  if (score?.type === "mate") {
    const mateForWhite = flip * score.value; // + means White mates
    const sign = mateForWhite >= 0 ? "" : "-";
    return `${sign}M${Math.abs(mateForWhite)}`;
  }

  const cp = res?.evalWhiteCp ?? 0;
  const pawns = (cp / 100).toFixed(1);
  return (cp > 0 ? "+" : "") + pawns;
}

function setEvalBarFromResult(res) {
  if (!ui.evalFill || !ui.evalText) return;

  const cp = res?.evalWhiteCp ?? 0;
  const pct = evalCpToPercent(cp);

  ui.evalFill.style.height = `${pct * 100}%`;
  ui.evalText.textContent = formatEvalLabel(res);
}

function setEvalBarLoading() {
  if (!ui.evalFill || !ui.evalText) return;
  ui.evalFill.style.height = `50%`;
  ui.evalText.textContent = "…";
}

function scheduleEvalBarUpdate() {
  if (mode !== "analysis") return;
  if (!analysisChess || !engine) return;
  if (!ui.evalBar) return;

  // keep it visible in analysis
  showEvalBar(true);

  if (evalDebounceTimer) clearTimeout(evalDebounceTimer);
  evalDebounceTimer = setTimeout(() => {
    refreshEvalBarNow();
  }, EVALBAR_DEBOUNCE_MS);
}

async function refreshEvalBarNow() {
  if (mode !== "analysis") return;
  if (!analysisChess || !engine) return;
  if (!ui.evalBar) return;
  if (isAnalysisRunning) {
    // During full-game analysis, engine is busy; keep bar visible but show loading
    showEvalBar(true);
    setEvalBarLoading();
    return;
  }

  const fen = analysisChess.fen();
  const reqId = ++evalReqId;

  showEvalBar(true);

  // 1) Use cached eval if we have it
  const cached = review.evalByFen?.get(fen);
  if (cached) {
    setEvalBarFromResult(cached);
    return;
  }

  // 2) Otherwise do a quick engine eval
  setEvalBarLoading();
  try {
    const res = await engine.analyzePosition(fen, { depth: EVALBAR_DEPTH, multiPV: 1 });

    // Ignore stale results
    if (reqId !== evalReqId) return;
    if (mode !== "analysis") return;
    if (!analysisChess || analysisChess.fen() !== fen) return;

    // Cache it (helps when you bounce around positions)
    if (!review.evalByFen) review.evalByFen = new Map();
    review.evalByFen.set(fen, res);

    setEvalBarFromResult(res);

    // OPTIONAL bonus: if your best-move arrow toggle is ON, update arrow from same result:
    if (typeof showBestMoveArrow !== "undefined" && showBestMoveArrow) {
      if (typeof clearBestMoveArrow === "function") clearBestMoveArrow();
      if (board && typeof board.addArrow === "function" && res.bestMove && res.bestMove !== "(none)") {
        const from = res.bestMove.slice(0, 2);
        const to = res.bestMove.slice(2, 4);
        board.addArrow(ARROW_TYPE.info, from, to);
      }
    }
  } catch (err) {
    console.error(err);
  }
}

async function refreshBestMoveArrow() {
  clearBestMoveArrow();

  if (!showBestMoveArrow) return;
  if (mode !== "analysis") return;
  if (isAnalysisRunning) return;
  if (!analysisChess || !engine) return;
  if (typeof board.addArrow !== "function") return;

  const fen = analysisChess.fen();
  const reqId = ++bestMoveReqId;

  try {
    const bm = await engine.bestMove(fen, { movetimeMs: 200 });

    // ignore stale results
    if (reqId !== bestMoveReqId) return;
    if (!showBestMoveArrow || mode !== "analysis") return;
    if (!analysisChess || analysisChess.fen() !== fen) return;

    if (!bm || bm === "(none)") return;

    const from = bm.slice(0, 2);
    const to = bm.slice(2, 4);

    clearBestMoveArrow();
    board.addArrow(ARROW_TYPE.info, from, to);
  } catch (err) {
    console.error(err);
  }
}

  updateAnalysisNavLabel();

  // highlight selected move in the two-column list
  if (review.plyEls) {
    for (const el of review.plyEls.values()) el.classList.remove("selected");
    const sel = review.plyEls.get(review.currentPly);
    if (sel) sel.classList.add("selected");
  }

async function runAnalysisAndRender({ autoSavePrompt = true } = {}) {
  isAnalysisRunning = true;
  try {
  setTab("analysis");
  ui.analysisSummary.innerHTML = "";
  ui.analysisMoves.innerHTML = "";
  ui.analyzeBtn.disabled = true;

  setStatus("Analyzing game…", "This runs locally in your browser.");

  const historyVerbose = chess.history({ verbose: true }); // [{from,to,promotion?,san,color,...}, ...]
  const fenList = [];
  const temp = new ChessCtor();
  fenList.push(temp.fen());
  for (const mv of historyVerbose) {
    temp.move(mv);
    fenList.push(temp.fen());
  }

  const posEval = [];
  for (let i = 0; i < fenList.length; i++) {
    setStatus("Analyzing game…", `Position ${i + 1} / ${fenList.length}`);
    const res = await engine.analyzePosition(fenList[i], { depth: ANALYSIS_DEPTH, multiPV: ANALYSIS_MULTIPV });
    posEval.push(res);
  }

  review.evalByFen = new Map(posEval.map(p => [p.fen, p]));
  scheduleEvalBarUpdate();

  // Build per-move review rows
  const plyInfo = [];
  let accW = [];
  let accB = [];
  const counts = {
    w: { Brilliant: 0, Great: 0, Best: 0, Excellent: 0, Good: 0, Inaccuracy: 0, Mistake: 0, Blunder: 0 },
    b: { Brilliant: 0, Great: 0, Best: 0, Excellent: 0, Good: 0, Inaccuracy: 0, Mistake: 0, Blunder: 0 }
  };

  const evalSeries = posEval.map((p) => p.evalWhiteCp ?? 0);
  drawEvalGraph(evalSeries);

  for (let ply = 0; ply < historyVerbose.length; ply++) {
    const mv = historyVerbose[ply];
    const mover = mv.color; // 'w' or 'b'
    const uci = `${mv.from}${mv.to}${mv.promotion || ""}`;

    const before = posEval[ply];
    const after = posEval[ply + 1];

    const bestMoveUci = before.bestMove || (before.line1?.pv?.[0] ?? null);
    const bestEval = before.evalWhiteCp;
    const secondEval = before.eval2WhiteCp;

    const afterEval = after.evalWhiteCp;

    const cpl = cpLossForMove(bestEval, afterEval, mover);
    const gap = bestEval != null && secondEval != null ? Math.abs(bestEval - secondEval) : 0;
    const isBest = bestMoveUci && uci === bestMoveUci;

    const matBefore = materialFromFen(fenList[ply]);
    const matAfter = materialFromFen(fenList[ply + 1]);
    const sacrificed = matAfter[mover] < matBefore[mover] - 1; // at least ~2 points down

    const label = classifyMove({ isBest, gapCp: gap, cpl, sacrificed });
    counts[mover][label]++;

    const acc = approxAccuracyFromCpl(cpl);
    if (mover === "w") accW.push(acc);
    else accB.push(acc);

    // SAN for best move
    let bestSan = null;
    if (bestMoveUci) {
      try {
        const t = new ChessCtor(fenList[ply]);
        const mo = uciToMoveObj(bestMoveUci);
        const r = t.move(mo);
        bestSan = r?.san ?? bestMoveUci;
      } catch {
        bestSan = bestMoveUci;
      }
    }

    const note =
      isBest
        ? `Played best. CPL ${Math.round(cpl)}.`
        : `Best was ${bestSan || "?"}. CPL ${Math.round(cpl)}.`;

    plyInfo.push({
  plyAfter: ply + 1,
  color: mover,
  san: mv.san,
  label,
  cpl: Math.round(cpl)
});
}

  ui.analysisMoves.innerHTML = "";
  review.plyEls = new Map();

  function cellFor(p) {
    const cell = document.createElement("div");
    cell.className = "moveCell";

    if (!p) {
      cell.classList.add("empty");
      return cell;
    }

    const grade = badgeClass(p.label); // "brilliant", "good", etc.
    cell.classList.add(`grade-${grade}`);
    cell.dataset.ply = String(p.plyAfter);
    cell.title = `${p.label} • CPL ${p.cpl}`;

    cell.innerHTML = `
      <span class="san">${p.san}</span>
      <span class="cpl">CPL ${p.cpl}</span>
    `;

    cell.addEventListener("click", () => setReviewPly(p.plyAfter));

    review.plyEls.set(p.plyAfter, cell);
    return cell;
  }

  for (let i = 0; i < plyInfo.length; i += 2) {
    const moveNo = i / 2 + 1;

    const row = document.createElement("div");
    row.className = "analysisRow";

    const num = document.createElement("div");
    num.className = "moveNum";
    num.textContent = `${moveNo}.`;

    const whiteMove = plyInfo[i] && plyInfo[i].color === "w" ? plyInfo[i] : null;
    const blackMove = plyInfo[i + 1] && plyInfo[i + 1].color === "b" ? plyInfo[i + 1] : null;

    row.appendChild(num);
    row.appendChild(cellFor(whiteMove));
    row.appendChild(cellFor(blackMove));

    ui.analysisMoves.appendChild(row);
  }

  // summary
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);
  const aW = avg(accW);
  const aB = avg(accB);

  ui.analysisSummary.innerHTML = `
    <div><strong>Accuracy</strong>: White ${aW}% • Black ${aB}%</div>
    <div class="muted" style="margin-top:6px">
      accuracy labels are heuristic, based on engine eval loss + “only-move” gaps + sacrifice detection.
    </div>
    <div class="muted" style="margin-top:6px">
      White: Brilliant ${counts.w.Brilliant}, Great ${counts.w.Great}, Best ${counts.w.Best}, Blunders ${counts.w.Blunder}
      <br/>
      Black: Brilliant ${counts.b.Brilliant}, Great ${counts.b.Great}, Best ${counts.b.Best}, Blunders ${counts.b.Blunder}
    </div>
  `;

  // store review for nav
  review.fenList = fenList;
  review.posEval = posEval;
  review.currentPly = 0;

  // navigation buttons
  ui.navStart.onclick = () => setReviewPly(0);
  ui.navPrev.onclick = () => setReviewPly(review.currentPly - 1);
  ui.navNext.onclick = () => setReviewPly(review.currentPly + 1);
  ui.navEnd.onclick = () => setReviewPly(fenList.length - 1);

  setReviewPly(0);

  setStatus("Game analyzed.", "Click moves to jump through the review.");

  if (autoSavePrompt) {
    const wantSave = confirm("Save this game (locally in your browser)?");
    if (wantSave) {
      saveCurrentGame({ analysis: { aW, aB, counts }, fenList, pgn: chess.pgn(), result: gameResultString() });
      renderSavedGames();
      alert("Saved!");
    }
  }
  } finally {
    isAnalysisRunning = false;
  }
}

// ===== Saving games =====
function loadSavedGames() {
  return loadJSON(LS_SAVED, []);
}

function saveSavedGames(list) {
  saveJSON(LS_SAVED, list);
}

function saveCurrentGame({ analysis, fenList, pgn, result }) {
  const saved = loadSavedGames();
  const now = new Date();
  const id = `${now.getTime()}-${Math.random().toString(16).slice(2)}`;

  saved.unshift({
    id,
    savedAt: now.toISOString(),
    result,
    userEloAtSave: profile.userElo,
    engineEloAtSave: engineTargetElo,
    pgn,
    analysis,
    fenList
  });

  saveSavedGames(saved);
}

function downloadText(filename, content) {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function renderSavedGames() {
  const saved = loadSavedGames();
  ui.savedList.innerHTML = "";

  if (!saved.length) {
    ui.savedList.innerHTML = `<div class="muted">No saved games yet.</div>`;
    return;
  }

  for (const g of saved) {
    const card = document.createElement("div");
    card.className = "savedCard";

    const dt = new Date(g.savedAt);
    const title = `${g.result} • ${dt.toLocaleString()}`;
    const meta = `You ${g.userEloAtSave} vs Engine ${g.engineEloAtSave}`;

    card.innerHTML = `
      <div class="savedTop">
        <div>
          <div class="savedTitle">${title}</div>
          <div class="savedMeta">${meta}</div>
        </div>
      </div>
      <div class="savedBtns">
        <button class="secondary" data-action="load">Load</button>
        <button class="secondary" data-action="pgn">Download PGN</button>
        <button class="danger" data-action="delete">Delete</button>
      </div>
    `;

    card.querySelector('[data-action="load"]').onclick = () => loadSavedGame(g);
    card.querySelector('[data-action="pgn"]').onclick = () => downloadText(`game-${g.id}.pgn`, g.pgn);
    card.querySelector('[data-action="delete"]').onclick = () => {
      const next = loadSavedGames().filter((x) => x.id !== g.id);
      saveSavedGames(next);
      renderSavedGames();
    };

    ui.savedList.appendChild(card);
  }
}

function loadSavedGame(g) {
  // Load PGN into chess.js and show final position + analysis cards
  chess.reset();
  chess.load_pgn(g.pgn);

  board.setPosition(chess.fen());
  rebuildMovesUIFromHistory();


  setTab("analysis");

  // Render stored analysis summary if available; otherwise prompt to re-analyze.
  if (g.analysis && g.fenList) {
    ui.analysisSummary.innerHTML = `
      <div><strong>Accuracy</strong>: White ${g.analysis.aW}% • Black ${g.analysis.aB}%</div>
      <div class="muted" style="margin-top:6px">
        Loaded from saved analysis.
      </div>
    `;

    // We don’t store every per-move grade in this minimal save format.
    // If you want full graded move cards when loading, just re-run analysis.
    ui.analysisMoves.innerHTML = `
      <div class="muted">
        To see full move-by-move grades again, click <strong>Analyze</strong>.
      </div>
    `;

    const tempEval = [];
    // We don't store eval list; draw a flat graph:
    for (let i = 0; i < g.fenList.length; i++) tempEval.push(0);
    drawEvalGraph(tempEval);

    review.fenList = g.fenList;
    review.currentPly = 0;
    ui.navStart.onclick = () => setReviewPly(0);
    ui.navPrev.onclick = () => setReviewPly(review.currentPly - 1);
    ui.navNext.onclick = () => setReviewPly(review.currentPly + 1);
    ui.navEnd.onclick = () => setReviewPly(g.fenList.length - 1);
    setReviewPly(g.fenList.length - 1);

    setStatus("Loaded saved game.", "Press Analyze for full move grading.");
  } else {
    const ok = confirm("Saved game has no detailed analysis stored. Analyze now?");
    if (ok) runAnalysisAndRender({ autoSavePrompt: false });
  }
}

// ===== Gameplay loop =====
async function engineMoveIfNeeded() {
  if (mode !== "play") return;
  if (isGameFinished) return;
  if (isEngineThinking) return;
  if (chess.turn() !== "b") return; // engine is Black in this simple version

  isEngineThinking = true;
  setStatus("Engine thinking…", "");
  await sleep(5000);


  try {
    const res = await engine.analyzePosition(chess.fen(), {
  depth: PLAY_SELECT_DEPTH,
  multiPV: PLAY_SELECT_MULTIPV
});
    const bm = pickHumanEngineMove(res, "b", engineHuman);
    if (!bm || bm === "(none)") return;

    const mo = uciToMoveObj(bm);
    const moved = chess.move(mo);
    if (!moved) return;

    board.setPosition(chess.fen());
    rebuildMovesUIFromHistory();

    playViewPly = chess.history().length; // <-- critical: after engine move

    if (isGameOver()) {
      await finishGameFlow();
    } else {
      setStatus("Your turn.", "");
    }
  } catch (err) {
    console.error(err);
    setStatus("Engine error.", "Try New game.");
  } finally {
    isEngineThinking = false;
  }
}

async function finishGameFlow() {
  isGameFinished = true;
  ui.resignBtn.disabled = true;
  ui.analyzeBtn.disabled = false;

  const result = gameResultString();
  setStatus("Game over.", `Result: ${result}`);

  // Update Elo estimate (user is White)
  const score = userScoreFromResult(result);
  const before = profile.userElo;
  const after = updateElo(profile.userElo, engineTargetElo, score, profile.gamesPlayed);

  profile.userElo = after;
  profile.gamesPlayed += 1;
  saveJSON(LS_PROFILE, profile);

  // Next engine target
  engineTargetElo = profile.userElo + TARGET_ELO_OFFSET;
  renderRatings();

  ui.statusSub.textContent = `Your Elo: ${before} → ${after} (estimate). Click Analyze for review.`;
}

function setupBoard() {
  const container = document.getElementById("board");
  container.innerHTML = "";

  board = new Chessboard(container, {
    position: chess.fen(),
    assetsUrl: ASSETS_URL,
    extensions: [{ class: Markers }, { class: PromotionDialog }, { class: Arrows }]
    
  });

  // Enable move input (you are White)
  board.enableMoveInput((event) => {
  // Block input while engine thinks in play mode, or while heavy analysis is running
  if (mode === "play") {
    if (isGameFinished || isEngineThinking) return false;
    const live = chess.history().length;
    if (playViewPly !== live) return false; // can't play moves while reviewing old positions
  } else {
    if (isAnalysisRunning) return false;
  }

  const game = getActiveGame();
  if (!game) return false;

  switch (event.type) {
    case INPUT_EVENT_TYPE.moveInputStarted: {
      const piece = game.get(event.squareFrom);
      if (!piece) return false;

      if (mode === "play") {
        // You are always White during normal play
        if (piece.color !== "w") return false;
        if (game.turn() !== "w") return false;
      } else {
        // In analysis mode, you can play for either side (whichever is to move)
        if (piece.color !== game.turn()) return false;
      }

      const moves = game.moves({ square: event.squareFrom, verbose: true });
      if (!moves.length) return false;

      event.chessboard.addLegalMovesMarkers(moves);
      return true;
    }

    case INPUT_EVENT_TYPE.validateMoveInput: {
    event.chessboard.removeLegalMovesMarkers();

    const mv = makeMove(game, event.squareFrom, event.squareTo, event.promotion);
    if (!mv) return false;

    syncBoardToGame(game);

    if (mode === "play") {
      rebuildMovesUIFromHistory();

      // IMPORTANT: keep "live view" aligned with actual move count
      playViewPly = chess.history().length;

      if (isGameOver()) {
        finishGameFlow();
      } else {
        engineMoveIfNeeded();
      }

      return true;
    }

    // --- analysis mode ---
    updateAnalysisNavLabel();
    setStatus("Analysis mode.", "Play moves for either side from this position.");
    refreshBestMoveArrow();
    scheduleEvalBarUpdate();

    return true;
  }

    case INPUT_EVENT_TYPE.moveInputCanceled:
      event.chessboard.removeLegalMovesMarkers();
      return true;

    default:
      return true;
  }
})};

async function startNewGame() {
  isGameFinished = false;
  isEngineThinking = false;

  engineHuman = {
    targetAcc: sampleTargetEngineAccuracy(),
    accList: []
  };

  chess = new ChessCtor();

  setupBoard();
  clearMovesUI();

  ui.resignBtn.disabled = false;
  ui.analyzeBtn.disabled = true;

  // compute and set engine strength
  engineTargetElo = profile.userElo + TARGET_ELO_OFFSET;
  renderRatings();

  setStatus("Starting new game…", `Engine target: ~${engineTargetElo}`);

  await engine.newGame();
  await engine.setStrength(engineTargetElo);

  setStatus("Your turn.", "Tap a piece to see legal moves.");
}

// ===== Wire UI =====
function wireUI() {
  ui.tabBtns.forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

  if (ui.bestMoveToggle) {
  ui.bestMoveToggle.checked = !!showBestMoveArrow;

  ui.bestMoveToggle.addEventListener("change", () => {
    showBestMoveArrow = ui.bestMoveToggle.checked;
    saveJSON(LS_SHOW_BESTMOVE, showBestMoveArrow);

    if (!showBestMoveArrow) clearBestMoveArrow();
    else refreshBestMoveArrow();
  });
}

  ui.savedTabBtn.onclick = () => {
    setTab("saved");
    renderSavedGames();
  };

  ui.newGameBtn.onclick = () => startNewGame();

  ui.resignBtn.onclick = async () => {
    if (isGameFinished) return;
    const ok = confirm("Resign this game?");
    if (!ok) return;

    isGameFinished = true;
    ui.resignBtn.disabled = true;
    ui.analyzeBtn.disabled = false;

    setStatus("You resigned.", "Result: 0-1");
    // Elo update as a loss
    const before = profile.userElo;
    const after = updateElo(profile.userElo, engineTargetElo, 0, profile.gamesPlayed);

    profile.userElo = after;
    profile.gamesPlayed += 1;
    saveJSON(LS_PROFILE, profile);

    engineTargetElo = profile.userElo + TARGET_ELO_OFFSET;
    renderRatings();

    ui.statusSub.textContent = `Your Elo: ${before} → ${after} (estimate). Click Analyze for review.`;
  };

  ui.analyzeBtn.onclick = () => runAnalysisAndRender({ autoSavePrompt: true });

  ui.exportPgnBtn.onclick = () => {
    const saved = loadSavedGames();
    const all = saved.map((g) => g.pgn.trim()).join("\n\n");
    downloadText(`saved-games.pgn`, all || "");
  };

  ui.clearSavedBtn.onclick = () => {
    const ok = confirm("Delete all saved games from this browser?");
    if (!ok) return;
    saveSavedGames([]);
    renderSavedGames();
  };

  document.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  if (isTypingInInput()) return;

  // --- Analysis navigation ---
  if (mode === "analysis") {
    if (isAnalysisRunning) return;
    e.preventDefault();

    if (e.key === "ArrowLeft") setReviewPly(review.currentPly - 1);
    else setReviewPly(review.currentPly + 1);

    return;
  }

  // --- Playing navigation ---
  if (!chess || !board) return;
  e.preventDefault();

  const total = chess.history().length;

  // keep view sane if something changed
  if (!Number.isFinite(playViewPly)) playViewPly = total;

  if (e.key === "ArrowLeft") {
    if (playViewPly > 0) setPlayViewPly(playViewPly - 1);
  } else {
    if (playViewPly < total) setPlayViewPly(playViewPly + 1);
  }
});
}

// ===== Boot =====
async function main() {
  wireUI();
  renderSavedGames();

  renderRatings();
  setStatus("Loading engine…", "First load may take a moment (engine downloads once, then caches).");

  try {
    engine = new StockfishClient(ENGINE_WORKER_URL);
    await engine.init();

    setStatus("Engine ready.", "Click New game to start.");
    ui.newGameBtn.disabled = false;

    // Create board once engine is ready
    chess = new ChessCtor();
    setupBoard();
    board.setPosition(chess.fen());

    // auto-start a game
    await startNewGame();
  } catch (e) {
    console.error(e);
    setStatus("Failed to load engine.", "Make sure you run via a local server / GitHub Pages (not file://).");
  }
}

main();
