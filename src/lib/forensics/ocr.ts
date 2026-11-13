/**
 * On-device OCR (tesseract.js, self-hosted in public/vendor/tesseract).
 * Returns word boxes in the coordinates of the analysed canvas.
 */

import type { TextBox } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let workerPromise: Promise<any> | null = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const T = await import("tesseract.js");
      const worker = await T.createWorker("eng", 1, {
        workerPath: "/vendor/tesseract/worker.min.js",
        corePath: "/vendor/tesseract/tesseract-core-simd-lstm.wasm.js",
        langPath: "/vendor/tesseract/lang",
        gzip: true,
        workerBlobURL: false,
      });
      return worker;
    })().catch((e) => {
      workerPromise = null;
      throw e;
    });
  }
  return workerPromise;
}

export interface OcrWord extends TextBox {
  confidence: number;
}

export interface OcrResult {
  text: string;
  words: OcrWord[];
}

export async function runOcr(canvas: HTMLCanvasElement): Promise<OcrResult> {
  // Tesseract is fastest around 1600–2200 px wide.
  const maxW = 2200;
  let src = canvas;
  let scale = 1;
  if (canvas.width > maxW) {
    scale = maxW / canvas.width;
    src = document.createElement("canvas");
    src.width = Math.round(canvas.width * scale);
    src.height = Math.round(canvas.height * scale);
    src.getContext("2d")!.drawImage(canvas, 0, 0, src.width, src.height);
  }
  const worker = await getWorker();
  const { data } = await worker.recognize(src, {}, { text: true, blocks: true });
  const words: OcrWord[] = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const w of line.words ?? []) {
          const t = (w.text ?? "").trim();
          if (!t) continue;
          words.push({
            str: t,
            x: w.bbox.x0 / scale,
            y: w.bbox.y0 / scale,
            w: (w.bbox.x1 - w.bbox.x0) / scale,
            h: (w.bbox.y1 - w.bbox.y0) / scale,
            source: "ocr",
            confidence: w.confidence ?? 0,
          });
        }
      }
    }
  }
  return { text: data.text ?? words.map((w) => w.str).join(" "), words };
}

/**
 * Zoomed re-read of one area (e.g. the identity block of an ID card, whose small text next to a
 * photo and Hindi lines often confuses a whole-page pass). The crop is enlarged and read as one
 * block of text; word boxes come back in the coordinates of `canvas`.
 */
export async function ocrRegion(
  canvas: HTMLCanvasElement,
  rect: { x: number; y: number; w: number; h: number },
  opts: { scale?: number; psm?: "6" | "11" | "4" } = {}
): Promise<OcrWord[]> {
  const x = Math.max(0, Math.floor(rect.x)), y = Math.max(0, Math.floor(rect.y));
  const w = Math.min(canvas.width - x, Math.ceil(rect.w)), h = Math.min(canvas.height - y, Math.ceil(rect.h));
  if (w < 8 || h < 8) return [];
  const scale = opts.scale ?? Math.min(4, Math.max(1, 1400 / w));
  const c = document.createElement("canvas");
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, x, y, w, h, 0, 0, c.width, c.height);
  // grayscale + contrast stretch: coloured backgrounds and JPEG noise hurt small text
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  let lo = 255, hi = 0;
  for (let i = 0; i < d.length; i += 4) {
    const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const k = 255 / Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, (d[i] - lo) * k));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  const worker = await getWorker();
  await worker.setParameters({ tessedit_pageseg_mode: opts.psm ?? "6" });
  try {
    const { data } = await worker.recognize(c, {}, { blocks: true });
    const words: OcrWord[] = [];
    for (const block of data.blocks ?? [])
      for (const para of block.paragraphs ?? [])
        for (const line of para.lines ?? [])
          for (const wd of line.words ?? []) {
            const t = (wd.text ?? "").trim();
            if (!t) continue;
            words.push({
              str: t,
              x: x + wd.bbox.x0 / scale,
              y: y + wd.bbox.y0 / scale,
              w: (wd.bbox.x1 - wd.bbox.x0) / scale,
              h: (wd.bbox.y1 - wd.bbox.y0) / scale,
              source: "ocr",
              confidence: wd.confidence ?? 0,
            });
          }
    return words;
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: "3" });
  }
}
