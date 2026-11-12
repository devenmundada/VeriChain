/**
 * Pixel-level self-consistency checks — the document compared with itself.
 *
 *  - Noise map: every part of a photo/scan carries the same sensor/paper noise.
 *    A pasted or whited-out patch is "too clean" (or noisier) than its neighbours.
 *  - Compression map (JPEG only): Error Level Analysis, normalised by edge
 *    density so normal text edges don't light up.
 *  - Background steps (digital images): flat areas whose colour is almost —
 *    but not exactly — the colour next to them (a white box on off-white paper,
 *    a patch pasted from another export).
 *  - Background boost: a visual layer that exaggerates tiny shade differences.
 */

import { type CheckRun, type Evidence, type TamperLayer, TamperGrid } from "./types";

export interface PixelStats {
  mean: number;
  stdDev: number;
  entropy: number;
  uniqueColors: number;
  noiseLevel: number;
}

export interface ImageAnalysis {
  evidence: Evidence[];
  layers: TamperLayer[];
  checks: CheckRun[];
  stats: PixelStats;
  elaDataUrl: string | null;
  photoLike: boolean;
}

function median(arr: number[]) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mad(arr: number[], med: number) {
  return median(arr.map((v) => Math.abs(v - med)));
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export async function analyzePixels(
  canvas: HTMLCanvasElement,
  grid: TamperGrid,
  opts: { isJpeg: boolean; fromRender: boolean; exclude?: { x: number; y: number; w: number; h: number }[] }
): Promise<ImageAnalysis> {
  // Embedded pictures / QR codes legitimately have their own background and grain.
  const exclude = (opts.exclude ?? []).map((r) => ({ x: r.x - 6, y: r.y - 6, w: r.w + 12, h: r.h + 12 }));
  const excluded = (x: number, y: number, w: number, h: number) =>
    exclude.some((r) => {
      const ix = Math.max(0, Math.min(x + w, r.x + r.w) - Math.max(x, r.x));
      const iy = Math.max(0, Math.min(y + h, r.y + r.h) - Math.max(y, r.y));
      return ix * iy > w * h * 0.3;
    });
  const evidence: Evidence[] = [];
  const layers: TamperLayer[] = [];
  const checks: CheckRun[] = [];
  let eid = 0;
  const ev = (e: Omit<Evidence, "id">) => evidence.push({ id: `px-${eid++}`, ...e });

  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const N = W * H;
  const lum = new Float32Array(N);
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    lum[j] = v;
    sum += v;
    hist[Math.round(v)]++;
  }
  const mean = sum / N;
  let varSum = 0;
  for (let j = 0; j < N; j += 7) varSum += (lum[j] - mean) ** 2;
  const stdDev = Math.sqrt(varSum / Math.ceil(N / 7));
  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    if (hist[i]) {
      const p = hist[i] / N;
      entropy -= p * Math.log2(p);
    }
  }
  let colorCount = 0;
  {
    const seen = new Set<number>();
    for (let i = 0; i < d.length && seen.size < 200000; i += 4 * 13) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    colorCount = seen.size;
  }

  // ── per-cell accumulators ──
  const C = grid.cols, R = grid.rows, cells = C * R;
  const edgeSum = new Float32Array(cells);
  const noiseSum = new Float32Array(cells);
  const flatCount = new Float32Array(cells);
  const pixCount = new Float32Array(cells);
  const stepCount = new Float32Array(cells);
  const bgVals: number[][] = Array.from({ length: cells }, () => []);
  let globalNoise = 0, globalFlat = 0;
  // finer grid just for the noise map — white-outs and pasted digits are small
  const FS = Math.max(8, Math.round(Math.min(W, H) / 110));
  const FC = Math.ceil(W / FS), FR = Math.ceil(H / FS), fcells = FC * FR;
  const fNoise = new Float32Array(fcells), fFlat = new Float32Array(fcells), fPix = new Float32Array(fcells), fEdge = new Float32Array(fcells), fLum = new Float32Array(fcells);

  const cellOf = (x: number, y: number) =>
    Math.min(R - 1, Math.floor(y / grid.cellH)) * C + Math.min(C - 1, Math.floor(x / grid.cellW));

  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const c = lum[i];
      const n = lum[i - W], s = lum[i + W], e = lum[i + 1], w = lum[i - 1];
      const grad = Math.abs(e - w) + Math.abs(s - n);
      const k = cellOf(x, y);
      edgeSum[k] += grad;
      pixCount[k]++;
      const fk = ((y / FS) | 0) * FC + ((x / FS) | 0);
      fEdge[fk] += grad;
      fLum[fk] += c;
      fPix[fk]++;
      if (grad < 10) {
        const lap = Math.abs(4 * c - n - s - e - w) / 4;
        noiseSum[k] += lap;
        flatCount[k]++;
        fNoise[fk] += lap;
        fFlat[fk]++;
        globalNoise += lap;
        globalFlat++;
        if ((x & 3) === 0 && (y & 3) === 0) bgVals[k].push(c);
        // micro-step: flat on both sides, tiny non-zero jump between
        if (x > 2 && x < W - 3) {
          const a1 = lum[i - 2], a0 = lum[i - 1], b0 = lum[i + 1], b1 = lum[i + 2];
          const left = Math.abs(a1 - a0) < 0.6 && Math.abs(a0 - c) < 0.6;
          const right = Math.abs(b0 - b1) < 0.6;
          const step = Math.abs(b0 - c);
          if (left && right && step >= 0.9 && step <= 5) stepCount[k]++;
        }
      }
    }
  }
  const noiseMedianGlobal = globalFlat ? globalNoise / globalFlat : 0;
  // Photos and scans carry grain in flat areas; clean digital exports don't.
  const photoLike = noiseMedianGlobal > 0.6;

  // ── Noise map (fine grid) ──
  const noiseGrid = TamperGrid.like(grid);
  const fineFlag = new Float32Array(fcells);
  const noiseItems: { k: number; edge: number; noise: number }[] = [];
  for (let k = 0; k < fcells; k++) {
    const meanLum = fLum[k] / Math.max(1, fPix[k]);
    // skip blown-out glare / pure black: clipped pixels carry no grain in genuine photos either
    if (fPix[k] > 0 && fFlat[k] / fPix[k] > 0.3 && fFlat[k] > FS * 2 && meanLum < 247 && meanLum > 8) {
      noiseItems.push({ k, edge: fEdge[k] / fPix[k], noise: fNoise[k] / fFlat[k] });
    }
  }
  let noiseFlags = 0;
  if (photoLike && noiseItems.length > 60) {
    // (a) cleaner than its own neighbourhood: white-out / digits pasted from a clean source
    const valid = new Float32Array(fcells).fill(-1);
    for (const it of noiseItems) valid[it.k] = it.noise;
    const R = 4;
    for (const it of noiseItems) {
      const r0 = (it.k / FC) | 0, c0 = it.k % FC;
      const ring: number[] = [];
      for (let r = r0 - R; r <= r0 + R; r++) {
        if (r < 0 || r >= FR) continue;
        for (let c = c0 - R; c <= c0 + R; c++) {
          if (c < 0 || c >= FC || (Math.abs(r - r0) <= 1 && Math.abs(c - c0) <= 1)) continue;
          const v = valid[r * FC + c];
          if (v >= 0) ring.push(v);
        }
      }
      if (ring.length < 20) continue;
      const local = median(ring);
      if (local > 1.2 && it.noise < local * 0.45) fineFlag[it.k] = Math.min(1, 0.6 + (1 - it.noise / local) * 0.4);
    }
    // (b) far noisier than cells with the same amount of detail
    noiseItems.sort((a, b) => a.edge - b.edge);
    const bins = 6;
    for (let bIdx = 0; bIdx < bins; bIdx++) {
      const slice = noiseItems.slice(Math.floor((noiseItems.length * bIdx) / bins), Math.floor((noiseItems.length * (bIdx + 1)) / bins));
      if (slice.length < 10) continue;
      const vals = slice.map((s) => s.noise);
      const med = median(vals);
      const spread = 1.4826 * mad(vals, med) + 0.05;
      for (const s of slice) {
        const z = (s.noise - med) / spread;
        if (z > 6) fineFlag[s.k] = Math.max(fineFlag[s.k], Math.min(1, 0.5 + z / 24));
      }
    }
    // connected blobs of ≥3 fine cells, not huge
    const seen = new Uint8Array(fcells);
    const blobs: { x0: number; y0: number; x1: number; y1: number; n: number; v: number }[] = [];
    for (let i = 0; i < fcells; i++) {
      if (seen[i] || fineFlag[i] < 0.5) continue;
      const st = [i];
      seen[i] = 1;
      const bl = { x0: Infinity, y0: Infinity, x1: -1, y1: -1, n: 0, v: 0 };
      while (st.length) {
        const j = st.pop()!;
        const r = (j / FC) | 0, c = j % FC;
        bl.n++;
        bl.v = Math.max(bl.v, fineFlag[j]);
        bl.x0 = Math.min(bl.x0, c); bl.x1 = Math.max(bl.x1, c); bl.y0 = Math.min(bl.y0, r); bl.y1 = Math.max(bl.y1, r);
        for (const nb of [j - FC, j + FC, c > 0 ? j - 1 : -1, c < FC - 1 ? j + 1 : -1]) {
          if (nb >= 0 && nb < fcells && !seen[nb] && fineFlag[nb] >= 0.5) { seen[nb] = 1; st.push(nb); }
        }
      }
      if (bl.n >= 3 && bl.n < fcells * 0.04) blobs.push(bl);
    }
    blobs.sort((a, b) => b.n - a.n);
    for (const bl of blobs.filter((b) => !excluded(b.x0 * FS, b.y0 * FS, (b.x1 - b.x0 + 1) * FS, (b.y1 - b.y0 + 1) * FS)).slice(0, 6)) {
      const px = bl.x0 * FS, py = bl.y0 * FS, pw = (bl.x1 - bl.x0 + 1) * FS, ph = (bl.y1 - bl.y0 + 1) * FS;
      noiseGrid.markRect(px, py, pw, ph, bl.v);
      noiseFlags++;
      ev({
        category: "pixel",
        severity: "warning",
        title: "Area with different grain",
        detail:
          "This area's grain/noise doesn't match the paper around it. Whited-out boxes and digits pasted from a clean source are smoother than a real photo or scan.",
        regions: [{ x: px / W, y: py / H, w: pw / W, h: ph / H, label: "grain mismatch" }],
        layerId: "px-noise",
      });
    }
    if (noiseGrid.max() > 0) {
      layers.push({
        id: "px-noise",
        label: "Noise mismatch",
        color: "#00D4FF",
        description: "Areas whose grain/noise differs from the rest of the page",
        grid: noiseGrid.data,
        critical: false,
        strength: noiseGrid.max(),
      });
    }
    checks.push({ id: "px-noise", label: "Noise consistency", status: noiseFlags ? "flag" : "pass" });
  } else {
    checks.push({ id: "px-noise", label: "Noise consistency", status: "skip", note: photoLike ? "too small" : "clean digital image" });
  }

  // ── Background steps (digital images) ──
  const stepGrid = TamperGrid.like(grid);
  let stepFlags = 0;
  if (!photoLike) {
    const perim = (grid.cellW + grid.cellH) * 2;
    for (let k = 0; k < cells; k++) {
      if (stepCount[k] >= Math.max(4, perim * 0.12)) stepGrid.data[k] = Math.min(1, 0.55 + stepCount[k] / (perim * 2));
    }
    const regs = stepGrid.regions(0.5, 1).filter((r) => r.w < 0.6 && r.h < 0.6 && !excluded(r.x * W, r.y * H, r.w * W, r.h * H));
    const keepAll = stepGrid.data.slice();
    stepGrid.data.fill(0);
    for (const r of regs) {
      for (let k = 0; k < cells; k++) {
        const rr = Math.floor(k / C), cc = k % C;
        const cx = (cc + 0.5) * grid.cellW, cy = (rr + 0.5) * grid.cellH;
        if (cx >= r.x * W && cx <= (r.x + r.w) * W && cy >= r.y * H && cy <= (r.y + r.h) * H) stepGrid.data[k] = keepAll[k];
      }
    }
    for (const r of regs.slice(0, 6)) {
      stepFlags++;
      ev({
        category: "pixel",
        severity: "warning",
        title: "Patch of slightly different background",
        detail:
          "The background here is a shade off from the area around it — typical of a white box drawn over text, or a piece pasted in from another image.",
        regions: [{ ...r, label: "background patch" }],
        layerId: "px-bg",
      });
    }
    if (stepGrid.max() > 0) {
      layers.push({
        id: "px-bg",
        label: "Background patch",
        color: "#B4FF39",
        description: "Edges where the background colour changes by a tiny amount",
        grid: stepGrid.data,
        critical: false,
        strength: stepGrid.max(),
      });
    }
    checks.push({ id: "px-bg", label: "Background consistency", status: stepFlags ? "flag" : "pass" });
  }

  // ── Background boost (visual only) ──
  try {
    const lo = Math.max(0, percentile(hist, N, 0.92) - 28);
    const boost = ctx.createImageData(W, H);
    const b = boost.data;
    for (let j = 0, i = 0; j < N; j++, i += 4) {
      const v = lum[j];
      if (v < lo) {
        b[i] = b[i + 1] = b[i + 2] = 20;
      } else {
        const t = ((v - lo) * 9) % 256; // wrap so 1-level shade changes become visible bands
        const [r, g, bl] = rainbow(t / 255);
        b[i] = r;
        b[i + 1] = g;
        b[i + 2] = bl;
      }
      b[i + 3] = 255;
    }
    const bc = document.createElement("canvas");
    bc.width = W;
    bc.height = H;
    bc.getContext("2d")!.putImageData(boost, 0, 0);
    layers.push({
      id: "px-boost",
      label: "Background boost",
      color: "#9B59B6",
      description: "Exaggerates tiny shade differences so patches and white boxes become visible",
      overlayUrl: bc.toDataURL("image/jpeg", 0.85),
      critical: false,
      strength: 0,
    });
  } catch {
    /* ignore */
  }

  // ── ELA (JPEG only) ──
  let elaDataUrl: string | null = null;
  if (opts.isJpeg && !opts.fromRender) {
    const elaGrid = TamperGrid.like(grid);
    const recompressed = await loadImage(canvas.toDataURL("image/jpeg", 0.9));
    const rc = document.createElement("canvas");
    rc.width = W;
    rc.height = H;
    const rctx = rc.getContext("2d", { willReadFrequently: true })!;
    rctx.drawImage(recompressed, 0, 0);
    const rd = rctx.getImageData(0, 0, W, H).data;
    const elaImg = ctx.createImageData(W, H);
    const cellEla = new Float32Array(cells);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const diff = (Math.abs(d[i] - rd[i]) + Math.abs(d[i + 1] - rd[i + 1]) + Math.abs(d[i + 2] - rd[i + 2])) / 3;
      const x = j % W, y = (j / W) | 0;
      cellEla[cellOf(x, y)] += diff;
      const a = Math.min(255, diff * 18);
      elaImg.data[i] = a > 170 ? (a - 170) * 3 : 0;
      elaImg.data[i + 1] = a > 85 && a <= 170 ? (a - 85) * 3 : 0;
      elaImg.data[i + 2] = a <= 85 ? a * 3 : 0;
      elaImg.data[i + 3] = 200;
    }
    const ec = document.createElement("canvas");
    ec.width = W;
    ec.height = H;
    ec.getContext("2d")!.putImageData(elaImg, 0, 0);
    elaDataUrl = ec.toDataURL("image/png");

    // normalise by edge density: compare each cell only with cells of similar detail
    const items: { k: number; edge: number; ela: number }[] = [];
    for (let k = 0; k < cells; k++) {
      if (!pixCount[k]) continue;
      items.push({ k, edge: edgeSum[k] / pixCount[k], ela: cellEla[k] / pixCount[k] });
    }
    items.sort((a, b) => a.edge - b.edge);
    const bins = 8;
    let elaFlags = 0;
    for (let bIdx = 0; bIdx < bins; bIdx++) {
      const slice = items.slice(Math.floor((items.length * bIdx) / bins), Math.floor((items.length * (bIdx + 1)) / bins));
      if (slice.length < 8) continue;
      const vals = slice.map((s) => s.ela);
      const med = median(vals);
      const spread = 1.4826 * mad(vals, med) + 0.25;
      for (const s of slice) {
        const z = (s.ela - med) / spread;
        if (z > 4.5) elaGrid.data[s.k] = Math.min(1, 0.5 + z / 18);
      }
    }
    const regs = elaGrid.regions(0.5, 2);
    // drop isolated cells
    const filtered = TamperGrid.like(grid);
    for (const r of regs) {
      for (let k = 0; k < cells; k++) {
        const rr = Math.floor(k / C), cc = k % C;
        const cx = (cc + 0.5) * grid.cellW, cy = (rr + 0.5) * grid.cellH;
        if (cx >= r.x * W && cx <= (r.x + r.w) * W && cy >= r.y * H && cy <= (r.y + r.h) * H) filtered.data[k] = elaGrid.data[k];
      }
    }
    for (const r of regs.slice(0, 6)) {
      elaFlags++;
      ev({
        category: "pixel",
        severity: "warning",
        title: "Area compressed differently",
        detail:
          "This area reacts differently to JPEG re-compression than other areas with the same amount of detail — a sign it was pasted in or re-saved separately.",
        regions: [{ ...r, label: "compression mismatch" }],
        layerId: "px-ela",
      });
    }
    if (filtered.max() > 0) {
      layers.push({
        id: "px-ela",
        label: "Compression mismatch",
        color: "#FF6B35",
        description: "Error Level Analysis, compared only against areas with similar detail",
        grid: filtered.data,
        critical: false,
        strength: filtered.max(),
      });
    }
    checks.push({ id: "px-ela", label: "JPEG compression (ELA)", status: elaFlags ? "flag" : "pass" });
  } else {
    checks.push({ id: "px-ela", label: "JPEG compression (ELA)", status: "skip", note: "not a JPEG" });
  }

  return {
    evidence,
    layers,
    checks,
    stats: {
      mean: Math.round(mean * 100) / 100,
      stdDev: Math.round(stdDev * 100) / 100,
      entropy: Math.round(entropy * 100) / 100,
      uniqueColors: colorCount,
      noiseLevel: Math.round(noiseMedianGlobal * 100) / 100,
    },
    elaDataUrl,
    photoLike,
  };
}

function percentile(hist: Uint32Array, total: number, p: number) {
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= total * p) return i;
  }
  return 255;
}

function rainbow(t: number): [number, number, number] {
  const h = t * 300;
  const x = 1 - Math.abs(((h / 60) % 2) - 1);
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [1, x, 0];
  else if (h < 120) [r, g, b] = [x, 1, 0];
  else if (h < 180) [r, g, b] = [0, 1, x];
  else if (h < 240) [r, g, b] = [0, x, 1];
  else [r, g, b] = [x, 0, 1];
  return [r * 255, g * 255, b * 255];
}
