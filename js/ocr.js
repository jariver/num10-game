/*
 * OCR module: wraps Tesseract.js to recognize a single digit (1-9) per
 * cell, matching the behavior of app/grid_detect.py's ocr_digit().
 *
 * Uses a single persistent worker (created once, reused for every cell)
 * to avoid the overhead of spinning up a new worker per cell.
 *
 * Multi-source loading: GitHub Pages (*.github.io) is known to be
 * unreliable on some Chinese mobile carrier networks even though it
 * loads fine on WiFi/broadband -- the domain itself, not any specific
 * file, is the bottleneck. To route around this without requiring the
 * user to do anything, we race a small probe fetch between the local
 * (same-origin) path and a jsDelivr GitHub-mirror path, and use
 * whichever responds first as the source for the large engine files
 * (wasm core + language data). The worker SCRIPT itself must stay
 * same-origin (browsers disallow cross-origin classic Worker scripts,
 * unlike fetch/importScripts which do support cross-origin with CORS),
 * but it's tiny (~120KB) so that's not the bottleneck anyway.
 */

let workerPromise = null;
let lastLoggerStatus = null;
let chosenSource = null;

const SOURCE_STORAGE_KEY = 'num10-preferred-engine-source';

function getRepoInfo() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  if (!m) return null;
  const parts = location.pathname.split('/').filter(Boolean);
  if (!parts.length) return null;
  return { user: m[1], repo: parts[0] };
}

function buildCandidates() {
  const repoInfo = getRepoInfo();
  const candidates = [{ base: '', label: 'github-direct' }];
  if (repoInfo) {
    candidates.push({
      base: `https://cdn.jsdelivr.net/gh/${repoInfo.user}/${repoInfo.repo}@main`,
      label: 'jsdelivr-mirror',
    });
  }
  return candidates;
}

function raceBase(probePath, timeoutMs) {
  const candidates = buildCandidates();

  // If offline, skip the race entirely (both candidates would just time
  // out one-by-one, wasting the full timeoutMs for nothing) -- go
  // straight to same-origin so the Cache Storage entries populated by
  // the service worker on a previous online visit are used immediately,
  // regardless of which source originally supplied them.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return Promise.resolve(candidates[0]);
  }

  // If a source worked last time (recorded in localStorage from a prior
  // successful run), try it first with a short grace period before
  // falling back to a full race -- avoids re-probing every single page
  // load once we already know which network path is reliable for this
  // device/carrier.
  let preferred = null;
  try {
    const saved = localStorage.getItem(SOURCE_STORAGE_KEY);
    if (saved) preferred = candidates.find((c) => c.label === saved) || null;
  } catch (e) {}

  const ordered = preferred ? [preferred, ...candidates.filter((c) => c !== preferred)] : candidates;

  return new Promise((resolve) => {
    let settled = false;
    let remaining = ordered.length;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve(ordered[0]); }
    }, timeoutMs);
    ordered.forEach((c) => {
      const url = (c.base ? c.base + '/' : '') + probePath + '?_r=' + Math.random().toString(36).slice(2);
      fetch(url, { cache: 'no-store' }).then((res) => {
        if (res.ok && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(c);
        }
      }).catch(() => {}).finally(() => {
        remaining--;
        if (remaining === 0 && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(ordered[0]);
        }
      });
    });
  });
}

function getChosenSource() {
  return chosenSource;
}

function getWorker(onLog) {
  if (!workerPromise) {
    const logger = (m) => {
      lastLoggerStatus = m;
      if (onLog) onLog(m);
    };
    workerPromise = (async () => {
      const winner = await raceBase('manifest.json', 6000);
      chosenSource = winner.label;
      try { localStorage.setItem(SOURCE_STORAGE_KEY, winner.label); } catch (e) {}
      const engineBase = winner.base ? `${winner.base}/vendor` : 'vendor';

      const worker = await Tesseract.createWorker('eng', 1, {
        workerPath: 'vendor/worker.min.js',
        corePath: engineBase,
        langPath: engineBase,
        gzip: true,
        cacheMethod: 'none',
        workerBlobURL: false,
        logger,
        errorHandler: (err) => {
          lastLoggerStatus = { status: 'worker-error', message: (err && err.message) || String(err) };
        },
      });
      await worker.setParameters({
        tessedit_char_whitelist: '123456789',
        tessedit_pageseg_mode: '10',
      });
      return worker;
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

function getLastLoggerStatus() {
  return lastLoggerStatus;
}

function cellCanvasToBinary(cellCanvas) {
  // Resize to 80x80, Otsu-ish binarize, ensure dark digit on white bg,
  // add a white border -- mirrors ocr_digit() in the Python module.
  const size = 80;
  const resized = document.createElement('canvas');
  resized.width = size;
  resized.height = size;
  const rctx = resized.getContext('2d');
  rctx.imageSmoothingEnabled = true;
  rctx.drawImage(cellCanvas, 0, 0, size, size);

  const imgData = rctx.getImageData(0, 0, size, size);
  const gray = new Uint8ClampedArray(size * size);
  for (let i = 0, p = 0; i < imgData.data.length; i += 4, p++) {
    gray[p] = Math.round(
      0.299 * imgData.data[i] + 0.587 * imgData.data[i + 1] + 0.114 * imgData.data[i + 2]
    );
  }

  // Simple Otsu threshold implementation.
  const hist = new Array(256).fill(0);
  for (const g of gray) hist[g]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, maxVar = 0, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > maxVar) { maxVar = varBetween; threshold = t; }
  }

  let meanVal = 0;
  const binary = new Uint8ClampedArray(size * size);
  for (let p = 0; p < gray.length; p++) {
    binary[p] = gray[p] >= threshold ? 255 : 0;
    meanVal += binary[p];
  }
  meanVal /= binary.length;
  if (meanVal < 127) {
    for (let p = 0; p < binary.length; p++) binary[p] = 255 - binary[p];
  }

  const border = 16;
  const outSize = size + border * 2;
  const outCanvas = document.createElement('canvas');
  outCanvas.width = outSize;
  outCanvas.height = outSize;
  const octx = outCanvas.getContext('2d');
  octx.fillStyle = '#fff';
  octx.fillRect(0, 0, outSize, outSize);

  const outImgData = octx.getImageData(border, border, size, size);
  for (let p = 0; p < binary.length; p++) {
    outImgData.data[p * 4] = binary[p];
    outImgData.data[p * 4 + 1] = binary[p];
    outImgData.data[p * 4 + 2] = binary[p];
    outImgData.data[p * 4 + 3] = 255;
  }
  octx.putImageData(outImgData, border, border);
  return outCanvas;
}

async function ocrDigit(cellCanvas) {
  const worker = await getWorker();
  const processed = cellCanvasToBinary(cellCanvas);
  const { data } = await worker.recognize(processed);
  const text = (data.text || '').trim();
  const digits = text.replace(/[^1-9]/g, '');
  if (digits.length === 1) return { digit: parseInt(digits, 10), confident: true };
  if (digits.length > 1) return { digit: parseInt(digits[0], 10), confident: false };
  return { digit: 0, confident: false };
}

async function ocrGrid(canvas, detection, onProgress) {
  const { rows, cols, cellBoxes } = detection;
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(0));
  const confidence = Array.from({ length: rows }, () => new Array(cols).fill(false));
  const total = rows * cols;
  let done = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const box = cellBoxes[r][c];
      const cellCanvas = document.createElement('canvas');
      cellCanvas.width = box.w;
      cellCanvas.height = box.h;
      const cctx = cellCanvas.getContext('2d');
      cctx.drawImage(canvas, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
      let digit, confident;
      try {
        const result = await ocrDigit(cellCanvas);
        digit = result.digit;
        confident = result.confident;
      } catch (err) {
        const wrapped = new Error(`识别第 ${r + 1} 行第 ${c + 1} 列格子时失败：${err.message || err}`);
        wrapped.cause = err;
        wrapped.cell = { row: r, col: c };
        throw wrapped;
      }
      grid[r][c] = digit;
      confidence[r][c] = confident;
      done++;
      if (onProgress) onProgress(done, total);
    }
  }
  return { grid, confidence };
}

window.Num10OCR = { getWorker, ocrDigit, ocrGrid, getLastLoggerStatus, getChosenSource };
