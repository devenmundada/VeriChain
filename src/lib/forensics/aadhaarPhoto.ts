/**
 * Printed photo vs the photo signed inside the Aadhaar Secure QR (browser only).
 *
 * The QR photo is a small JPEG 2000 image. It is decoded with pdf.js' own JPEG 2000 decoder
 * (OpenJPEG, bundled with pdfjs-dist — no network), then compared with the printed photo.
 */

import { getPdfJs } from "./pdfForensics";
import { matchPhotos, resize, toGray, type Gray, type PhotoMatch } from "./photoMatch";
import type { TextBox } from "./types";
import { buildLines } from "./textLines";
import { normName, similarity } from "./aadhaar";

function canvasGray(canvas: HTMLCanvasElement, r: { x: number; y: number; w: number; h: number }): Gray | null {
  const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
  const w = Math.min(canvas.width - x, Math.ceil(r.w)), h = Math.min(canvas.height - y, Math.ceil(r.h));
  if (w < 12 || h < 12) return null;
  const d = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(x, y, w, h);
  return toGray(d.data, w, h, 4);
}

/** Width/height from the J2K SIZ marker (FF 51). */
function j2kSize(b: Uint8Array): { w: number; h: number } | null {
  for (let i = 0; i + 20 < b.length; i++) {
    if (b[i] === 0xff && b[i + 1] === 0x51) {
      const u32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
      const xs = u32(i + 6), ys = u32(i + 10), xo = u32(i + 14), yo = u32(i + 18);
      if (xs > xo && ys > yo && xs - xo < 4000 && ys - yo < 4000) return { w: xs - xo, h: ys - yo };
      return null;
    }
  }
  return null;
}

async function decodeWithImageDecoders(j2k: Uint8Array): Promise<Gray | null> {
  const mod = await import("pdfjs-dist/image_decoders/pdf.image_decoders.mjs");
  const size = j2kSize(j2k);
  if (!size) return null;
  const out = mod.JpxImage.decode(j2k, {});
  const ch = Math.round(out.length / (size.w * size.h));
  if (ch < 1 || ch > 4) return null;
  return toGray(out, size.w, size.h, ch);
}

/** Fallback: wrap the J2K stream in a one-image PDF and let pdf.js (its worker) render it. */
async function decodeWithPdf(j2k: Uint8Array): Promise<Gray | null> {
  const size = j2kSize(j2k);
  if (!size) return null;
  const { w, h } = size;
  const enc = new TextEncoder();
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  const parts: (Uint8Array | string)[] = [
    "%PDF-1.5\n",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n",
    `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${w} ${h}]/Resources<</XObject<</Im0 4 0 R>>>>/Contents 5 0 R>>endobj\n`,
    `4 0 obj<</Type/XObject/Subtype/Image/Width ${w}/Height ${h}/Filter/JPXDecode/Length ${j2k.length}>>stream\n`,
    j2k,
    "\nendstream endobj\n",
    `5 0 obj<</Length ${content.length}>>stream\n${content}\nendstream endobj\n`,
    "trailer<</Root 1 0 R/Size 6>>\n%%EOF\n",
  ];
  const chunks = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p));
  const bytes = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  const pdfjs = await getPdfJs();
  const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  try {
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    await page.render({ canvasContext: ctx, viewport: vp, intent: "print" }).promise;
    return canvasGray(canvas, { x: 0, y: 0, w, h });
  } finally {
    await doc.destroy();
  }
}

export async function decodeQrPhoto(j2k: Uint8Array): Promise<Gray | null> {
  try {
    const g = await decodeWithImageDecoders(j2k);
    if (g) return g;
  } catch {
    /* fall back to the pdf.js worker */
  }
  try {
    return await decodeWithPdf(j2k);
  } catch {
    return null;
  }
}

export interface PhotoCheck {
  match: PhotoMatch | null;
  /** where the printed photo is on the page (pixels) */
  rect: { x: number; y: number; w: number; h: number } | null;
  /** true when the printed photo was located from the file structure (an embedded image) */
  located: boolean;
}

/**
 * Compare the QR photo with the printed photo.
 * PDFs: every portrait-shaped embedded image is a candidate. Images: the area to the left of
 * the printed name (where every Aadhaar card puts the photo) is searched.
 */
export async function checkPrintedPhoto(
  qrPhoto: Gray,
  canvas: HTMLCanvasElement,
  opts: { imageRects?: { x: number; y: number; w: number; h: number }[]; boxes: TextBox[]; qrName?: string; qrBoxes: { x: number; y: number; w: number; h: number }[] }
): Promise<PhotoCheck> {
  const W = canvas.width;
  const notQr = (r: { x: number; y: number; w: number; h: number }) =>
    !opts.qrBoxes.some((q) => Math.min(r.x + r.w, q.x + q.w) - Math.max(r.x, q.x) > r.w * 0.5 && Math.min(r.y + r.h, q.y + q.h) - Math.max(r.y, q.y) > r.h * 0.5);
  const candidates = (opts.imageRects ?? []).filter((r) => {
    const a = r.h / Math.max(1, r.w);
    return a > 1.02 && a < 1.7 && r.w > W * 0.03 && r.w < W * 0.35 && notQr(r);
  });
  let best: PhotoCheck = { match: null, rect: null, located: false };
  for (const r of candidates) {
    const g = canvasGray(canvas, r);
    if (!g) continue;
    const m = matchPhotos(g, qrPhoto);
    if (!best.match || m.pixel > best.match.pixel) best = { match: m, rect: r, located: true };
  }
  if (best.match) return best;

  // No embedded photo (an image file): the photo sits just left of the printed name. Anchor on the
  // word that starts the name (OCR often glues photo noise onto the front of that line).
  const first = (opts.qrName ?? "").trim().split(/\s+/)[0]?.toUpperCase() ?? "";
  const anchors = first.length >= 3
    ? opts.boxes.filter((b) => {
        const t = b.str.toUpperCase().replace(/[^A-Z]/g, "");
        return t.length >= 3 && Math.max(similarity(first, t), similarity(first, t.slice(0, first.length))) >= 0.75;
      })
    : [];
  if (!anchors.length) {
    const lines = buildLines(opts.boxes);
    const qn = opts.qrName ? normName(opts.qrName) : "";
    for (const l of lines) if (qn && similarity(qn, normName(l.text)) > 0.6) anchors.push(l.boxes[l.boxes.length - 1]);
  }
  for (const a of anchors.slice(0, 4)) {
    // Aadhaar layout: the photo ends ~1–2 name-heights left of the name and is ~11 name-heights
    // wide; the signed face crop is ~7 name-heights wide.
    const lh = Math.max(6, a.h);
    const win = { x: Math.max(0, a.x - lh * 17), y: Math.max(0, a.y - lh * 6), w: 0, h: lh * 18 };
    win.w = Math.max(0, a.x - lh * 0.3 - win.x);
    if (win.w < lh * 6) continue;
    const g = canvasGray(canvas, win);
    if (!g) continue;
    const W0 = 128;
    const sc = resize(g, W0, Math.max(32, Math.round((W0 * g.h) / g.w)));
    const coarse = matchPhotos(sc, qrPhoto, { minFrac: Math.min(0.8, (lh * 3.5) / win.w), maxFrac: Math.min(0.95, (lh * 11) / win.w), width: W0 });
    // refine: a tight crop around the best spot, searched finely
    const c = coarse.at;
    const rect = { x: Math.max(0, win.x + (c.x - c.w * 0.25) * win.w), y: Math.max(0, win.y + (c.y - c.h * 0.25) * win.h), w: c.w * 1.5 * win.w, h: c.h * 1.5 * win.h };
    const g2 = canvasGray(canvas, rect);
    const fine = g2 ? matchPhotos(g2, qrPhoto, { minFrac: 0.55, maxFrac: 0.85, width: 72 }) : coarse;
    const m = fine.pixel > coarse.pixel ? fine : coarse;
    if (!best.match || m.pixel > best.match.pixel) best = { match: m, rect: { x: win.x + c.x * win.w, y: win.y + c.y * win.h, w: c.w * win.w, h: c.h * win.h }, located: false };
  }
  return best;
}
