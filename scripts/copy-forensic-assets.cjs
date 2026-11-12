/**
 * Copies the browser runtimes used by the forensic engine into public/vendor
 * so every check runs on-device and offline (no CDN at analysis time).
 *
 *  - pdf.js worker, CMaps and standard fonts   → public/vendor/pdfjs
 *  - zxing-wasm QR reader                       → public/vendor/zxing
 *  - tesseract.js worker, core and English data → public/vendor/tesseract
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const nm = path.join(root, "node_modules");
const out = path.join(root, "public", "vendor");

function copyFile(from, to) {
  const src = path.join(nm, from);
  const dst = path.join(out, to);
  if (!fs.existsSync(src)) {
    console.warn(`[copy-forensic-assets] missing ${from} — skipped`);
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyDir(from, to) {
  const src = path.join(nm, from);
  const dst = path.join(out, to);
  if (!fs.existsSync(src)) {
    console.warn(`[copy-forensic-assets] missing ${from} — skipped`);
    return;
  }
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const s = path.join(src, entry);
    if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(dst, entry));
  }
}

copyFile("pdfjs-dist/build/pdf.worker.min.mjs", "pdfjs/pdf.worker.min.mjs");
copyDir("pdfjs-dist/cmaps", "pdfjs/cmaps");
copyDir("pdfjs-dist/standard_fonts", "pdfjs/standard_fonts");

copyFile("zxing-wasm/dist/reader/zxing_reader.wasm", "zxing/zxing_reader.wasm");

copyFile("tesseract.js/dist/worker.min.js", "tesseract/worker.min.js");
copyFile("tesseract.js-core/tesseract-core-simd-lstm.wasm.js", "tesseract/tesseract-core-simd-lstm.wasm.js");
copyFile("tesseract.js-core/tesseract-core-lstm.wasm.js", "tesseract/tesseract-core-lstm.wasm.js");
copyFile("@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", "tesseract/lang/eng.traineddata.gz");

console.log("[copy-forensic-assets] done");
