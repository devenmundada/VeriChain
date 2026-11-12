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
import { runOcr, type OcrWord } from "./forensics/ocr";
import { readQRCodes, readQRCodesRobust, type QRHit } from "./forensics/qr";
import { runAadhaarChecks, type AadhaarReport } from "./forensics/aadhaarChecks";
import { checkMarksheet, looksLikeMarksheet, type MarksheetReport } from "./forensics/marksheet";
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
  if (looksLikeAadhaar(text) || qrs.some((q) => /^\d{200,}$/.test(q.text.trim()) || /PrintLetterBarcodeData/i.test(q.text))) return "aadhaar";
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
        const o = await runOcr(render.canvas);
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
      const o = await runOcr(render.canvas);
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
      if (!digits) return 0;
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
    const aBoxes = textSource === "ocr" ? textBoxes.filter((b) => !inQr(b)) : textBoxes;
    const aText = textSource === "ocr" ? aBoxes.map((b) => b.str).join(" ") : docText;
    const a = await runAadhaarChecks(qrs, aBoxes, aText, textSource, render.width, render.height, confFor);
    evidence.push(...a.evidence);
    checks.push(...a.checks);
    aadhaar = a.report;
    const ag = TamperGrid.like(grid);
    for (const e of a.evidence) if (e.severity === "critical") for (const r of e.regions ?? []) ag.markRect(r.x * render.width, r.y * render.height, r.w * render.width, r.h * render.height, 1);
    if (ag.max() > 0) layers.push({ id: "aadhaar", label: "Aadhaar mismatch", color: "#FF3131", description: "Printed details that disagree with the signed QR or fail the check digit", grid: ag.data, critical: true, strength: 1 });
  }

  // ── Marksheet arithmetic ──
  let marksheet: MarksheetReport | null = null;
  if (docType === "marksheet" || docType === "certificate" || /total/i.test(docText)) {
    progress("Checking that the marks add up");
    const m = checkMarksheet(textBoxes, render.width, render.height, docText);
    if (m.report.checked) {
      evidence.push(...m.evidence);
      marksheet = m.report;
      checks.push({ id: "marks", label: "Marks arithmetic", status: m.report.consistent ? "pass" : m.evidence.some((e) => e.severity === "critical") ? "flag" : "skip" });
      const mg = TamperGrid.like(grid);
      for (const e of m.evidence) if (e.severity === "critical") for (const r of (e.regions ?? []).slice(0, 1)) mg.markRect(r.x * render.width, r.y * render.height, r.w * render.width, r.h * render.height, 0.9);
      if (mg.max() > 0) layers.push({ id: "marksheet", label: "Arithmetic", color: "#FF3131", description: "Totals or percentages that don't match the subject marks", grid: mg.data, critical: true, strength: 0.9 });
    } else if (docType === "marksheet") {
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
  const f = fuse(grid, layers, evidence, checks, { lowContent, idCard, idVerifiable });
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
