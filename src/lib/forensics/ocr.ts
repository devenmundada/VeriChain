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
