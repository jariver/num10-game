/*
 * OCR module: wraps Tesseract.js to recognize a single digit (1-9) per
 * cell, matching the behavior of app/grid_detect.py's ocr_digit().
 *
 * Uses a single persistent worker (created once, reused for every cell)
 * to avoid the overhead of spinning up a new worker per cell.
 */

let workerPromise = null;

function getWorker(onLog) {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('eng', 1, {
      workerPath: 'vendor/worker.min.js',
      corePath: 'vendor',
      langPath: 'vendor',
      gzip: true,
      cacheMethod: 'none',
      workerBlobURL: false,
      logger: onLog || (() => {}),
    }).then(async (worker) => {
      await worker.setParameters({
        tessedit_char_whitelist: '123456789',
        tessedit_pageseg_mode: '10',
      });
      return worker;
    });
  }
  return workerPromise;
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
      const { digit, confident } = await ocrDigit(cellCanvas);
      grid[r][c] = digit;
      confidence[r][c] = confident;
      done++;
      if (onProgress) onProgress(done, total);
    }
  }
  return { grid, confidence };
}

window.Num10OCR = { getWorker, ocrDigit, ocrGrid };
