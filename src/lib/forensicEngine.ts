/**
 * VeriChain Forensic Engine — "Tamper Map"
 *
 * Finds edits WITHOUT the original by comparing the document with four
 * other references, all on-device:
 *   1. the document vs itself (noise, compression, background, fonts, glyphs)
 *   2. older versions hidden inside the file (PDF saves, covered text, EXIF preview)
 *   3. signed data printed on it (Aadhaar Secure QR, PDF signatures)
 *   4. its own rules (Aadhaar check digit, marksheet arithmetic)
 *
 * Everything is fused on one grid over page 1 → one verdict + one heatmap.
 */

import { analyzePdf, getPdfJs, renderPdfPage, PdfPasswordError, type PdfAnalysis } from "./forensics/pdfForensics";
import { analyzePixels } from "./forensics/imageForensics";
import { analyzeExif } from "./forensics/exifForensics";
import { ocrRegion, runOcr, type OcrWord } from "./forensics/ocr";
import { buildLines } from "./forensics/textLines";
import { readQRCodes, readQRCodesRobust, type QRHit } from "./forensics/qr";
import { runAadhaarChecks, type AadhaarReport } from "./forensics/aadhaarChecks";
import { checkGradeCard, checkMarksheet, looksLikeMarksheet, type GradeCardReport, type MarksheetReport } from "./forensics/marksheet";
import { checkPrintedPhoto, decodeQrPhoto } from "./forensics/aadhaarPhoto";
import { looksLikeAadhaar } from "./forensics/aadhaar";
import { analyzeGlyphs } from "./forensics/glyphForensics";
import { fuse } from "./forensics/fusion";
import { makeFingerprint, compareWithRegistry, spatialMerkleRoot, type Fingerprint, type RegistryMatch } from "./forensics/registry";
import {
  type CheckRun,
  type DocKind,
  type DocType,
  type Evidence,
  type PageRender,
  type TamperLayer,
  type TextBox,
  type VerdictKind,
  TamperGrid,
} from "./forensics/types";

export { PdfPasswordError };
export type { Fingerprint, RegistryMatch };
export type { Evidence, TamperLayer, CheckRun, VerdictKind, DocType, DocKind };

export interface Hotspot {
  x: number;
  y: number;
  width: number;
  height: number;
  intensity: number; // 0-1
  type: "ela" | "clone" | "noise" | "edit";
}

export interface Detection {
  type: "pixel" | "metadata" | "font" | "artifact";
  label: string;
  severity: "info" | "warning" | "critical";
  description: string;
  region?: string;
}

export interface MetadataInfo {
  hasExif: boolean;
  software?: string;
  dateCreated?: string;
  dateModified?: string;
  camera?: string;
  dimensions: { width: number; height: number };
  fileSize: number;
  mimeType: string;
  inconsistencies: string[];
}

export interface PixelStats {
  mean: number;
  stdDev: number;
  entropy: number;
  uniqueColors: number;
  noiseLevel: number;
}

export interface ForensicResult {
  // ── kept for the existing panels ──
  authenticityScore: number;
  forgeryRisk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  aiConfidence: number;
  elaImageDataUrl: string | null;
  hotspots: Hotspot[];
  detections: Detection[];
  metadata: MetadataInfo;
  pixelStats: PixelStats;
  aiAnalysis: string | null;
  aiTokensPerSecond: number | null;
  aiLatencyMs: number | null;

  // ── Tamper Map ──
  verdict: VerdictKind;
  verdictTitle: string;
  summary: string;
  evidence: Evidence[];
  layers: TamperLayer[];
  fusedGrid: { cols: number; rows: number; data: Float32Array };
  pageImageUrl: string | null;
  docKind: DocKind;
  docType: DocType;
  checks: CheckRun[];
  changes: { before: string; after: string; field?: string }[];
  aadhaar: AadhaarReport | null;
  marksheet: MarksheetReport | null;
  gradeCard: GradeCardReport | null;
  pages: number;
  analysisMs: number;
  fingerprint: Fingerprint | null;
  merkleRoot: string | null;
  registryMatch: RegistryMatch | null;
}

export interface AnalyzeOptions {
  password?: string;
  onProgress?: (message: string) => void;
}

function sniff(bytes: Uint8Array, mime: string): DocKind {
  const head = String.fromCharCode(...bytes.slice(0, 5));
  if (head.startsWith("%PDF")) return "pdf";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (mime.startsWith("image/")) return "image";
  // PDF header can sit a little after the start
  if (new TextDecoder("latin1").decode(bytes.slice(0, 1024)).includes("%PDF-")) return "pdf";
  return "other";
}

async function fileToCanvas(file: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const maxSide = 4096;
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas;
}

/** Copy of the page with QR codes blanked out: on ID cards the QR sits beside the printed details,
 *  and OCR otherwise blends its pattern into those text lines. */
function withoutQr(canvas: HTMLCanvasElement, qrs: { box: { x: number; y: number; w: number; h: number } }[]): HTMLCanvasElement {
  if (!qrs.length) return canvas;
  const c = document.createElement("canvas");
  c.width = canvas.width;
  c.height = canvas.height;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0);
  ctx.fillStyle = "#ffffff";
  for (const q of qrs) {
    const m = Math.max(q.box.w, q.box.h) * 0.12;
    ctx.fillRect(q.box.x - m, q.box.y - m, q.box.w + 2 * m, q.box.h + 2 * m);
  }
  return c;
}

function evidenceToDetection(e: Evidence): Detection {
  const type: Detection["type"] =
    e.category === "metadata" ? "metadata" : e.category === "pdf-font" || e.category === "glyph" ? "font" : e.category === "pixel" ? "pixel" : "artifact";
  return {
    type,
    label: e.title,
    severity: e.severity === "pass" ? "info" : e.severity,
    description: e.detail,
    region: e.regions?.length ? `${e.regions.length} area(s)` : undefined,
  };
}

function detectDocType(text: string, qrs: QRHit[]): DocType {
  if (qrs.some((q) => /^\d{200,}$/.test(q.text.trim()) || /PrintLetterBarcodeData/i.test(q.text))) return "aadhaar";
  if (looksLikeAadhaar(text)) return "aadhaar";
  if (looksLikeMarksheet(text)) return "marksheet";
  if (/certificate|certify|certified/i.test(text)) return "certificate";
  return "unknown";
}

export async function analyzeDocument(file: File, opts: AnalyzeOptions = {}): Promise<ForensicResult> {
  const t0 = performance.now();
  const progress = (m: string) => opts.onProgress?.(m);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) return emptyResult(file, "Empty file", "This file is empty (0 bytes). Upload the actual PDF or photo.", t0);
  const docKind = sniff(bytes, file.type);
  // QR codes sit on their own white "quiet zone" — exclude that margin from background/grain checks
  const qrMargin = (q: QRHit) => ({ x: q.box.x - q.box.w * 0.25, y: q.box.y - q.box.h * 0.25, w: q.box.w * 1.5, h: q.box.h * 1.5 });

  const evidence: Evidence[] = [];
  const layers: TamperLayer[] = [];
  const checks: CheckRun[] = [];
  let render: PageRender;
  let textBoxes: TextBox[] = [];
  let docText = "";
  let textSource: "pdf" | "ocr" = "pdf";
  let ocrWords: OcrWord[] = [];
  let stats: PixelStats = { mean: 0, stdDev: 0, entropy: 0, uniqueColors: 0, noiseLevel: 0 };
  let elaUrl: string | null = null;
  let pdfA: PdfAnalysis | null = null;
  let photoLike = false;
  let earlyQrs: QRHit[] | null = null;
  const meta: MetadataInfo = {
    hasExif: false,
    dimensions: { width: 0, height: 0 },
    fileSize: file.size,
    mimeType: file.type || docKind,
    inconsistencies: [],
  };

  if (docKind === "other") {
    return emptyResult(file, "Unsupported file type", "Upload a PDF or an image (JPG, PNG). Word files can't be checked for edits yet — export or scan them to PDF first.", t0);
  }

  let grid: TamperGrid;
  if (docKind === "pdf") {
    pdfA = await analyzePdf(bytes, opts.password, progress);
    render = pdfA.render;
    grid = new TamperGrid(render.width, render.height);
    evidence.push(...pdfA.evidence);
    layers.push(...pdfA.layers);
    checks.push(...pdfA.checks);
    textBoxes = pdfA.textBoxes;
    docText = pdfA.docText;
    meta.software = pdfA.meta.producer;
    meta.dateCreated = pdfA.meta.created;
    meta.dateModified = pdfA.meta.modified;
    progress("Checking page pixels");
    const pdfQr = await readQRCodes(render.canvas).catch(() => [] as QRHit[]);
    if (pdfQr.length) earlyQrs = pdfQr;
    const px = await analyzePixels(render.canvas, grid, { isJpeg: false, fromRender: true, exclude: [...pdfA.imageRects, ...pdfQr.map(qrMargin)] });
    evidence.push(...px.evidence);
    layers.push(...px.layers);
    checks.push(...px.checks.filter((c) => c.id !== "px-ela"));
    stats = px.stats;
    photoLike = px.photoLike;
    if (pdfA.isScanned) {
      progress("Reading scanned page (on-device OCR)");
      try {
        const o = await runOcr(withoutQr(render.canvas, pdfQr));
        ocrWords = o.words;
        textBoxes = o.words;
        docText = o.text;
        textSource = "ocr";
      } catch {
        checks.push({ id: "ocr", label: "Text recognition", status: "skip", note: "OCR unavailable" });
      }
    }
  } else {
    progress("Loading image");
    render = await (async () => {
      const canvas = await fileToCanvas(file);
      return { canvas, width: canvas.width, height: canvas.height };
    })();
    grid = new TamperGrid(render.width, render.height);
    progress("Reading image metadata");
    const ex = await analyzeExif(file, render.canvas, grid);
    evidence.push(...ex.evidence);
    layers.push(...ex.layers);
    checks.push(...ex.checks);
    meta.hasExif = ex.summary.hasExif;
    meta.software = ex.summary.software;
    meta.camera = ex.summary.camera;
    meta.dateCreated = ex.summary.dateTaken;
    meta.dateModified = ex.summary.dateModified ?? new Date(file.lastModified).toISOString();
    progress("Looking for QR codes");
    earlyQrs = await readQRCodesRobust(render.canvas).catch(() => [] as QRHit[]);
    progress("Comparing every area of the image with the rest");
    const px = await analyzePixels(render.canvas, grid, { isJpeg: docKind === "jpeg", fromRender: false, exclude: earlyQrs.map(qrMargin) });
    evidence.push(...px.evidence);
    layers.push(...px.layers);
    checks.push(...px.checks);
    stats = px.stats;
    elaUrl = px.elaDataUrl;
    photoLike = px.photoLike;
    progress("Reading text (on-device OCR)");
    try {
      const o = await runOcr(withoutQr(render.canvas, earlyQrs ?? []));
      ocrWords = o.words;
      textBoxes = o.words;
      docText = o.text;
      textSource = "ocr";
      checks.push({ id: "ocr", label: "Text recognition", status: "pass", note: `${o.words.length} words` });
    } catch {
      checks.push({ id: "ocr", label: "Text recognition", status: "skip", note: "OCR unavailable" });
    }
  }
  meta.dimensions = { width: render.width, height: render.height };

  // ── Glyph consistency (images and scans) ──
  if (textSource === "ocr" && ocrWords.length > 10) {
    progress("Comparing letter and digit shapes");
    try {
      const g = analyzeGlyphs(render.canvas, ocrWords, grid);
      evidence.push(...g.evidence);
      layers.push(...g.layers);
      checks.push(...g.checks);
    } catch {
      checks.push({ id: "glyph", label: "Glyph consistency", status: "skip" });
    }
  }

  // ── QR codes ──
  progress("Looking for QR codes");
  let qrs: QRHit[] = [];
  try {
    qrs = earlyQrs ?? (await readQRCodes(render.canvas));
    if (!qrs.length && pdfA) {
      // dense Aadhaar QR needs more pixels
      const big = await renderPdfPage(pdfA.doc, 1, 2800, true);
      const s = render.width / big.render.width;
      qrs = (await readQRCodes(big.render.canvas)).map((q) => ({ ...q, box: { x: q.box.x * s, y: q.box.y * s, w: q.box.w * s, h: q.box.h * s } }));
    }
  } catch {
    qrs = [];
  }
  checks.push({ id: "qr", label: "QR code", status: qrs.length ? "pass" : "skip", note: qrs.length ? `${qrs.length} found` : "none found" });

  const docType = detectDocType(docText, qrs);

  // Non-Aadhaar QR codes: show what they say so the verifier can follow the issuer's own link.
  if (docType !== "aadhaar") {
    qrs.slice(0, 2).forEach((q, i) => {
      const isUrl = /^https?:\/\//i.test(q.text.trim());
      evidence.push({
        id: `qr-info-${i}`,
        category: "qr",
        severity: "info",
        title: isUrl ? "QR links to a verification page" : "QR code content",
        detail: isUrl
          ? `${q.text.trim().slice(0, 160)} — open it to compare with the issuer's record, and check the domain really belongs to the issuer.`
          : q.text.trim().slice(0, 200),
        regions: [{ x: q.box.x / render.width, y: q.box.y / render.height, w: q.box.w / render.width, h: q.box.h / render.height, label: "QR" }],
      });
    });
  }

  // ── Aadhaar ──
  let aadhaar: AadhaarReport | null = null;
  if (docType === "aadhaar") {
    progress("Checking Aadhaar QR and number");
    // OCR confidence for the words that make up a printed value (number groups, a date, a year)
    const confFor = (needle: string) => {
      const digits = needle.replace(/\D/g, "");
      if (!digits) {
        // a word (e.g. part of a name): the best-read OCR word with these letters
        const n = needle.toUpperCase().replace(/[^A-Z]/g, "");
        if (n.length < 2) return 0;
        const ws = ocrWords.filter((w) => w.str.toUpperCase().replace(/[^A-Z]/g, "") === n);
        return ws.length ? Math.max(...ws.map((w) => w.confidence)) : 0;
      }
      const parts = digits.length === 12 ? [digits.slice(0, 4), digits.slice(4, 8), digits.slice(8)] : [digits];
      const ws = ocrWords.filter((w) => {
        const d = w.str.replace(/\D/g, "");
        return d.length >= 2 && parts.some((p) => p.includes(d) || d.includes(p));
      });
      return ws.length ? Math.min(...ws.map((w) => w.confidence)) : 0;
    };
    // OCR sometimes "reads" the QR pattern as words — drop text that sits inside a QR code
    const inQr = (b: TextBox) =>
      qrs.some((q) => b.x + b.w / 2 > q.box.x && b.x + b.w / 2 < q.box.x + q.box.w && b.y + b.h / 2 > q.box.y && b.y + b.h / 2 < q.box.y + q.box.h);
    let aBoxes = textSource === "ocr" ? textBoxes.filter((b) => !inQr(b)) : textBoxes;
    let aText = textSource === "ocr" ? aBoxes.map((b) => b.str).join(" ") : docText;
    let a = await runAadhaarChecks(qrs, aBoxes, aText, textSource, render.width, render.height, confFor);

    // Images: the small identity block next to the photo (name, DOB, gender) is often misread by
    // the whole-page pass. Re-read the area above each printed number, enlarged, before deciding
    // that a field is missing or different.
    let rereadConfident = 0;
    if (textSource === "ocr" && (!a.report.printedDob || !a.report.printedGender || !a.report.printedName)) {
      progress("Re-reading the card's details (zoomed)");
      const numLines = buildLines(aBoxes)
        .filter((l) => /(?<!\d)[2-9]\d{3}\s?\d{4}\s?\d{4}(?!\d)/.test(l.text.replace(/VID\s*:?[\d\s]+/i, "")))
        .sort((p, q) => q.y - p.y)
        .slice(0, 3);
      const W = render.width, H = render.height;
      const regions = numLines.map((l) => {
        const h = Math.min(H * 0.3, Math.max(H * 0.13, l.h * 10));
        const x = Math.max(0, l.x - W * 0.12);
        return { x, y: Math.max(0, l.y - h), w: Math.min(W - x, l.w + W * 0.3), h: Math.min(h, l.y) };
      });
      const extra: OcrWord[] = [];
      const inside = (b: TextBox, r: { x: number; y: number; w: number; h: number }) => b.x + b.w / 2 > r.x && b.x + b.w / 2 < r.x + r.w && b.y + b.h / 2 > r.y && b.y + b.h / 2 < r.y + r.h;
      for (const r of regions) {
        try {
          const ws = (await ocrRegion(withoutQr(render.canvas, qrs), r, { psm: "6" })).filter((w) => !inQr(w));
          extra.push(...ws.map((w) => ({ ...w, str: w.str })));
          rereadConfident += ws.filter((w) => w.confidence >= 80 && /[A-Za-z0-9]{3,}/.test(w.str)).length;
        } catch {
          /* keep the first pass */
        }
      }
      if (extra.length) {
        const kept = aBoxes.filter((b) => !regions.some((r) => inside(b, r)));
        aBoxes = [...kept, ...extra];
        ocrWords = [...ocrWords.filter((w) => !regions.some((r) => inside(w, r))), ...extra];
        aText = aBoxes.map((b) => b.str).join(" ");
        a = await runAadhaarChecks(qrs, aBoxes, aText, textSource, render.width, render.height, confFor);
        textBoxes = aBoxes;
        // "missing" from an image is only a hard finding if the zoomed re-read itself was clear
        if (rereadConfident < 4)
          for (const e of a.evidence) if (e.severity === "critical" && /missing/i.test(e.title)) e.severity = "warning";
      }
    }
    evidence.push(...a.evidence);
    checks.push(...a.checks);
    aadhaar = a.report;

    // ── Printed photo vs the photo signed inside the QR ──
    if (aadhaar.qr?.photo) {
      progress("Comparing the photo with the one signed in the QR");
      try {
        const qp = await decodeQrPhoto(aadhaar.qr.photo);
        const pc = qp
          ? await checkPrintedPhoto(qp, render.canvas, { imageRects: pdfA?.imageRects, boxes: aBoxes, qrName: aadhaar.qr.name, qrBoxes: qrs.map((q) => q.box) })
          : null;
        const m = pc?.match;
        if (m && pc.rect) {
          const region = [{ x: pc.rect.x / render.width, y: pc.rect.y / render.height, w: pc.rect.w / render.width, h: pc.rect.h / render.height, label: "photo" }];
          const score = Math.round(Math.max(0, m.pixel) * 100);
          // embedded photo (PDF): same picture ≥ 0.9, another person ≤ 0.6. Found by search in an
          // image: same picture ≥ 0.85, another person ≤ 0.45 (thresholds leave room for compression).
          const okAt = pc.located ? 0.8 : 0.75;
          const badAt = pc.located ? 0.62 : 0.45;
          if (m.pixel >= okAt) {
            aadhaar.photo = { score, verdict: "match" };
            evidence.push({ id: "aad-photo", category: "aadhaar", severity: "pass", title: "Photo matches the signed QR photo", detail: `The printed photo lines up with the photo UIDAI signed inside the QR (similarity ${score}%). A swapped photo would not.` });
            checks.push({ id: "aad-photo", label: "Photo vs QR photo", status: "pass", note: `${score}% similar` });
          } else if (m.pixel < (pc.located ? badAt : 0.62) && m.edges < 0.5) {
            aadhaar.photo = { score, verdict: "mismatch" };
            const sure = m.pixel < badAt;
            evidence.push({
              id: "aad-photo",
              category: "aadhaar",
              severity: sure ? "critical" : "warning",
              title: sure ? "Photo doesn't match the signed QR photo" : "Photo may not match the signed QR photo",
              detail: sure
                ? `The QR carries the holder's photo, signed by UIDAI. The photo printed on the card is a different picture (similarity only ${score}%) — the photo was replaced.`
                : `The photo signed inside the QR and the photo found on the card look different (similarity ${score}%). The photo may have been replaced — compare them by eye.`,
              regions: [...region.map((r) => ({ ...r, label: "photo ≠ QR photo" })), ...(qrs[0] ? [{ x: qrs[0].box.x / render.width, y: qrs[0].box.y / render.height, w: qrs[0].box.w / render.width, h: qrs[0].box.h / render.height, label: "signed QR" }] : [])],
              layerId: "aadhaar",
              change: { before: "photo in signed QR", after: "different photo printed", field: "Photo" },
            });
            checks.push({ id: "aad-photo", label: "Photo vs QR photo", status: "flag", note: `${score}% similar` });
          } else {
            aadhaar.photo = { score, verdict: "unsure" };
            evidence.push({ id: "aad-photo", category: "aadhaar", severity: pc.located ? "warning" : "info", title: "Photo only partly matches the QR photo", detail: `The printed photo is only ${score}% similar to the photo signed inside the QR. Image quality can cause this; compare the two faces by eye.`, regions: region });
            checks.push({ id: "aad-photo", label: "Photo vs QR photo", status: pc.located ? "flag" : "skip", note: `${score}% similar` });
          }
        } else {
          aadhaar.photo = { score: 0, verdict: "not-compared", note: qp ? "photo not found on the card" : "QR photo couldn't be decoded" };
          checks.push({ id: "aad-photo", label: "Photo vs QR photo", status: "skip", note: aadhaar.photo.note });
        }
      } catch {
        checks.push({ id: "aad-photo", label: "Photo vs QR photo", status: "skip", note: "photo check unavailable" });
      }
    }

    // Unlocking an e-Aadhaar (iLovePDF, Smallpdf…) re-saves it and removes UIDAI's signature. When the
    // name, DOB, gender, number and photo all match the signed QR, that re-save alone isn't an edit.
    if (aadhaar.qrMatches && aadhaar.photo?.verdict === "match" && !a.evidence.some((e) => e.severity === "critical")) {
      for (let k = 0; k < evidence.length; k++) {
        const e = evidence[k];
        if (e.category === "metadata" && e.severity === "warning" && /editing tool|issuer's original/i.test(e.title)) {
          evidence[k] = {
            ...e,
            severity: "info",
            title: "Re-saved by another program",
            detail: `${e.detail} Here the printed name, date of birth, gender, number and photo all match the UIDAI-signed QR, so the re-save (often done to remove the password) is not by itself a sign of editing. UIDAI's digital signature is no longer on this copy.`,
          };
        }
      }
    }
    const ag = TamperGrid.like(grid);
    for (const e of a.evidence) if (e.severity === "critical") for (const r of e.regions ?? []) ag.markRect(r.x * render.width, r.y * render.height, r.w * render.width, r.h * render.height, 1);
    if (ag.max() > 0) layers.push({ id: "aadhaar", label: "Aadhaar mismatch", color: "#FF3131", description: "Printed details that disagree with the signed QR or fail the check digit", grid: ag.data, critical: true, strength: 1 });
  }

  // ── Marksheet arithmetic ──
  let marksheet: MarksheetReport | null = null;
  let gradeCard: GradeCardReport | null = null;
  if (docType === "marksheet" || docType === "certificate" || /total|sgpa|cgpa/i.test(docText)) {
    progress("Checking that the marks add up");
    const m = checkMarksheet(textBoxes, render.width, render.height, docText);
    if (m.report.checked) {
      evidence.push(...m.evidence);
      marksheet = m.report;
      checks.push({ id: "marks", label: "Marks arithmetic", status: m.report.consistent ? "pass" : m.evidence.some((e) => e.severity === "critical") ? "flag" : "skip" });
      const mg = TamperGrid.like(grid);
      for (const e of m.evidence) if (e.severity === "critical") for (const r of (e.regions ?? []).slice(0, 1)) mg.markRect(r.x * render.width, r.y * render.height, r.w * render.width, r.h * render.height, 0.9);
      if (mg.max() > 0) layers.push({ id: "marksheet", label: "Arithmetic", color: "#FF3131", description: "Totals or percentages that don't match the subject marks", grid: mg.data, critical: true, strength: 0.9 });
    }
    const g = docType === "aadhaar" ? null : checkGradeCard(textBoxes, render.width, render.height);
    if (g?.report.checked) {
      evidence.push(...g.evidence);
      gradeCard = g.report;
      checks.push({ id: "grades", label: "SGPA / CGPA arithmetic", status: g.report.consistent ? "pass" : g.evidence.some((e) => e.severity === "critical") ? "flag" : "skip" });
      const gg = TamperGrid.like(grid);
      for (const e of g.evidence) if (e.severity === "critical") for (const r of (e.regions ?? []).slice(0, 1)) gg.markRect(r.x * render.width, r.y * render.height, r.w * render.width, r.h * render.height, 0.9);
      if (gg.max() > 0) layers.push({ id: "gradecard", label: "Grade arithmetic", color: "#FF3131", description: "SGPA/CGPA or credit points that don't follow from the grades", grid: gg.data, critical: true, strength: 0.9 });
    }
    if (!m.report.checked && !g?.report.checked && docType === "marksheet") {
      checks.push({ id: "marks", label: "Marks arithmetic", status: "skip", note: "table not recognised" });
    }
  }

  // ── Issuer registry: compare with registered originals (if any) ──
  let fingerprint: Fingerprint | null = null;
  let merkleRoot: string | null = null;
  let registryMatch: RegistryMatch | null = null;
  try {
    progress("Comparing with registered originals");
    fingerprint = await makeFingerprint(bytes, render, textBoxes, grid.cols);
    merkleRoot = await spatialMerkleRoot(fingerprint);
    const rc = await compareWithRegistry(fingerprint, grid, { photo: photoLike });
    evidence.push(...rc.evidence);
    layers.push(...rc.layers);
    registryMatch = rc.match;
    checks.push({
      id: "registry",
      label: "Registered original",
      status: rc.match ? (rc.evidence.some((e) => e.severity === "critical") ? "flag" : "pass") : "skip",
      note: rc.match ? `matched "${rc.match.original.name}"` : "not in registry",
    });
  } catch {
    checks.push({ id: "registry", label: "Registered original", status: "skip", note: "registry unavailable" });
  }

  // ── Is there enough document here to judge? (tiny images, holiday photos, blank scans) ──
  // count only confident, real words — OCR "reads" shapes in ordinary photos as garbage words
  const realWords = ocrWords.filter((w) => w.confidence >= 70 && /[A-Za-z0-9]{3,}/.test(w.str)).length;
  const lowContent =
    docKind !== "pdf" || pdfA?.isScanned
      ? Math.min(render.width, render.height) < 300 || (realWords < 8 && qrs.length === 0)
      : textBoxes.length < 3 && qrs.length === 0;
  if (lowContent) {
    evidence.push({
      id: "low-content",
      category: "metadata",
      severity: "info",
      title: "Not enough document content",
      detail: "Very little readable text was found (or the image is tiny), so most checks have nothing to compare. Upload a clear, complete PDF or photo of the document.",
    });
  }

  // ── Fuse ──
  progress("Combining all checks");
  // ID cards: the verdict rests on deterministic checks. Can any run on this file?
  const idCard = docType === "aadhaar";
  const qrCompared = checks.some((c) => c.id === "aad-qr" && c.status !== "skip");
  const digitChecked = checks.some((c) => c.id === "aad-verhoeff" && c.status !== "skip");
  const idVerifiable = (docKind === "pdf" && !pdfA?.isScanned) || qrCompared || digitChecked;
  // Identity-field mask: cells around the name, DOB, gender and number (and where a missing
  // field should be). Pixel evidence there counts even on an ID card.
  let idMask: Uint8Array | undefined;
  if (idCard) {
    idMask = new Uint8Array(grid.data.length);
    const m = TamperGrid.like(grid);
    const pad = (x: number, y: number, w: number, h: number) => m.markRect(x - grid.cellW, y - grid.cellH, w + 2 * grid.cellW, h + 2 * grid.cellH, 1);
    // identity fields only: the name, date of birth, gender and Aadhaar number lines found by the
    // Aadhaar checks (not the VID, enrolment number or address)
    for (const r of aadhaar?.fields ?? []) pad(r.x, r.y, r.w, r.h);
    // where a field is missing or the photo differs
    for (const e of evidence)
      if (e.category === "aadhaar" && e.severity === "critical")
        for (const r of e.regions ?? []) if (r.label !== "signed QR") m.markRect(r.x * render.width, r.y * render.height, r.w * render.width, r.h * render.height, 1);
    for (let k = 0; k < m.data.length; k++) idMask[k] = m.data[k] > 0 ? 1 : 0;
  }
  const f = fuse(grid, layers, evidence, checks, { lowContent, idCard, idVerifiable, idMask });
  meta.inconsistencies = f.evidence.filter((e) => e.category === "metadata" && e.severity !== "pass" && e.severity !== "info").map((e) => e.title);

  const pageImageUrl = render.canvas.toDataURL("image/jpeg", 0.9);

  return {
    authenticityScore: f.score,
    forgeryRisk: f.risk,
    aiConfidence: f.confidence,
    elaImageDataUrl: elaUrl,
    hotspots: f.hotspots,
    detections: f.evidence.map(evidenceToDetection),
    metadata: meta,
    pixelStats: stats,
    aiAnalysis: null,
    aiTokensPerSecond: null,
    aiLatencyMs: null,
    verdict: f.verdict,
    verdictTitle: f.title,
    summary: f.summary,
    evidence: f.evidence,
    layers,
    fusedGrid: { cols: f.fused.cols, rows: f.fused.rows, data: f.fused.data },
    pageImageUrl,
    docKind,
    docType,
    checks,
    changes: f.changes,
    aadhaar,
    marksheet,
    gradeCard,
    pages: pdfA?.numPages ?? 1,
    analysisMs: Math.round(performance.now() - t0),
    fingerprint,
    merkleRoot,
    registryMatch,
  };
}

function emptyResult(file: File, title: string, summary: string, t0: number): ForensicResult {
  return {
    authenticityScore: 70,
    forgeryRisk: "MEDIUM",
    aiConfidence: 0,
    elaImageDataUrl: null,
    hotspots: [],
    detections: [{ type: "metadata", label: title, severity: "info", description: summary }],
    metadata: { hasExif: false, dimensions: { width: 0, height: 0 }, fileSize: file.size, mimeType: file.type, inconsistencies: [] },
    pixelStats: { mean: 0, stdDev: 0, entropy: 0, uniqueColors: 0, noiseLevel: 0 },
    aiAnalysis: null,
    aiTokensPerSecond: null,
    aiLatencyMs: null,
    verdict: "INCONCLUSIVE",
    verdictTitle: title,
    summary,
    evidence: [{ id: "unsupported", category: "metadata", severity: "info", title, detail: summary }],
    layers: [],
    fusedGrid: { cols: 1, rows: 1, data: new Float32Array(1) },
    pageImageUrl: null,
    docKind: "other",
    docType: "unknown",
    checks: [],
    changes: [],
    aadhaar: null,
    marksheet: null,
    gradeCard: null,
    pages: 0,
    analysisMs: Math.round(performance.now() - t0),
    fingerprint: null,
    merkleRoot: null,
    registryMatch: null,
  };
}

/** Short, concrete prompt for the small on-device LLM — it explains the verdict, it doesn't decide it. */
export function buildNarrationPrompt(r: ForensicResult): string {
  const doc = r.docType === "unknown" ? "document" : r.docType;
  const changes = r.changes.slice(0, 3).map((c) => `${c.before} was changed to ${c.after}`).join("; ");
  const top = r.evidence
    .filter((e) => e.severity === "critical" || e.severity === "warning")
    .slice(0, 2)
    .map((e) => e.title.toLowerCase())
    .join("; ");
  if (r.verdict === "NO_SIGNS" || r.verdict === "MATCHES_ORIGINAL")
    return `The ${doc} passed all checks (${r.verdictTitle.toLowerCase()}). In 2 short sentences, tell the verifier it looks unedited and that only the issuer's original can fully prove it.`;
  return `The ${doc} was flagged: ${r.verdictTitle}. ${changes ? `Changes: ${changes}.` : ""} Evidence: ${top || "none"}. In 2 short sentences, tell the verifier what was changed and to ask the issuer for the original.`;
}

export { getPdfJs };
