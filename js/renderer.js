/*
 * Renderer module: draws annotated per-round images on <canvas>, matching
 * the visual style of app/renderer.py (colored boxes around each
 * cleared group, faded cells for already-cleared regions).
 */

const PALETTE = [
  'rgb(255,100,0)',
  'rgb(60,60,255)',
  'rgb(255,220,0)',
  'rgb(230,0,0)',
  'rgb(200,0,255)',
  'rgb(0,140,255)',
  'rgb(255,60,60)',
  'rgb(140,0,200)',
];

function cloneCanvas(srcCanvas) {
  const canvas = document.createElement('canvas');
  canvas.width = srcCanvas.width;
  canvas.height = srcCanvas.height;
  canvas.getContext('2d').drawImage(srcCanvas, 0, 0);
  return canvas;
}

function fadeCell(ctx, box) {
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = 'rgb(235,235,235)';
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.restore();
}

function renderRound(baseCanvas, cellBoxes, rectsThisRound, clearedBefore, roundNo) {
  const canvas = cloneCanvas(baseCanvas);
  const ctx = canvas.getContext('2d');
  const rows = cellBoxes.length;
  const cols = rows ? cellBoxes[0].length : 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (clearedBefore[r][c]) fadeCell(ctx, cellBoxes[r][c]);
    }
  }

  rectsThisRound.forEach(([r0, c0, rs, cs], i) => {
    const color = PALETTE[i % PALETTE.length];
    const boxTL = cellBoxes[r0][c0];
    const boxBR = cellBoxes[r0 + rs - 1][c0 + cs - 1];
    const x0 = boxTL.x - 6;
    const y0 = boxTL.y - 6;
    const x1 = boxBR.x + boxBR.w + 6;
    const y1 = boxBR.y + boxBR.h + 6;

    ctx.save();
    ctx.globalAlpha = 0.30;
    ctx.fillStyle = color;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.restore();

    ctx.save();
    ctx.lineWidth = 6;
    ctx.strokeStyle = color;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
  });

  if (roundNo != null) {
    drawLabel(ctx, `Round ${roundNo}`);
  }

  return canvas;
}

function renderBoardState(baseCanvas, cellBoxes, clearedMask, label) {
  const canvas = cloneCanvas(baseCanvas);
  const ctx = canvas.getContext('2d');
  const rows = cellBoxes.length;
  const cols = rows ? cellBoxes[0].length : 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (clearedMask[r][c]) fadeCell(ctx, cellBoxes[r][c]);
    }
  }
  if (label) drawLabel(ctx, label);
  return canvas;
}

function drawLabel(ctx, text) {
  ctx.save();
  ctx.font = 'bold 34px sans-serif';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(20,20,20,0.9)';
  ctx.strokeText(text, 30, 55);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, 30, 55);
  ctx.restore();
}

function renderAllRounds(baseCanvas, detection, rounds) {
  const { cellBoxes, rows, cols } = detection;
  let clearedMask = Array.from({ length: rows }, () => new Array(cols).fill(false));
  const images = [];

  for (const rd of rounds) {
    const before = clearedMask.map((row) => row.slice());
    const canvas = renderRound(baseCanvas, cellBoxes, rd.rects, before, rd.round);
    images.push({ round: rd.round, canvas, rects: rd.rects });
    for (const [r0, c0, rs, cs] of rd.rects) {
      for (let r = r0; r < r0 + rs; r++) {
        for (let c = c0; c < c0 + cs; c++) clearedMask[r][c] = true;
      }
    }
  }

  const finalCanvas = renderBoardState(baseCanvas, cellBoxes, clearedMask, 'Final (no more moves)');
  images.push({ round: null, canvas: finalCanvas, rects: [] });
  return images;
}

window.Num10Renderer = { renderRound, renderBoardState, renderAllRounds };
