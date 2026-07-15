/*
 * Grid detection module (pure Canvas/JS port of app/grid_detect.py).
 *
 * Given an <img> or <canvas> of the number-elimination board, finds the
 * board region (green background), detects white tile rectangles inside
 * it, clusters them into rows/columns, and returns per-cell pixel boxes
 * ready for OCR + rendering. No OpenCV dependency -- uses hand-rolled
 * thresholding + flood-fill connected components on raw pixel data.
 */

function loadImageToCanvas(imgEl) {
  const canvas = document.createElement('canvas');
  canvas.width = imgEl.naturalWidth || imgEl.width;
  canvas.height = imgEl.naturalHeight || imgEl.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  const v = max;
  // Match OpenCV's HSV ranges: H in [0,180), S,V in [0,255]
  return [h / 2, s * 255, v * 255];
}

function findConnectedComponents(mask, width, height) {
  const visited = new Uint8Array(width * height);
  const components = [];
  const stack = new Int32Array(width * height);

  for (let start = 0; start < width * height; start++) {
    if (mask[start] === 0 || visited[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    let minX = width, minY = height, maxX = -1, maxY = -1, area = 0;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % width;
      const y = (idx / width) | 0;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbors = [
        [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1],
      ];
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const nIdx = ny * width + nx;
        if (mask[nIdx] && !visited[nIdx]) {
          visited[nIdx] = 1;
          stack[sp++] = nIdx;
        }
      }
    }
    components.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area });
  }
  return components;
}

function morphClose(mask, width, height, radius) {
  // Dilate then erode with a square structuring element of the given
  // radius, approximating cv2.morphologyEx MORPH_CLOSE.
  function dilate(src) {
    const dst = new Uint8Array(src.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let v = 0;
        for (let dy = -radius; dy <= radius && !v; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            if (src[ny * width + nx]) { v = 1; break; }
          }
        }
        dst[y * width + x] = v;
      }
    }
    return dst;
  }
  function erode(src) {
    const dst = new Uint8Array(src.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let v = 1;
        for (let dy = -radius; dy <= radius && v; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) { v = 0; break; }
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) { v = 0; break; }
            if (!src[ny * width + nx]) { v = 0; break; }
          }
        }
        dst[y * width + x] = v;
      }
    }
    return dst;
  }
  return erode(dilate(mask));
}

function findBoardBBox(canvas, minAreaRatio = 0.05) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, w, h);
  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const [hh, s, v] = rgbToHsv(data[i], data[i + 1], data[i + 2]);
    if (hh >= 45 && hh <= 90 && s >= 80 && s <= 255 && v >= 15 && v <= 210) {
      mask[p] = 1;
    }
  }
  const closed = morphClose(mask, w, h, 7);
  const components = findConnectedComponents(closed, w, h);
  if (!components.length) return null;
  components.sort((a, b) => b.area - a.area);
  const best = components[0];
  if (best.area < minAreaRatio * w * h) return null;
  return best;
}

function detectTileBoxes(canvas, region) {
  const { x: rx, y: ry, w: rw, h: rh } = region;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data } = ctx.getImageData(rx, ry, rw, rh);
  const gray = new Uint8ClampedArray(rw * rh);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }

  const threshCandidates = [195, 175, 210, 150];
  let bestBoxes = [];
  for (const thresh of threshCandidates) {
    const mask = new Uint8Array(rw * rh);
    for (let p = 0; p < gray.length; p++) mask[p] = gray[p] >= thresh ? 1 : 0;
    const components = findConnectedComponents(mask, rw, rh);
    const cand = [];
    for (const c of components) {
      const area = c.w * c.h;
      if (area < 1000) continue;
      const ar = c.w / c.h;
      if (!(ar > 0.6 && ar < 1.6)) continue;
      if (!(c.w > 30 && c.w < 260 && c.h > 30 && c.h < 260)) continue;
      cand.push({ x: c.x + rx, y: c.y + ry, w: c.w, h: c.h });
    }
    if (cand.length >= 20) { bestBoxes = cand; break; }
    if (cand.length > bestBoxes.length) bestBoxes = cand;
  }
  return bestBoxes;
}

function clusterValues(vals, tol) {
  const sorted = vals.slice().sort((a, b) => a - b);
  if (!sorted.length) return [];
  const clusters = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const v = sorted[i];
    const last = clusters[clusters.length - 1];
    if (v - last[last.length - 1] < tol) last.push(v);
    else clusters.push([v]);
  }
  return clusters.map((c) => c.reduce((a, b) => a + b, 0) / c.length);
}

function fillGaps(centers) {
  if (centers.length < 2) return centers;
  const diffs = [];
  for (let i = 1; i < centers.length; i++) diffs.push(centers[i] - centers[i - 1]);
  diffs.sort((a, b) => a - b);
  const step = diffs[Math.floor(diffs.length / 2)];
  const filled = [centers[0]];
  for (let i = 1; i < centers.length; i++) {
    const v = centers[i];
    while (v - filled[filled.length - 1] > step * 1.5) {
      filled.push(filled[filled.length - 1] + step);
    }
    filled.push(v);
  }
  return filled;
}

function inferGridGeometry(boxes, tol = 30) {
  if (!boxes.length) throw new Error('No tile-like boxes detected in the image.');
  const centers = boxes.map((b) => ({ cx: b.x + b.w / 2, cy: b.y + b.h / 2 }));
  const ws = boxes.map((b) => b.w).sort((a, b) => a - b);
  const hs = boxes.map((b) => b.h).sort((a, b) => a - b);
  const medW = ws[Math.floor(ws.length / 2)];
  const medH = hs[Math.floor(hs.length / 2)];

  let colCenters = clusterValues(centers.map((c) => c.cx), tol).sort((a, b) => a - b);
  let rowCenters = clusterValues(centers.map((c) => c.cy), tol).sort((a, b) => a - b);
  colCenters = fillGaps(colCenters);
  rowCenters = fillGaps(rowCenters);

  return { rowCenters, colCenters, medW, medH };
}

function detectGrid(canvas, { halfWRatio = 0.42, halfHRatio = 0.42 } = {}) {
  const w = canvas.width, h = canvas.height;
  let region = findBoardBBox(canvas);
  if (!region) region = { x: 0, y: 0, w, h };

  const boxes = detectTileBoxes(canvas, region);
  const { rowCenters, colCenters, medW, medH } = inferGridGeometry(boxes);

  const rows = rowCenters.length;
  const cols = colCenters.length;
  const halfW = medW * halfWRatio;
  const halfH = medH * halfHRatio;

  const cellBoxes = [];
  for (let r = 0; r < rows; r++) {
    const rowBoxes = [];
    const cy = rowCenters[r];
    for (let c = 0; c < cols; c++) {
      const cx = colCenters[c];
      let x0 = Math.max(0, Math.round(cx - halfW));
      let y0 = Math.max(0, Math.round(cy - halfH));
      let x1 = Math.min(w, Math.round(cx + halfW));
      let y1 = Math.min(h, Math.round(cy + halfH));
      rowBoxes.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    cellBoxes.push(rowBoxes);
  }

  return { rows, cols, cellBoxes, imageWidth: w, imageHeight: h };
}

window.Num10GridDetect = { loadImageToCanvas, detectGrid, findBoardBBox, detectTileBoxes };
