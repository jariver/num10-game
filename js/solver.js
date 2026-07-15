/*
 * Solver for the "数字消除" (sum-to-10 elimination) puzzle.
 * Direct JS port of app/solver.py -- keep logic identical.
 *
 * Rules:
 *  - A clearable rectangle can be ANY axis-aligned rectangular block of
 *    cells (any height, any width), as long as the sum of its cell
 *    values equals exactly 10.
 *  - Already-cleared cells (0 on the board) from PREVIOUS rounds are
 *    ordinary values and can be included in new rectangles.
 *  - Within one round, cells claimed by an earlier rectangle in the
 *    SAME round can never be reused by another rectangle in that round
 *    (no overlap), even if treating them as 0 would make some other
 *    sum equal 10.
 *  - Scan top-left corners in row-major order; for each unclaimed
 *    anchor cell, pick the smallest-area valid rectangle anchored
 *    there, claim it immediately, and continue.
 *  - Repeat rounds until a full pass finds nothing to clear.
 */

function findClearableRectsOnePass(board) {
  const rows = board.length;
  const cols = rows ? board[0].length : 0;
  const claimed = Array.from({ length: rows }, () => new Array(cols).fill(false));
  const found = [];

  function bestRectAt(r0, c0) {
    const poisoned = new Array(cols).fill(false);
    const colSum = new Array(cols).fill(0);
    let best = null; // {area, r1, c1}
    for (let r1 = r0; r1 < rows; r1++) {
      for (let c = c0; c < cols; c++) {
        if (poisoned[c]) continue;
        if (claimed[r1][c]) {
          poisoned[c] = true;
          continue;
        }
        colSum[c] += board[r1][c];
      }
      let running = 0;
      for (let c1 = c0; c1 < cols; c1++) {
        if (poisoned[c1]) break;
        running += colSum[c1];
        if (running === 10) {
          const area = (r1 - r0 + 1) * (c1 - c0 + 1);
          if (best === null || area < best.area) {
            best = { area, r1, c1 };
          }
          break;
        }
        if (running > 10) break;
      }
    }
    if (best === null) return null;
    return [r0, c0, best.r1 - r0 + 1, best.c1 - c0 + 1];
  }

  for (let r0 = 0; r0 < rows; r0++) {
    for (let c0 = 0; c0 < cols; c0++) {
      if (claimed[r0][c0]) continue;
      const rect = bestRectAt(r0, c0);
      if (rect) {
        const [rr0, cc0, rs, cs] = rect;
        for (let rr = rr0; rr < rr0 + rs; rr++) {
          for (let cc = cc0; cc < cc0 + cs; cc++) {
            claimed[rr][cc] = true;
          }
        }
        found.push(rect);
      }
    }
  }

  return found;
}

function applyClears(board, rects) {
  const newBoard = board.map((row) => row.slice());
  for (const [r0, c0, rs, cs] of rects) {
    for (let r = r0; r < r0 + rs; r++) {
      for (let c = c0; c < c0 + cs; c++) {
        newBoard[r][c] = 0;
      }
    }
  }
  return newBoard;
}

function solve(board, maxRounds = 200) {
  const rounds = [];
  let current = board.map((row) => row.slice());
  for (let roundNo = 1; roundNo <= maxRounds; roundNo++) {
    const rects = findClearableRectsOnePass(current);
    if (rects.length === 0) break;
    const after = applyClears(current, rects);
    rounds.push({
      round: roundNo,
      boardBefore: current.map((row) => row.slice()),
      boardAfter: after.map((row) => row.slice()),
      rects,
    });
    current = after;
  }
  return { rounds, finalBoard: current };
}

window.Num10Solver = { findClearableRectsOnePass, applyClears, solve };
