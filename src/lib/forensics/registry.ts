/**
 * Issuer registry (demo: stored on this device in IndexedDB).
 *
 * The issuer registers a genuine document once. Its "spatial fingerprint" is
 * page 1 normalised to a fixed width and cut into the shared grid; every cell
 * keeps a 4×4 block of mean brightness values. Any later copy is matched by a
 * perceptual hash, then compared cell by cell → an exact map of what changed,
 * plus the old/new text when both have a text layer.
 *
 * In production the fingerprint's Merkle root is what gets anchored on Polygon
 * (and can be printed in a QR) — the document then verifies itself offline.
 */

import type { Evidence, PageRender, TamperLayer, TextBox } from "./types";
import { TamperGrid } from "./types";

export const NORM_W = 960;
const SUB = 4; // 4×4 sub-blocks per cell

export interface Fingerprint {
  sha256: string;
  dhash: string;
  aspect: number;
  cols: number;
  rows: number;
  cells: Uint8Array; // cols*rows*SUB*SUB mean-brightness values
  text: { str: string; x: number; y: number; w: number; h: number }[]; // normalised 0..1, one entry per word
  textSource: "pdf" | "ocr" | "none";
}

export interface RegisteredOriginal extends Fingerprint {
  id: string;
  name: string;
  issuer: string;
  registeredAt: string;
  pageThumb: string | null;
}

async function sha256Hex(bytes: Uint8Array) {
  const h = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Split positioned strings into positioned words (proportional width). */
function toWords(boxes: TextBox[], W: number, H: number) {
  const out: Fingerprint["text"] = [];
  for (const b of boxes) {
    const len = Math.max(1, b.str.length);
    for (const m of b.str.matchAll(/\S+/g)) {
      const off = m.index ?? 0;
      out.push({ str: m[0], x: (b.x + (b.w * off) / len) / W, y: b.y / H, w: (b.w * m[0].length) / len / W, h: b.h / H });
    }
  }
  return out.slice(0, 3000);
}

export async function makeFingerprint(bytes: Uint8Array, render: PageRender, textBoxes: TextBox[], cols = 48): Promise<Fingerprint> {
  const W = NORM_W;
  const H = Math.round((render.height / render.width) * W);
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(render.canvas, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const lum = new Float32Array(W * H);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) lum[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

  const g = new TamperGrid(W, H, cols);
  const cells = new Uint8Array(g.cols * g.rows * SUB * SUB);
  for (let r = 0; r < g.rows; r++) {
    for (let cc = 0; cc < g.cols; cc++) {
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const x0 = Math.floor(cc * g.cellW + (sx * g.cellW) / SUB), x1 = Math.floor(cc * g.cellW + ((sx + 1) * g.cellW) / SUB);
          const y0 = Math.floor(r * g.cellH + (sy * g.cellH) / SUB), y1 = Math.floor(r * g.cellH + ((sy + 1) * g.cellH) / SUB);
          let s = 0, n = 0;
          for (let y = y0; y < Math.max(y0 + 1, y1); y++) for (let x = x0; x < Math.max(x0 + 1, x1); x++) { s += lum[Math.min(H - 1, y) * W + Math.min(W - 1, x)]; n++; }
          cells[((r * g.cols + cc) * SUB + sy) * SUB + sx] = Math.round(s / n);
        }
      }
    }
  }

  // 64-bit difference hash of a 9×8 thumbnail
  const t = document.createElement("canvas");
  t.width = 9;
  t.height = 8;
  const tctx = t.getContext("2d", { willReadFrequently: true })!;
  tctx.drawImage(c, 0, 0, 9, 8);
  const td = tctx.getImageData(0, 0, 9, 8).data;
  let bits = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const a = td[(y * 9 + x) * 4], b = td[(y * 9 + x + 1) * 4];
    bits += a > b ? "1" : "0";
  }
  let dhash = "";
  for (let i = 0; i < 64; i += 4) dhash += parseInt(bits.slice(i, i + 4), 2).toString(16);

  return {
    sha256: await sha256Hex(bytes),
    dhash,
    aspect: render.width / render.height,
    cols: g.cols,
    rows: g.rows,
    cells,
    text: toWords(textBoxes, render.width, render.height),
    textSource: textBoxes.length ? textBoxes[0].source : "none",
  };
}

// ── IndexedDB ──
const DB = "verichain-registry";
const STORE = "originals";
const RECORDS = "records";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listOriginals(): Promise<RegisteredOriginal[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as RegisteredOriginal[]);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function registerOriginal(entry: RegisteredOriginal) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearRegistry() {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Analysis records — what the /verify/[id] page shows on this device. */
export interface AnalysisRecord {
  id: string;
  fileName: string;
  verdict: string;
  verdictTitle: string;
  summary: string;
  sha256: string | null;
  merkleRoot: string | null;
  changes: { before: string; after: string; field?: string }[];
  createdAt: string;
  network?: string;
  txHash?: string;
}

export async function saveRecord(rec: AnalysisRecord) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(RECORDS, "readwrite");
    tx.objectStore(RECORDS).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getRecord(id: string): Promise<AnalysisRecord | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(RECORDS, "readonly").objectStore(RECORDS).get(id);
      req.onsuccess = () => resolve((req.result as AnalysisRecord) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

function hamming(a: string, b: string) {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

export interface RegistryMatch {
  original: RegisteredOriginal;
  exact: boolean;
  changedCells: number;
  textChanges: number;
  differs: boolean;
}

/** Compare a fingerprint with every registered original; returns evidence and a change layer. */
export async function compareWithRegistry(
  fp: Fingerprint,
  grid: TamperGrid,
  opts: { photo: boolean } = { photo: false }
): Promise<{ evidence: Evidence[]; layers: TamperLayer[]; match: RegistryMatch | null }> {
  const evidence: Evidence[] = [];
  const layers: TamperLayer[] = [];
  const originals = await listOriginals();
  if (!originals.length) return { evidence, layers, match: null };

  const sameGrid = fp.cols === grid.cols && fp.rows === grid.rows;
  const exact = originals.find((o) => o.sha256 === fp.sha256);
  if (exact) {
    evidence.push({
      id: "reg-exact",
      category: "registry",
      severity: "pass",
      title: "Identical to the registered original",
      detail: `Byte-for-byte the same file that ${exact.issuer} registered on ${new Date(exact.registeredAt).toLocaleString()} ("${exact.name}").`,
    });
    return { evidence, layers, match: { original: exact, exact: true, changedCells: 0, textChanges: 0, differs: false } };
  }

  const candidates = originals
    .filter((o) => Math.abs(o.aspect - fp.aspect) < 0.03 && o.cols === fp.cols && o.rows === fp.rows)
    .map((o) => ({ o, d: hamming(o.dhash, fp.dhash) }))
    .sort((a, b) => a.d - b.d);
  const best = candidates[0];
  if (!best || best.d > 12) return { evidence, layers, match: null };
  const o = best.o;

  if (opts.photo) {
    // A photo never lines up pixel-for-pixel with the issuer's file (perspective, light, lens).
    evidence.push({
      id: "reg-photo",
      category: "registry",
      severity: "info",
      title: `Looks like registered original "${o.name}"`,
      detail: `This photo resembles a document registered by ${o.issuer}, but photos can't be compared cell by cell. Ask for the digital copy to verify it against the original.`,
    });
    return { evidence, layers, match: null };
  }
  const sameSource = o.textSource === fp.textSource;

  // cell-by-cell comparison — thresholds adapt to systematic rendering differences
  // (a PNG export vs the issuer's PDF never matches pixel-for-pixel everywhere)
  const g = TamperGrid.like(grid);
  const n = SUB * SUB;
  const total = fp.cols * fp.rows;
  const meanD = new Float32Array(total), maxD = new Float32Array(total);
  for (let k = 0; k < total; k++) {
    let diff = 0, maxd = 0;
    for (let i = 0; i < n; i++) {
      const dd = Math.abs(fp.cells[k * n + i] - o.cells[k * n + i]);
      diff += dd;
      if (dd > maxd) maxd = dd;
    }
    meanD[k] = diff / n;
    maxD[k] = maxd;
  }
  const med = (a: Float32Array) => { const s2 = Array.from(a).sort((x, y) => x - y); return s2[s2.length >> 1] ?? 0; };
  const mMean = med(meanD), mMax = med(maxD);
  const madMean = med(meanD.map((v) => Math.abs(v - mMean))) * 1.4826, madMax = med(maxD.map((v) => Math.abs(v - mMax))) * 1.4826;
  // same kind of file (PDF vs PDF): strict. Different renderers (PNG export vs PDF): conservative.
  const tMean = sameSource ? Math.max(5, mMean + 8 * madMean) : Math.max(14, mMean + 10 * madMean);
  const tMax = sameSource ? Math.max(26, mMax + 8 * madMax) : Math.max(70, mMax + 10 * madMax);
  let changed = 0;
  for (let k = 0; k < total; k++) {
    const hit = sameSource ? meanD[k] > tMean || maxD[k] > tMax : meanD[k] > tMean && maxD[k] > tMax;
    if (hit) {
      g.data[k] = Math.min(1, 0.6 + meanD[k] / 40);
      changed++;
    }
  }
  // isolated single cells after an adaptive threshold are usually rendering noise
  const blobs = g.regions(0.5, 1);
  if (mMean > 1.5 || !sameSource) {
    for (const r of blobs) {
      const cells = Math.round((r.w * g.width) / g.cellW) * Math.round((r.h * g.height) / g.cellH);
      if (cells <= 1) {
        const c0 = Math.round((r.x * g.width) / g.cellW), r0 = Math.round((r.y * g.height) / g.cellH);
        if (r0 < g.rows && c0 < g.cols) g.data[r0 * g.cols + c0] = 0;
      }
    }
    changed = Array.from(g.data).filter((v) => v >= 0.5).length;
  }

  // text changes (both have a text layer)
  const changes: { before: string; after: string; x: number; y: number; w: number; h: number }[] = [];
  // only compare text extracted the same way — OCR words vs a PDF text layer would invent changes
  if (o.text.length && fp.text.length && o.textSource === fp.textSource) {
    const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.008;
    for (const t of fp.text) {
      if (o.text.some((ot) => ot.str === t.str && near(ot, t))) continue;
      const was = o.text.find((ot) => Math.abs(ot.y - t.y) < 0.01 && Math.min(ot.x + ot.w, t.x + t.w) - Math.max(ot.x, t.x) > Math.min(ot.w, t.w) * 0.4);
      if (was && was.str !== t.str) changes.push({ before: was.str, after: t.str, x: t.x, y: t.y, w: t.w, h: t.h });
    }
  }

  if (changed === 0 && !changes.length) {
    evidence.push({
      id: "reg-visual",
      category: "registry",
      severity: "pass",
      title: "Same content as the registered original",
      detail: `The file bytes differ (re-saved or re-exported), but page 1 matches "${o.name}" registered by ${o.issuer} cell for cell.`,
    });
    return { evidence, layers, match: { original: o, exact: false, changedCells: 0, textChanges: 0, differs: false } };
  }

  if (sameGrid) layers.push({
    id: "registry",
    label: "vs registered original",
    color: "#FF00E5",
    description: `Cells that differ from "${o.name}" registered by ${o.issuer}`,
    grid: g.data,
    critical: true,
    strength: g.max(),
  });
  const regs = g.regions(0.5).slice(0, 10);
  for (const c of changes.slice(0, 8)) {
    evidence.push({
      id: `reg-chg-${evidence.length}`,
      category: "registry",
      severity: "critical",
      title: "Differs from the registered original",
      detail: `The issuer's original says "${c.before}", this copy says "${c.after}".`,
      regions: [{ x: c.x, y: c.y, w: c.w, h: c.h, label: `${c.before} → ${c.after}` }],
      layerId: "registry",
      change: { before: c.before, after: c.after },
    });
  }
  if (!changes.length) {
    evidence.push({
      id: "reg-diff",
      category: "registry",
      severity: "critical",
      title: "Differs from the registered original",
      detail: `Compared cell by cell with "${o.name}" (registered by ${o.issuer}), ${regs.length} area(s) of page 1 are different.`,
      regions: regs.map((r) => ({ ...r, label: "changed vs original" })),
      layerId: "registry",
    });
  }
  return { evidence, layers, match: { original: o, exact: false, changedCells: changed, textChanges: changes.length, differs: true } };
}

/**
 * Spatial Merkle root: one leaf per grid row (SHA-256 of that row's cell values).
 * Changing any cell changes exactly one leaf, so a Merkle proof points at the row.
 * This root is what an issuer would anchor on Polygon / print in a QR.
 */
export async function spatialMerkleRoot(fp: Fingerprint): Promise<string> {
  const rowBytes = fp.cols * SUB * SUB;
  let level: Uint8Array[] = [];
  for (let r = 0; r < fp.rows; r++) {
    const h = await crypto.subtle.digest("SHA-256", fp.cells.slice(r * rowBytes, (r + 1) * rowBytes) as BufferSource);
    level.push(new Uint8Array(h));
  }
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i], b = level[i + 1] ?? level[i];
      const both = new Uint8Array(64);
      both.set(a, 0);
      both.set(b, 32);
      next.push(new Uint8Array(await crypto.subtle.digest("SHA-256", both)));
    }
    level = next;
  }
  return Array.from(level[0] ?? new Uint8Array(32)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
