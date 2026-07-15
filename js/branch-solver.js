/*
 * "Smallest-weight-first branching search" solver -- JS port of
 * app/branch_solver.py, kept structurally identical so both versions
 * stay easy to cross-check. See the Python docstrings for the full
 * rationale; short version:
 *
 *  - A clearable rectangle's "weight" = count of NONZERO cells inside
 *    it (not geometric area -- already-cleared 0 cells are free
 *    padding and cost nothing to include).
 *  - At every step, only look at the CURRENTLY smallest-weight
 *    candidates. Any that don't share a nonzero cell with another
 *    same-tier candidate are "forced" (applied immediately, no
 *    choice). Any that DO conflict form a branch point -- recurse on
 *    each choice and keep the best.
 *  - Two candidates covering the exact same set of nonzero cells are
 *    the same logical move even if their bounding boxes differ (they
 *    can span different numbers of already-zero filler cells) --
 *    dedupe by that nonzero-cell-set signature, not by geometry, or
 *    the branch fan-out is 10-30x larger than the real number of
 *    distinct choices (confirmed empirically on real boards).
 *  - This uses no external solver library, pure recursion + a memo
 *    Map, which is why it can be ported to the browser at all (the
 *    earlier ILP-based approach needed PuLP/CBC and could not).
 */

function allCandidatesWithWeight(board) {
  // Returns [r0, c0, r1, c1, weight] for every rect summing to 10.
  // Monotonic early-exit scan: cell values are non-negative (0-9), so
  // the running sum can only grow as c1 increases -- break the moment
  // it EXCEEDS 10. Do NOT break as soon as it EQUALS 10: the rect can
  // keep growing across zero cells while staying at exactly 10 (e.g.
  // row [.., 6, 4, 0, 0] sums to 10 at three different c1 values), and
  // those are distinct valid candidates (same weight, different
  // geometry) that the dedup step needs to see.
  const rows = board.length;
  const cols = rows ? board[0].length : 0;
  const out = [];
  for (let r0 = 0; r0 < rows; r0++) {
    const colSum = new Array(cols).fill(0);
    const colNz = new Array(cols).fill(0);
    for (let r1 = r0; r1 < rows; r1++) {
      const row = board[r1];
      for (let c = 0; c < cols; c++) {
        const v = row[c];
        if (v) {
          colSum[c] += v;
          colNz[c] += 1;
        }
      }
      for (let c0 = 0; c0 < cols; c0++) {
        let running = 0;
        let runningNz = 0;
        for (let c1 = c0; c1 < cols; c1++) {
          running += colSum[c1];
          if (running > 10) break;
          runningNz += colNz[c1];
          if (running === 10 && runningNz > 0) {
            out.push([r0, c0, r1, c1, runningNz]);
          }
        }
      }
    }
  }
  return out;
}

function nonzeroCellsOf(cand, board) {
  // Frozenset-equivalent: a sorted array used as a Set/Map key via
  // join(). The set of cells inside `cand` that are currently nonzero.
  const [r0, c0, r1, c1] = cand;
  const cells = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (board[r][c] !== 0) cells.push(r * 1000 + c);
    }
  }
  cells.sort((a, b) => a - b);
  return cells;
}

function cellsSignature(cells) {
  return cells.join(',');
}

function dedupeByNonzeroCells(candidates, board) {
  const bestBySignature = new Map();
  for (const cand of candidates) {
    const cells = nonzeroCellsOf(cand, board);
    const sig = cellsSignature(cells);
    const [r0, c0, r1, c1] = cand;
    const area = (r1 - r0 + 1) * (c1 - c0 + 1);
    const prev = bestBySignature.get(sig);
    if (!prev || area < prev.area) {
      bestBySignature.set(sig, { cand, area });
    }
  }
  return Array.from(bestBySignature.values()).map((v) => v.cand);
}

function applyMany(board, rects) {
  // Only rows actually touched by a rect get copied; untouched rows
  // keep the same array reference as the input board (copy-on-write),
  // avoiding a full deep clone of the whole grid on every move.
  if (!rects.length) return board;
  const touchedRows = new Set();
  for (const rect of rects) {
    const [r0, , r1] = rect;
    for (let r = r0; r <= r1; r++) touchedRows.add(r);
  }
  const b = board.map((row, i) => (touchedRows.has(i) ? row.slice() : row));
  for (const rect of rects) {
    const [r0, c0, r1, c1] = rect;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) b[r][c] = 0;
    }
  }
  return b;
}

function boardKey(board) {
  // A plain joined string is both fast to compute and a good Map key
  // in JS engines (string interning/hashing is well optimized).
  let s = '';
  for (const row of board) s += row.join(',') + ';';
  return s;
}

class SearchState {
  constructor(timeBudgetMs, nodeLimit) {
    this.memo = new Map();
    this.deadline = Date.now() + timeBudgetMs;
    this.nodeCount = 0;
    this.nodeLimit = nodeLimit;
    this.timedOut = false;
  }
}

function greedyRolloutValue(board) {
  // Fast fallback used when the time/node budget runs out mid-search:
  // play the plain greedy algorithm to completion and count NEWLY
  // cleared cells (not geometric area -- see the weight comment above,
  // same correctness pitfall applies here).
  let b = board.map((row) => row.slice());
  let total = 0;
  for (let i = 0; i < 300; i++) {
    const rects = window.Num10Solver.findClearableRectsOnePass(b);
    if (!rects.length) break;
    for (const [r0, c0, rs, cs] of rects) {
      for (let r = r0; r < r0 + rs; r++) {
        for (let c = c0; c < c0 + cs; c++) {
          if (b[r][c] !== 0) total += 1;
        }
      }
      for (let r = r0; r < r0 + rs; r++) {
        for (let c = c0; c < c0 + cs; c++) b[r][c] = 0;
      }
    }
  }
  return total;
}

function buildConflictGraph(tier, board) {
  const cellOwner = new Map();
  tier.forEach((cand, i) => {
    for (const cell of nonzeroCellsOf(cand, board)) {
      if (!cellOwner.has(cell)) cellOwner.set(cell, []);
      cellOwner.get(cell).push(i);
    }
  });
  const n = tier.length;
  const adj = Array.from({ length: n }, () => new Set());
  for (const idxs of cellOwner.values()) {
    if (idxs.length > 1) {
      for (const a of idxs) {
        for (const b of idxs) {
          if (a !== b) adj[a].add(b);
        }
      }
    }
  }
  const seen = new Array(n).fill(false);
  const forced = [];
  let conflictComponent = null;
  for (let i = 0; i < n; i++) {
    if (seen[i]) continue;
    const comp = [i];
    seen[i] = true;
    const stack = [i];
    while (stack.length) {
      const cur = stack.pop();
      for (const nb of adj[cur]) {
        if (!seen[nb]) {
          seen[nb] = true;
          comp.push(nb);
          stack.push(nb);
        }
      }
    }
    if (comp.length === 1) {
      forced.push(tier[comp[0]]);
    } else if (conflictComponent === null) {
      conflictComponent = comp;
    }
  }
  return { forced, conflictComponent };
}

function searchValue(board, state) {
  const key = boardKey(board);
  const cached = state.memo.get(key);
  if (cached !== undefined) return cached;

  state.nodeCount += 1;
  if (state.nodeCount > state.nodeLimit || Date.now() > state.deadline) {
    state.timedOut = true;
    const val = greedyRolloutValue(board);
    state.memo.set(key, val);
    return val;
  }

  let candidates = allCandidatesWithWeight(board);
  if (!candidates.length) {
    state.memo.set(key, 0);
    return 0;
  }
  candidates = dedupeByNonzeroCells(candidates, board);

  const minW = Math.min(...candidates.map((c) => c[4]));
  const tier = candidates.filter((c) => c[4] === minW);

  const { forced, conflictComponent } = buildConflictGraph(tier, board);

  if (conflictComponent === null) {
    const newBoard = applyMany(board, forced);
    const gained = forced.reduce((s, c) => s + c[4], 0);
    const val = gained + searchValue(newBoard, state);
    state.memo.set(key, val);
    return val;
  }

  const baseBoard = applyMany(board, forced);
  const baseGain = forced.reduce((s, c) => s + c[4], 0);

  let best = -1;
  for (const idx of conflictComponent) {
    const cand = tier[idx];
    const branchBoard = applyMany(baseBoard, [cand]);
    const val = baseGain + cand[4] + searchValue(branchBoard, state);
    if (val > best) best = val;
  }
  state.memo.set(key, best);
  return best;
}

function reconstructMoveSequence(board, state, maxMoves) {
  const moves = [];
  let cur = board.map((row) => row.slice());
  for (let iter = 0; iter < maxMoves; iter++) {
    let candidates = allCandidatesWithWeight(cur);
    if (!candidates.length) break;
    candidates = dedupeByNonzeroCells(candidates, cur);
    const minW = Math.min(...candidates.map((c) => c[4]));
    const tier = candidates.filter((c) => c[4] === minW);

    const { forced, conflictComponent } = buildConflictGraph(tier, cur);

    for (const cand of forced) moves.push(cand.slice(0, 4));
    cur = applyMany(cur, forced);

    if (conflictComponent === null) continue;

    let bestIdx = null;
    let bestVal = -1;
    for (const idx of conflictComponent) {
      const cand = tier[idx];
      const branchBoard = applyMany(cur, [cand]);
      const key = boardKey(branchBoard);
      let future = state.memo.get(key);
      if (future === undefined) future = greedyRolloutValue(branchBoard);
      const val = cand[4] + future;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = idx;
      }
    }
    const chosen = tier[bestIdx];
    moves.push(chosen.slice(0, 4));
    cur = applyMany(cur, [chosen]);
  }
  return moves;
}

function groupIntoRounds(board, moves) {
  const rounds = [];
  let roundBoard = board.map((row) => row.slice());
  let currentRects = [];
  let usedCells = new Set();

  function sumAgainst(b, r0, c0, r1, c1) {
    let s = 0;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) s += b[r][c];
    }
    return s;
  }

  function flush() {
    if (currentRects.length) {
      rounds.push({
        boardBefore: roundBoard.map((row) => row.slice()),
        rects: currentRects.map(([r0, c0, r1, c1]) => [r0, c0, r1 - r0 + 1, c1 - c0 + 1]),
      });
      for (const [r0, c0, r1, c1] of currentRects) {
        for (let r = r0; r <= r1; r++) {
          for (let c = c0; c <= c1; c++) roundBoard[r][c] = 0;
        }
      }
    }
    currentRects = [];
    usedCells = new Set();
  }

  for (const rect of moves) {
    const [r0, c0, r1, c1] = rect;
    const cells = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) cells.push(r * 1000 + c);
    }
    const overlaps = cells.some((cell) => usedCells.has(cell));
    let validSum = sumAgainst(roundBoard, r0, c0, r1, c1) === 10;
    if (overlaps || !validSum) {
      flush();
      validSum = sumAgainst(roundBoard, r0, c0, r1, c1) === 10;
      if (!validSum) {
        throw new Error('reconstructed move invalid even in a fresh round -- bug in move sequence');
      }
    }
    currentRects.push(rect);
    for (const cell of cells) usedCells.add(cell);
  }
  flush();

  const out = [];
  for (let i = 0; i < rounds.length; i++) {
    const rd = rounds[i];
    const after = rd.boardBefore.map((row) => row.slice());
    for (const [r0, c0, rs, cs] of rd.rects) {
      for (let r = r0; r < r0 + rs; r++) {
        for (let c = c0; c < c0 + cs; c++) after[r][c] = 0;
      }
    }
    out.push({ round: i + 1, boardBefore: rd.boardBefore, boardAfter: after, rects: rd.rects });
  }
  const finalBoard = out.length ? out[out.length - 1].boardAfter : board.map((row) => row.slice());
  return { rounds: out, finalBoard };
}

function solveBranching(board, opts) {
  const timeBudgetMs = (opts && opts.timeBudgetMs) || 8000;
  const nodeLimit = (opts && opts.nodeLimit) || 400000;

  const state = new SearchState(timeBudgetMs, nodeLimit);
  const bestTotal = searchValue(board, state);
  const moves = reconstructMoveSequence(board, state, 5000);
  const { rounds, finalBoard } = groupIntoRounds(board, moves);

  const totalCells = board.reduce((s, row) => s + row.length, 0);
  let remainingNonzero = 0;
  for (const row of finalBoard) {
    for (const v of row) {
      if (v !== 0) remainingNonzero++;
    }
  }
  const actualCleared = totalCells - remainingNonzero;

  const info = {
    timedOut: state.timedOut,
    nodeCount: state.nodeCount,
    predictedTotalCleared: bestTotal,
    actualTotalCleared: actualCleared,
    totalCells,
  };
  return { rounds, finalBoard, info };
}

window.Num10BranchSolver = {
  solveBranching,
  allCandidatesWithWeight,
  dedupeByNonzeroCells,
  applyMany,
  boardKey,
};
