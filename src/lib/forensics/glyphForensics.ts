/**
 * Glyph consistency — every number compared with the text in its own row.
 *
 * On a genuine print, scan or photo, a row of a table was produced in one pass:
 * same ink darkness and colour, same edge sharpness, same height and baseline.
 * A digit typed or pasted in later usually differs from its row-mates in at
 * least one of these. Measurements use the real ink outline inside each OCR
 * box (table rules are ignored), and everything is relative to the row, so a
 * bold "Total" row or a large heading doesn't count as odd.
 */

import type { CheckRun, Evidence, TamperLayer } from "./types";
import { TamperGrid } from "./types";
import type { OcrWord } from "./ocr";

interface Feat {
  word: OcrWord;
  ok: boolean;
  inkLum: number;
  hue: number;
  sharp: number;
  top: number;
  bottom: number;
  height: number;
  isNum: boolean;
  tall: boolean; // has caps/digits/ascenders → comparable height to digits
  desc: boolean; // has descenders → bottom not comparable
}

function median(a: number[]) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mad(a: number[], m: number) {
  return median(a.map((v) => Math.abs(v - m)));
}

function otsu(hist: number[], total: number) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

export function analyzeGlyphs(canvas: HTMLCanvasElement, words: OcrWord[], grid: TamperGrid) {
  const evidence: Evidence[] = [];
  const layers: TamperLayer[] = [];
  const checks: CheckRun[] = [];
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, W, H).data;
  const lum = new Float32Array(W * H);
  for (let i = 0, j = 0; i < img.length; i += 4, j++) lum[j] = 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2];

  const measure = (w: OcrWord): Feat => {
    const base: Feat = { word: w, ok: false, inkLum: 0, hue: 0, sharp: 0, top: w.y, bottom: w.y + w.h, height: w.h, isNum: /^\d[\d.,/:-]*$/.test(w.str), tall: /[A-Z0-9bdfhklt]/.test(w.str), desc: /[gjpqy,;()]/.test(w.str) };
    const x0 = Math.max(1, Math.floor(w.x - 1)), x1 = Math.min(W - 2, Math.ceil(w.x + w.w + 1));
    const y0 = Math.max(1, Math.floor(w.y - 1)), y1 = Math.min(H - 2, Math.ceil(w.y + w.h + 1));
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (bw < 4 || bh < 6) return base;
    const hist = new Array(256).fill(0);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) hist[Math.round(lum[y * W + x])]++;
    const thr = otsu(hist, bw * bh);
    // rows that are almost entirely ink are table rules / underlines — ignore them
    const rowInk = new Array(bh).fill(0);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (lum[y * W + x] < thr) rowInk[y - y0]++;
    let top = -1, bottom = -1;
    for (let r = 0; r < bh; r++) {
      if (rowInk[r] > 0 && rowInk[r] < bw * 0.8) {
        if (top < 0) top = r;
        bottom = r;
      }
    }
    if (top < 0) return base;
    let inkSum = 0, inkN = 0, bgSum = 0, bgN = 0, r = 0, b = 0, gradSum = 0, gradN = 0;
    for (let y = y0 + top; y <= y0 + bottom; y++) {
      if (rowInk[y - y0] >= bw * 0.8) continue;
      for (let x = x0; x <= x1; x++) {
        const v = lum[y * W + x];
        if (v < thr) {
          inkSum += v; inkN++;
          const i = (y * W + x) * 4;
          r += img[i]; b += img[i + 2];
        } else { bgSum += v; bgN++; }
        const gm = Math.abs(lum[y * W + x + 1] - lum[y * W + x - 1]) + Math.abs(lum[(y + 1) * W + x] - lum[(y - 1) * W + x]);
        if (gm > 12) { gradSum += gm; gradN++; }
      }
    }
    if (inkN < 6 || bgN < 6) return base;
    const inkLum = inkSum / inkN;
    const contrast = Math.max(1, bgSum / bgN - inkLum);
    return {
      ...base,
      ok: true,
      inkLum,
      hue: b / inkN - r / inkN,
      sharp: gradN ? gradSum / gradN / contrast : 0,
      top: y0 + top,
      bottom: y0 + bottom,
      height: bottom - top + 1,
    };
  };

  const feats = words.filter((w) => w.confidence >= 50 && w.h >= 6).map(measure).filter((f) => f.ok);
  // rows by vertical centre
  const sorted = [...feats].sort((a, b) => a.top + a.height / 2 - (b.top + b.height / 2));
  const rows: Feat[][] = [];
  for (const f of sorted) {
    const yc = f.top + f.height / 2;
    const row = rows.find((rw) => Math.abs(rw[0].top + rw[0].height / 2 - yc) < Math.max(rw[0].height, f.height) * 0.6);
    if (row) row.push(f);
    else rows.push([f]);
  }

  interface Delta { f: Feat; ink: number; hue: number; sharp: number; hRatio: number; base: number; rowH: number }
  const deltas: Delta[] = [];
  for (const row of rows) {
    if (row.length < 3) continue;
    for (const f of row) {
      if (!f.isNum) continue;
      const others = row.filter((o) => o !== f);
      const tallOthers = others.filter((o) => o.tall);
      const baseOthers = others.filter((o) => !o.desc);
      if (tallOthers.length < 2 || baseOthers.length < 2) continue;
      const rowH = median(tallOthers.map((o) => o.height));
      deltas.push({
        f,
        ink: f.inkLum - median(others.map((o) => o.inkLum)),
        hue: f.hue - median(others.map((o) => o.hue)),
        sharp: f.sharp / Math.max(0.05, median(others.map((o) => o.sharp))),
        hRatio: f.height / Math.max(1, rowH),
        base: f.bottom - median(baseOthers.map((o) => o.bottom)),
        rowH,
      });
    }
  }

  if (deltas.length < 5) {
    checks.push({ id: "glyph", label: "Digit consistency", status: "skip", note: "too few numbers in table rows" });
    return { evidence, layers, checks };
  }

  const z = (vals: number[]) => {
    const m = median(vals);
    return { m, s: 1.4826 * mad(vals, m) };
  };
  const zi = z(deltas.map((d) => d.ink));
  const zh = z(deltas.map((d) => d.hue));
  const zs = z(deltas.map((d) => d.sharp));
  const zr = z(deltas.map((d) => d.hRatio));
  const zb = z(deltas.map((d) => d.base));

  const flagged: { d: Delta; reasons: string[]; strong: boolean }[] = [];
  for (const d of deltas) {
    const reasons: string[] = [];
    let inkLike = false;
    if (Math.abs(d.ink - zi.m) > Math.max(22, 5 * zi.s)) { reasons.push(d.ink < zi.m ? "has darker ink" : "has lighter ink"); inkLike = true; }
    if (Math.abs(d.hue - zh.m) > Math.max(18, 5 * zh.s)) { reasons.push("has a different ink colour"); inkLike = true; }
    if ((d.sharp > Math.max(1.45, zs.m + 5 * zs.s)) || (d.sharp < Math.min(0.6, zs.m - 5 * zs.s))) { reasons.push(d.sharp > zs.m ? "has sharper edges" : "has blurrier edges"); inkLike = true; }
    const bigSize = Math.abs(d.hRatio - zr.m) > Math.max(0.3, 6 * zr.s);
    const bigBase = Math.abs(d.base - zb.m) > Math.max(3.5, d.rowH * 0.25, 6 * zb.s);
    if (Math.abs(d.hRatio - zr.m) > Math.max(0.18, 5 * zr.s)) reasons.push(d.hRatio > zr.m ? "is larger" : "is smaller");
    if (Math.abs(d.base - zb.m) > Math.max(2.5, d.rowH * 0.14, 5 * zb.s)) reasons.push(d.base > zb.m ? "sits lower than the line" : "sits higher than the line");
    // Size or baseline alone is common in genuine rows that mix fonts (bold labels, headings, small
    // print). Ink, colour or sharpness differences — or a large size AND baseline shift — are not.
    if (reasons.length) flagged.push({ d, reasons, strong: inkLike || (bigSize && bigBase) || reasons.length >= 3 });
  }
  // Many "odd" numbers means a layout/print quirk, not an edit.
  const real = flagged.length <= Math.max(2, deltas.length * 0.15) ? flagged : [];

  const g = TamperGrid.like(grid);
  for (const { d, reasons, strong } of real) {
    const w = d.f.word;
    g.markRect(w.x, w.y, w.w, w.h, strong ? (reasons.length >= 2 ? 0.9 : 0.7) : 0.4);
    evidence.push({
      id: `glyph-${evidence.length}`,
      category: "glyph",
      severity: strong ? "warning" : "info",
      title: `"${w.str}" doesn't match its row`,
      detail: `Compared with the rest of its row, "${w.str}" ${reasons.join(", ")}. Numbers typed or pasted in later often differ like this.`,
      regions: [{ x: w.x / W, y: w.y / H, w: w.w / W, h: w.h / H, label: w.str }],
      layerId: "glyph",
    });
  }
  if (g.max() > 0) {
    layers.push({
      id: "glyph",
      label: "Digit shape/ink",
      color: "#FFD60A",
      description: "Numbers whose ink, sharpness, size or baseline differ from the rest of their row",
      grid: g.data,
      critical: false,
      strength: g.max(),
    });
  }
  checks.push({ id: "glyph", label: "Digit consistency", status: real.some((r) => r.strong) ? "flag" : "pass", note: `${deltas.length} numbers compared with their rows` });
  return { evidence, layers, checks };
}
