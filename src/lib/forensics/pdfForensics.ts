/**
 * PDF forensics — finds edits inside the file itself, without the original.
 *
 *  1. Structure: incremental saves (%%EOF), digital signatures (/ByteRange),
 *     producers recorded by each save, encryption.
 *  2. Revision recovery: an incremental save keeps the older version in the
 *     file. We cut the file back, render both, and diff them (pixels + text).
 *  3. Text layer: text hidden under boxes, two different strings at one spot.
 *  4. Annotations used as edits (FreeText, white Square, Stamp…).
 *  5. Fonts: the same font embedded as two separate subsets, non-embedded
 *     fonts mixed into an embedded document, a font used only for one number.
 *  6. Metadata: editing tools, Info vs XMP disagreement, modified-after-created.
 */

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import {
  type CheckRun,
  type Evidence,
  type PageRender,
  type Region,
  type TamperLayer,
  type TextBox,
  TamperGrid,
  pxToRegion,
} from "./types";
import { buildLines, charEdges, linesText } from "./textLines";

type PdfJs = typeof import("pdfjs-dist");

let pdfjsPromise: Promise<PdfJs> | null = null;

export function getPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((m) => {
      m.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
      return m;
    });
  }
  return pdfjsPromise;
}

export class PdfPasswordError extends Error {
  constructor(public incorrect: boolean) {
    super(incorrect ? "Incorrect PDF password" : "This PDF is password-protected");
    this.name = "PdfPasswordError";
  }
}

const DOC_OPTS = {
  cMapUrl: "/vendor/pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
  fontExtraProperties: true,
  isEvalSupported: false,
};

export async function openPdf(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  const pdfjs = await getPdfJs();
  // pdf.js transfers the buffer to its worker, so hand it a copy.
  const task = pdfjs.getDocument({ data: bytes.slice(), password, ...DOC_OPTS });
  try {
    return await task.promise;
  } catch (e) {
    const err = e as { name?: string; code?: number };
    if (err?.name === "PasswordException") throw new PdfPasswordError(err.code === 2);
    throw e;
  }
}

// ───────────────────────── Structure scan ─────────────────────────

export interface PdfSignatureInfo {
  byteRange: number[];
  signedEnd: number;
  coversEnd: boolean;
  subFilter?: string;
  signer?: string;
  signedAt?: string;
}

export interface PdfStructure {
  fileLength: number;
  eofOffsets: number[];
  linearized: boolean;
  /** end offsets of each saved version, oldest first; last = whole file */
  revisionEnds: number[];
  signatures: PdfSignatureInfo[];
  producers: string[];
  encrypted: boolean;
}

function decodePdfString(raw: string) {
  return raw
    .replace(/\\([nrtbf()\\])/g, (_m, c) => ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[c] ?? c)
    .replace(/^﻿|^þÿ/, "")
    .replace(/\u0000/g, "")
    .trim();
}

export function scanStructure(bytes: Uint8Array): PdfStructure {
  const text = new TextDecoder("latin1").decode(bytes);
  const fileLength = bytes.length;

  const eofOffsets: number[] = [];
  for (const m of text.matchAll(/%%EOF/g)) eofOffsets.push((m.index ?? 0) + 5);

  const linearized = /\/Linearized\s/.test(text.slice(0, 2048));
  let revisionEnds = [...eofOffsets];
  // A linearized file has an extra %%EOF after the first-page section.
  if (linearized && revisionEnds.length > 1) revisionEnds = revisionEnds.slice(1);
  if (revisionEnds.length === 0) revisionEnds = [fileLength];

  const signatures: PdfSignatureInfo[] = [];
  for (const m of text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)) {
    const br = m.slice(1, 5).map(Number);
    const signedEnd = br[2] + br[3];
    const around = text.slice(Math.max(0, (m.index ?? 0) - 1500), (m.index ?? 0) + 1500);
    const subFilter = around.match(/\/SubFilter\s*\/([\w.]+)/)?.[1];
    const signer = around.match(/\/Name\s*\(((?:\\.|[^\\)])*)\)/)?.[1];
    const signedAt = around.match(/\/M\s*\(D:(\d{8,14})/)?.[1];
    // allow trailing whitespace after the final %%EOF
    const tail = text.slice(signedEnd).trim();
    signatures.push({
      byteRange: br,
      signedEnd,
      coversEnd: tail.length === 0,
      subFilter,
      signer: signer ? decodePdfString(signer) : undefined,
      signedAt,
    });
  }

  const producers: string[] = [];
  for (const m of text.matchAll(/\/Producer\s*\(((?:\\.|[^\\)])*)\)/g)) {
    const p = decodePdfString(m[1]);
    if (p && !producers.includes(p)) producers.push(p);
  }

  const encrypted = /\/Encrypt\s*\d+\s+\d+\s+R/.test(text) || /\/Encrypt\s*<</.test(text);

  // In encrypted files (e-Aadhaar) the raw strings are ciphertext — don't treat them as producer names.
  return { fileLength, eofOffsets, linearized, revisionEnds, signatures, producers: encrypted ? [] : producers, encrypted };
}

// ───────────────────────── Rendering & text ─────────────────────────

interface RenderedPage {
  page: PDFPageProxy;
  render: PageRender;
  scale: number;
  viewportTransform: number[];
  convertRect: (rect: number[]) => number[];
}

export async function renderPdfPage(
  doc: PDFDocumentProxy,
  pageNo: number,
  targetWidth: number,
  withAnnotations = true
): Promise<RenderedPage> {
  const pdfjs = await getPdfJs();
  const page = await doc.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const scale = targetWidth / base.width;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvasContext: ctx,
    viewport,
    // "print" intent renders without requestAnimationFrame, so analysis keeps running in a
    // background tab (display intent pauses until the tab is visible again).
    intent: "print",
    annotationMode: withAnnotations ? pdfjs.AnnotationMode.ENABLE : pdfjs.AnnotationMode.DISABLE,
  }).promise;
  return {
    page,
    render: { canvas, width: canvas.width, height: canvas.height },
    scale,
    viewportTransform: viewport.transform,
    convertRect: (rect: number[]) => viewport.convertToViewportRectangle(rect),
  };
}

interface FontInfo {
  id: string;
  name: string;
  base: string;
  subsetTag?: string;
  embedded: boolean;
}

export async function extractTextBoxes(rp: RenderedPage): Promise<{ boxes: TextBox[]; fonts: Map<string, FontInfo> }> {
  const pdfjs = await getPdfJs();
  const tc = await rp.page.getTextContent();
  const boxes: TextBox[] = [];
  const fonts = new Map<string, FontInfo>();

  for (const item of tc.items) {
    if (!("str" in item)) continue;
    const str = item.str;
    if (!str || !str.trim()) continue;
    const tx = pdfjs.Util.transform(rp.viewportTransform, item.transform) as number[];
    // skip rotated text
    if (Math.abs(tx[1]) > Math.abs(tx[0]) * 0.2) continue;
    const fontH = Math.hypot(tx[2], tx[3]);
    const w = item.width * rp.scale;
    boxes.push({
      str,
      x: tx[4],
      y: tx[5] - fontH * 0.8,
      w: Math.max(1, w),
      h: fontH,
      font: item.fontName,
      source: "pdf",
    });

    if (!fonts.has(item.fontName)) {
      let name = tc.styles?.[item.fontName]?.fontFamily ?? item.fontName;
      let embedded = true;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fo = (rp.page as any).commonObjs.get(item.fontName);
        if (fo?.name) name = String(fo.name);
        if (fo?.missingFile) embedded = false;
      } catch {
        /* font object not resolved — keep defaults */
      }
      const m = name.match(/^([A-Z]{6})\+(.+)$/);
      fonts.set(item.fontName, {
        id: item.fontName,
        name,
        base: (m ? m[2] : name).replace(/[,-](Bold|Italic|Regular|Oblique|BoldItalic|BoldMT|MT|PSMT|Roman)+$/i, ""),
        subsetTag: m?.[1],
        embedded,
      });
    }
  }
  return { boxes, fonts };
}

// ───────────────────────── Helpers ─────────────────────────

function luminanceData(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const lum = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    lum[j] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
  }
  return { lum, width, height };
}

function boxInk(lum: Uint8ClampedArray, width: number, height: number, b: TextBox) {
  const x0 = Math.max(0, Math.floor(b.x));
  const x1 = Math.min(width - 1, Math.ceil(b.x + b.w));
  const y0 = Math.max(0, Math.floor(b.y + b.h * 0.1));
  const y1 = Math.min(height - 1, Math.ceil(b.y + b.h * 0.95));
  if (x1 <= x0 || y1 <= y0) return { contrast: 255, count: 1 };
  let min = 255, max = 0;
  for (let y = y0; y <= y1; y++) {
    const row = y * width;
    for (let x = x0; x <= x1; x++) {
      const v = lum[row + x];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { contrast: max - min, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
}

function intersect(a: TextBox, b: TextBox) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y;
}

/** Characters of `under` that sit beneath `over` (proportional-width estimate),
 *  widened to whole words so a covered "72.67" isn't reported as "72.6". */
function coveredSubstring(under: TextBox, over: TextBox) {
  const n = under.str.length;
  if (n <= 1) return under.str.trim();
  let i0 = -1, i1 = -1;
  const edges = charEdges(under.str, under.x, under.w);
  for (let i = 0; i < n; i++) {
    const cx0 = edges[i], cx1 = edges[i + 1];
    const ov = Math.min(cx1, over.x + over.w) - Math.max(cx0, over.x);
    if (ov > (cx1 - cx0) * 0.4) {
      if (i0 < 0) i0 = i;
      i1 = i;
    }
  }
  if (i0 < 0) return under.str.trim();
  while (i0 > 0 && !/\s/.test(under.str[i0 - 1])) i0--;
  while (i1 < n - 1 && !/\s/.test(under.str[i1 + 1])) i1++;
  return under.str.slice(i0, i1 + 1).trim() || under.str.trim();
}

/** When a number replaced a number, report just the old number, not the label around it. */
function focusBefore(before: string, after: string) {
  if (/^[\d.,%/:-]+$/.test(after.trim())) {
    const nums = before.match(/\d[\d.,/:-]*/g);
    if (nums?.length) return nums[nums.length - 1].replace(/[.,:-]$/, "");
  }
  return before;
}

function normText(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

const INDIC_RE = /[ऀ-෿]/;

/** A covered character range of a text box and what is drawn there instead ("" = blank). */
interface CharEdit {
  i0: number;
  i1: number;
  text: string;
}

/** Characters of `under` that `over` sits on (proportional-width estimate), or null. */
function coveredRange(under: TextBox, over: TextBox, minShare = 0.4): { i0: number; i1: number } | null {
  const n = under.str.length;
  if (!n) return null;
  if (over.y > under.y + under.h * 0.85 || over.y + over.h < under.y + under.h * 0.15) return null;
  let i0 = -1, i1 = -1;
  const edges = charEdges(under.str, under.x, under.w);
  for (let i = 0; i < n; i++) {
    const cx0 = edges[i], cx1 = edges[i + 1];
    const ov = Math.min(cx1, over.x + over.w) - Math.max(cx0, over.x);
    if (ov > (cx1 - cx0) * minShare) {
      if (i0 < 0) i0 = i;
      i1 = i;
    }
  }
  return i0 < 0 ? null : { i0, i1 };
}

/** The whitespace-delimited words that overlap characters i0..i1. */
function wordsIn(s: string, i0: number, i1: number): { i0: number; i1: number }[] {
  const out: { i0: number; i1: number }[] = [];
  for (const m of s.matchAll(/\S+/g)) {
    const a = m.index ?? 0, b = a + m[0].length - 1;
    if (b >= i0 && a <= i1) out.push({ i0: a, i1: b });
  }
  return out;
}

/** The whitespace-delimited word that contains characters i0..i1. */
function wordAround(s: string, i0: number, i1: number): { i0: number; i1: number } | null {
  if (i0 < 0 || i1 >= s.length) return null;
  let a = i0, b = i1;
  while (a > 0 && !/\s/.test(s[a - 1])) a--;
  while (b < s.length - 1 && !/\s/.test(s[b + 1])) b++;
  return { i0: a, i1: b };
}

/** The string as it looks on the page after the edits (covered characters replaced). */
function applyEdits(s: string, edits: CharEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.i0 - b.i0);
  let out = "";
  let pos = 0;
  for (const e of sorted) {
    if (e.i0 < pos) continue;
    out += s.slice(pos, e.i0) + e.text;
    pos = e.i1 + 1;
  }
  return out + s.slice(pos);
}

/** What the word around `word` reads on the page after the edits. */
function visibleSlice(s: string, edits: CharEdit[], word: { i0: number; i1: number }): string {
  const mark = "\u0001";
  const marked = s.slice(0, word.i0) + mark + s.slice(word.i0, word.i1 + 1) + mark + s.slice(word.i1 + 1);
  const shifted = edits.map((e) => ({ ...e, i0: e.i0 + (e.i0 >= word.i0 ? 1 : 0) + (e.i0 > word.i1 ? 1 : 0), i1: e.i1 + (e.i1 >= word.i0 ? 1 : 0) + (e.i1 > word.i1 ? 1 : 0) }));
  const out = applyEdits(marked, shifted);
  const a = out.indexOf(mark), b = out.indexOf(mark, a + 1);
  return (a >= 0 && b > a ? out.slice(a + 1, b) : out).replace(/\s+/g, " ").trim();
}

function parsePdfDate(s?: string): Date | null {
  if (!s) return null;
  const m = s.match(/D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?/);
  if (!m) return null;
  const [, Y, Mo = "01", D = "01", h = "00", mi = "00", se = "00", sign, oh, om] = m;
  let iso = `${Y}-${Mo}-${D}T${h}:${mi}:${se}`;
  if (sign === "Z") iso += "Z";
  else if (sign && oh) iso += `${sign}${oh}:${om ?? "00"}`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

export const PDF_EDITOR_RE =
  /ilovepdf|smallpdf|sejda|pdfescape|pdf ?candy|pdf24|soda ?pdf|pdffiller|dochub|xodo|pdf-?xchange|phantompdf|foxit pdf editor|nitro|pdfelement|wondershare|pdf expert|pdf2go|hipdf|easepdf|online2pdf|pdf editor|canva|photoshop|gimp|picsart|inkscape|illustrator|coreldraw|photopea/i;
export const REPRINT_RE =
  /skia\/pdf|chrome|chromium|quartz pdfcontext|mac os x .*quartz|microsoft: print to pdf|microsoft print to pdf|cups|ghostscript|cairo|libreoffice|openoffice|microsoft.{0,10}word|wps|google docs/i;

// ───────────────────────── Main analysis ─────────────────────────

export interface PdfAnalysis {
  /** where embedded images (logos, photos, QR codes) are drawn on page 1, in render pixels */
  imageRects: { x: number; y: number; w: number; h: number }[];
  render: PageRender;
  /** page-1 text as it looks on the page (covered characters replaced, hidden text removed) */
  textBoxes: TextBox[];
  /** page-1 text layer exactly as stored in the file */
  rawTextBoxes: TextBox[];
  evidence: Evidence[];
  layers: TamperLayer[];
  checks: CheckRun[];
  numPages: number;
  isScanned: boolean;
  docText: string;
  structure: PdfStructure;
  meta: { producer?: string; creator?: string; created?: string; modified?: string };
  doc: PDFDocumentProxy;
}

export const ANALYSIS_WIDTH = 1400;

export async function analyzePdf(
  bytes: Uint8Array,
  password: string | undefined,
  progress: (msg: string) => void
): Promise<PdfAnalysis> {
  const evidence: Evidence[] = [];
  const layers: TamperLayer[] = [];
  const checks: CheckRun[] = [];
  let eid = 0;
  const ev = (e: Omit<Evidence, "id">) => evidence.push({ id: `pdf-${eid++}`, ...e });

  progress("Reading PDF structure");
  const structure = scanStructure(bytes);

  const doc = await openPdf(bytes, password);
  const numPages = doc.numPages;

  progress("Rendering page 1");
  const final = await renderPdfPage(doc, 1, ANALYSIS_WIDTH, true);
  const { width: W, height: H } = final.render;
  const grid = new TamperGrid(W, H);

  progress("Reading text layer");
  const { boxes, fonts } = await extractTextBoxes(final);
  const docTextParts: string[] = [];
  for (let p = 2; p <= Math.min(numPages, 3); p++) {
    try {
      const pg = await doc.getPage(p);
      const tc = await pg.getTextContent();
      docTextParts.push(tc.items.map((i) => ("str" in i ? i.str : "")).join(" "));
    } catch {
      /* ignore */
    }
  }
  const otherPagesText = docTextParts.join("\n");
  const isScanned = boxes.length < 5;

  // ── 1. Metadata ──
  progress("Checking metadata");
  let meta: PdfAnalysis["meta"] = {};
  try {
    const md = await doc.getMetadata();
    const info = (md.info ?? {}) as Record<string, string>;
    const xmpProducer = md.metadata?.get("pdf:producer") as string | undefined;
    const xmpTool = md.metadata?.get("xmp:creatortool") as string | undefined;
    meta = {
      producer: info.Producer || xmpProducer,
      creator: info.Creator || xmpTool,
      created: info.CreationDate,
      modified: info.ModDate,
    };
    const tools = [info.Producer, info.Creator, xmpProducer, xmpTool, ...structure.producers].filter(Boolean) as string[];
    const editor = tools.find((t) => PDF_EDITOR_RE.test(t));
    const reprint = tools.find((t) => REPRINT_RE.test(t));
    if (editor) {
      ev({
        category: "metadata",
        severity: "warning",
        title: "Saved by an editing tool",
        detail: `The file records "${editor}". Official e-documents (e-Aadhaar, DigiLocker, university portals) are produced by the issuer's own system, not by PDF/photo editors.`,
      });
    } else if (reprint) {
      ev({
        category: "metadata",
        severity: "warning",
        title: "Not the issuer's original file",
        detail: `The PDF was re-created by "${reprint}" (printed to PDF, exported or retyped). The issuer's original structure and signatures are gone, so it can't be trusted as an original.`,
      });
    }
    if (structure.producers.length > 1) {
      ev({
        category: "metadata",
        severity: "warning",
        title: "Saved by more than one program",
        detail: `Different programs wrote this file: ${structure.producers.map((p) => `"${p}"`).join(" → ")}.`,
      });
    }
    if (info.Producer && xmpProducer && normText(info.Producer) !== normText(xmpProducer)) {
      ev({
        category: "metadata",
        severity: "warning",
        title: "Metadata copies disagree",
        detail: `Document info says "${info.Producer}" but XMP metadata says "${xmpProducer}" — a tool changed one copy and not the other.`,
      });
    }
    const c = parsePdfDate(info.CreationDate);
    const m = parsePdfDate(info.ModDate);
    if (c && m && m.getTime() - c.getTime() > 2 * 60 * 1000) {
      ev({
        category: "metadata",
        severity: "info",
        title: "Modified after it was created",
        detail: `Created ${c.toLocaleString()}, last modified ${m.toLocaleString()}.`,
      });
    }
    checks.push({ id: "pdf-meta", label: "PDF metadata", status: editor || reprint ? "flag" : "pass" });
  } catch {
    checks.push({ id: "pdf-meta", label: "PDF metadata", status: "skip", note: "unreadable" });
  }

  // Visible-text model: covered character ranges per text box, and boxes merged into the
  // text they were drawn over. Filled by the text-layer and annotation checks below.
  const edits = new Map<number, CharEdit[]>();
  const consumed = new Set<number>();
  const addEdit = (i: number, e: CharEdit) => {
    if (!edits.has(i)) edits.set(i, []);
    edits.get(i)!.push(e);
  };

  // ── 2. Text layer: overlapping strings and hidden text ──
  // Every finding here also edits the "visible text" model: what a person actually sees on the
  // page. Aadhaar and marksheet checks read the visible text, not the raw text layer.
  progress("Looking for hidden or overlapping text");
  const textLayerGrid = TamperGrid.like(grid);
  let textFlags = 0;
  if (!isScanned) {
    const { lum } = luminanceData(final.render.canvas);
    const reported = new Set<string>();
    // one finding per overlaid text: it may cover several words of the original
    const byOver = new Map<number, Evidence>();
    // Latin letters/digits only: Indic scripts (Hindi on Aadhaar) are often extracted as
    // overlapping glyph clusters, which is not an edit. A box that mixes Hindi and Latin
    // ("जन्म तारीख/DOB: 01/01/1990") is checked on the part that was covered.
    const latin = (t: string) => /[A-Za-z0-9]{2,}|^\s*\d\s*$/.test(t) && !INDIC_RE.test(t);
    const hasLatin = (t: string) => /[A-Za-z0-9]/.test(t);
    for (let a = 0; a < boxes.length; a++) {
      const A = boxes[a];
      if (!hasLatin(A.str)) continue;
      for (let b = a + 1; b < boxes.length; b++) {
        const B = boxes[b];
        if (!latin(B.str)) continue;
        if (B.y > A.y + A.h || A.y > B.y + B.h) continue;
        const inter = intersect(A, B);
        if (inter <= 0) continue;
        const minArea = Math.min(A.w * A.h, B.w * B.h);
        if (inter / minArea < 0.45) continue;
        const sa = normText(A.str), sb = normText(B.str);
        if (sa === sb) continue; // fake-bold / shadow text draws the same string twice
        const cov0 = coveredRange(A, B);
        if (!cov0) continue;
        // a retyped value usually covers almost all of the old word — take the whole word
        const cov = { ...cov0 };
        for (const wd of wordsIn(A.str, cov0.i0, cov0.i1)) {
          const covered = Math.min(cov0.i1, wd.i1) - Math.max(cov0.i0, wd.i0) + 1;
          if (covered / (wd.i1 - wd.i0 + 1) >= 0.6) {
            cov.i0 = Math.min(cov.i0, wd.i0);
            cov.i1 = Math.max(cov.i1, wd.i1);
          }
        }
        const coveredStr = A.str.slice(cov.i0, cov.i1 + 1).trim();
        if (!latin(A.str) && !/^[A-Za-z0-9.,/:%-]+$/.test(coveredStr)) continue;
        if (sa.includes(sb) && A.w * A.h > B.w * B.h * 3 && coveredSubstring(A, B) === sb) continue;
        if (coveredStr === sb) continue; // same characters drawn twice (bold / outline)
        // later-drawn (b) sits on top of earlier (a)
        const after = sb;
        const before = focusBefore(coveredSubstring(A, B), after);
        const key = `${before}|${after}|${Math.round(B.x)}|${Math.round(B.y)}`;
        if (reported.has(key)) continue;
        reported.add(key);
        // the same overlaid text over a further word: blank that word, extend the first finding
        const prior = byOver.get(b);
        if (prior) {
          addEdit(a, { i0: cov.i0, i1: cov.i1, text: "" });
          const w2 = A.str.slice(cov.i0, cov.i1 + 1).trim();
          if (prior.change) prior.change.before = `${prior.change.before} ${w2}`.trim();
          prior.detail = prior.detail.replace(/^The file still contains "([^"]*)"/, (_m, w) => `The file still contains "${w} ${w2}"`);
          const r = prior.regions?.[0];
          if (r) {
            const x1 = Math.max(r.x + r.w, (A.x + A.w) / W), y1 = Math.max(r.y + r.h, (A.y + A.h) / H);
            r.x = Math.min(r.x, A.x / W);
            r.y = Math.min(r.y, A.y / H);
            r.w = x1 - r.x;
            r.h = y1 - r.y;
            r.label = `${prior.change?.before} → ${prior.change?.after}`;
          }
          textLayerGrid.markRect(A.x, A.y, A.w, A.h, 1);
          continue;
        }
        textFlags++;
        const edit = { i0: cov.i0, i1: cov.i1, text: B.str };
        addEdit(a, edit);
        consumed.add(b);
        const word = wordAround(A.str, cov.i0, cov.i1) ?? { i0: cov.i0, i1: cov.i1 };
        const shownBefore = A.str.slice(word.i0, word.i1 + 1).trim() || before;
        const visibleWord = visibleSlice(A.str, [edit], word) || after;
        const rx = Math.min(A.x, B.x), ry = Math.min(A.y, B.y);
        const rw = Math.max(A.x + A.w, B.x + B.w) - rx, rh = Math.max(A.y + A.h, B.y + B.h) - ry;
        textLayerGrid.markRect(rx, ry, rw, rh, 1);
        ev({
          category: "pdf-text",
          severity: "critical",
          title: "Text written over other text",
          detail: `The file still contains "${shownBefore}" underneath, with "${after}" drawn on top of it at the same spot${visibleWord !== after ? ` — the page now shows "${visibleWord}"` : ""}. Editors do this when they cover old text and type new text.`,
          regions: [pxToRegion(rx, ry, rw, rh, W, H, `${shownBefore} → ${visibleWord}`)],
          layerId: "pdf-text",
          change: { before: shownBefore, after: visibleWord },
        });
        byOver.set(b, evidence[evidence.length - 1]);
      }
    }
    // Hidden: text present in the file but not visible on the page
    const hidden: { b: TextBox; i: number }[] = [];
    boxes.forEach((b, i) => {
      if (b.w < 2 || b.h < 4 || !latin(b.str) || consumed.has(i)) return;
      const ink = boxInk(lum, W, H, b);
      if (ink.contrast < 18) hidden.push({ b, i });
    });
    const hiddenRatio = hidden.length / Math.max(1, boxes.length);
    if (hidden.length > 0 && hiddenRatio < 0.5) {
      for (const { b, i } of hidden.slice(0, 12)) {
        textFlags++;
        addEdit(i, { i0: 0, i1: b.str.length - 1, text: "" });
        textLayerGrid.markRect(b.x, b.y, b.w, b.h, 0.95);
        ev({
          category: "pdf-text",
          severity: "critical",
          title: "Hidden text found",
          detail: `"${normText(b.str)}" is in the file but can't be seen on the page — something was drawn over it (for example a white box).`,
          regions: [pxToRegion(b.x, b.y, b.w, b.h, W, H, `hidden: ${normText(b.str)}`)],
          layerId: "pdf-text",
          change: { before: normText(b.str), after: "(covered)" },
        });
      }
    }
    // Partly hidden: some digits of a visible number or date have no ink (a small white box over them)
    if (hiddenRatio < 0.5) {
      boxes.forEach((b, i) => {
        if (consumed.has(i) || edits.has(i) || b.h < 6 || b.w < 8) return;
        const s = b.str;
        if (!/\d/.test(s) || s.length < 4) return;
        if (boxInk(lum, W, H, b).contrast < 60) return;
        const edges = charEdges(s, b.x, b.w);
        let run0 = -1;
        let best: { i0: number; i1: number } | null = null;
        for (let c = 0; c <= s.length; c++) {
          const isDigit = c < s.length && /\d/.test(s[c]);
          const cw = c < s.length ? edges[c + 1] - edges[c] : 0;
          const blank = isDigit && boxInk(lum, W, H, { ...b, x: edges[c] + cw * 0.2, w: cw * 0.6 }).contrast < 14;
          if (blank) {
            if (run0 < 0) run0 = c;
          } else {
            if (run0 >= 0 && c - run0 >= 2 && (!best || c - 1 - run0 > best.i1 - best.i0)) best = { i0: run0, i1: c - 1 };
            run0 = -1;
          }
        }
        if (!best) return;
        textFlags++;
        const edit = { i0: best.i0, i1: best.i1, text: "" };
        addEdit(i, edit);
        const gone = s.slice(best.i0, best.i1 + 1);
        const rx = edges[best.i0], rw = edges[best.i1 + 1] - edges[best.i0];
        textLayerGrid.markRect(rx, b.y, rw, b.h, 0.95);
        ev({
          category: "pdf-text",
          severity: "critical",
          title: "Part of the text is covered",
          detail: `The file says "${normText(s)}", but the digits "${gone}" can't be seen on the page — they were covered (for example with a white box).`,
          regions: [pxToRegion(rx, b.y, rw, b.h, W, H, `covered: ${gone}`)],
          layerId: "pdf-text",
          change: { before: normText(s), after: normText(applyEdits(s, [edit])) || "(covered)" },
        });
      });
    }
    checks.push({ id: "pdf-text", label: "Hidden / overlapping text", status: textFlags ? "flag" : "pass" });
  } else {
    checks.push({ id: "pdf-text", label: "Hidden / overlapping text", status: "skip", note: "scanned page" });
  }
  if (textLayerGrid.max() > 0) {
    layers.push({
      id: "pdf-text",
      label: "Covered text",
      color: "#FF3131",
      description: "Text hidden under other content, or two different texts at one spot",
      grid: textLayerGrid.data,
      critical: true,
      strength: textLayerGrid.max(),
    });
  }

  // ── 3. Annotations used as edits ──
  progress("Checking annotations");
  try {
    const annots = await final.page.getAnnotations();
    const editLike = annots.filter((a: { subtype?: string }) =>
      ["FreeText", "Square", "Circle", "Stamp", "Ink", "Polygon", "Redact", "Caret"].includes(a.subtype ?? "")
    );
    const widgets = annots.filter((a: { subtype?: string; fieldType?: string }) => a.subtype === "Widget" && a.fieldType !== "Sig");
    const annotGrid = TamperGrid.like(grid);
    type Annot = { subtype: string; rect: number[]; contentsObj?: { str?: string } };
    const placed = (editLike as Annot[]).map((a) => {
      const [x1, y1, x2, y2] = final.convertRect(a.rect);
      const r = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
      // which characters of which text boxes this annotation sits on
      const hits: { i: number; i0: number; i1: number }[] = [];
      if (r.w * r.h < W * H * 0.05) {
        boxes.forEach((b, i) => {
          if (consumed.has(i)) return;
          const cov = coveredRange(b, { str: "", ...r, source: "pdf" }, 0.6);
          if (cov && /\S/.test(b.str.slice(cov.i0, cov.i1 + 1))) hits.push({ i, ...cov });
        });
      }
      return { a, r, hits, text: (a.contentsObj?.str ?? "").trim() };
    });
    // A text annotation and a white box at the same spot are one edit: the box hides, the text replaces.
    for (const p of placed) {
      annotGrid.markRect(p.r.x, p.r.y, p.r.w, p.r.h, 0.9);
      const replaces = p.a.subtype === "FreeText" ? p.text : "";
      const covers = ["FreeText", "Square", "Stamp", "Redact"].includes(p.a.subtype);
      if (covers)
        for (const h of p.hits) {
          const has = edits.get(h.i)?.find((e) => e.i0 <= h.i1 && h.i0 <= e.i1);
          if (has) {
            if (replaces) has.text = replaces;
          } else addEdit(h.i, { i0: h.i0, i1: h.i1, text: replaces });
        }
    }
    for (const p of placed) {
      const { a, r, hits } = p;
      const twin = placed.find((q) => q !== p && intersect({ str: "", ...q.r, source: "pdf" }, { str: "", ...r, source: "pdf" }) > Math.min(q.r.w * q.r.h, r.w * r.h) * 0.5);
      if (twin && a.subtype !== "FreeText" && twin.a.subtype === "FreeText" && twin.hits.length) continue; // reported with its text
      if (hits.length) {
        const h = hits[0];
        const b = boxes[h.i];
        const word = wordAround(b.str, h.i0, h.i1) ?? { i0: h.i0, i1: h.i1 };
        const before = b.str.slice(word.i0, word.i1 + 1).trim();
        const afterWord = visibleSlice(b.str, edits.get(h.i) ?? [], word);
        const shown = p.text || twin?.text;
        ev({
          category: "pdf-structure",
          severity: "critical",
          title: "Annotation placed over existing text",
          detail: `A ${a.subtype}${twin ? ` and a ${twin.a.subtype}` : ""} annotation sit on "${before}"${shown ? ` and show "${shown}" instead` : ""} — the page now reads "${afterWord || "(blank)"}", while the file's own text still says "${before}". Online PDF editors make edits this way.`,
          regions: [pxToRegion(r.x - 2, r.y - 2, r.w + 4, r.h + 4, W, H, `${before} → ${afterWord || "∅"}`)],
          layerId: "pdf-annot",
          change: { before, after: afterWord || "(covered)" },
        });
      } else {
        ev({
          category: "pdf-structure",
          severity: "warning",
          title: "Content added as an annotation",
          detail: `A ${a.subtype} annotation${p.text ? ` showing "${p.text}"` : ""} was added on top of the page — online PDF editors add text and white-out boxes this way.`,
          regions: [pxToRegion(r.x, r.y, r.w, r.h, W, H, a.subtype)],
          layerId: "pdf-annot",
        });
      }
    }
    if (widgets.length) {
      ev({
        category: "pdf-structure",
        severity: "info",
        title: "Fillable form fields",
        detail: `${widgets.length} form field(s) — values in form fields can be typed by anyone.`,
      });
    }
    if (annotGrid.max() > 0) {
      layers.push({
        id: "pdf-annot",
        label: "Annotations",
        color: "#FF6B35",
        description: "Boxes and text placed on top of the page by an editor",
        grid: annotGrid.data,
        critical: true,
        strength: annotGrid.max(),
      });
    }
    checks.push({ id: "pdf-annot", label: "Edit annotations", status: editLike.length ? "flag" : "pass" });
  } catch {
    checks.push({ id: "pdf-annot", label: "Edit annotations", status: "skip" });
  }

  // ── 4. Fonts ──
  progress("Comparing fonts");
  if (!isScanned && fonts.size > 0) {
    const fontGrid = TamperGrid.like(grid);
    let fontFlags = 0;
    const usage = new Map<string, TextBox[]>();
    for (const b of boxes) {
      const k = b.font ?? "?";
      if (!usage.has(k)) usage.set(k, []);
      usage.get(k)!.push(b);
    }
    const totalChars = boxes.reduce((s, b) => s + b.str.length, 0);
    const medianH = [...boxes.map((b) => b.h)].sort((a, b) => a - b)[boxes.length >> 1] ?? 0;
    // the very same font (same name, weight and style) embedded under different subset tags —
    // Regular and Bold of one family are different fonts and are not compared
    const byBase = new Map<string, FontInfo[]>();
    for (const f of fonts.values()) {
      if (!f.subsetTag) continue;
      const k = f.name.replace(/^[A-Z]{6}\+/, "").toLowerCase();
      if (!byBase.has(k)) byBase.set(k, []);
      byBase.get(k)!.push(f);
    }
    for (const [base, list] of byBase) {
      const tags = new Set(list.map((f) => f.subsetTag));
      if (tags.size < 2) continue;
      const sorted = [...list].sort((a, b) => (usage.get(a.id)?.length ?? 0) - (usage.get(b.id)?.length ?? 0));
      const minority = sorted[0];
      const mBoxes = usage.get(minority.id) ?? [];
      if (!mBoxes.length) continue;
      // Generators sometimes embed a font once per section; an edit adds a *small* extra copy.
      if (mBoxes.length > Math.max(5, boxes.length * 0.15)) continue;
      fontFlags++;
      for (const b of mBoxes) fontGrid.markRect(b.x, b.y, b.w, b.h, 0.85);
      ev({
        category: "pdf-font",
        severity: "warning",
        title: "Same font embedded twice",
        detail: `"${base}" is embedded as ${tags.size} separate copies (${[...tags].join(", ")}). Text in the extra copy — "${mBoxes.slice(0, 4).map((b) => normText(b.str)).join('", "')}" — was most likely added later by another program.`,
        regions: mBoxes.slice(0, 6).map((b) => pxToRegion(b.x, b.y, b.w, b.h, W, H, normText(b.str))),
        layerId: "pdf-font",
      });
    }
    // non-embedded font mixed into an embedded document, or a font used for very little
    const embeddedChars = boxes.filter((b) => fonts.get(b.font ?? "")?.embedded).reduce((s, b) => s + b.str.length, 0);
    for (const [fid, list] of usage) {
      const f = fonts.get(fid);
      if (!f) continue;
      const chars = list.reduce((s, b) => s + b.str.length, 0);
      const share = chars / Math.max(1, totalChars);
      const digitsOnly = list.every((b) => /^[\d\s.,/%:-]+$/.test(b.str));
      if (!f.embedded && embeddedChars / Math.max(1, totalChars) > 0.6 && share < 0.15) {
        fontFlags++;
        for (const b of list) fontGrid.markRect(b.x, b.y, b.w, b.h, 0.8);
        ev({
          category: "pdf-font",
          severity: "warning",
          title: "Text in a different, non-embedded font",
          detail: `Most of the page uses embedded fonts, but "${list.slice(0, 4).map((b) => normText(b.str)).join('", "')}" uses "${f.name}", which isn't embedded — this is how editors typically add new text.`,
          regions: list.slice(0, 6).map((b) => pxToRegion(b.x, b.y, b.w, b.h, W, H, normText(b.str))),
          layerId: "pdf-font",
        });
      } else if (
        boxes.length >= 15 &&
        list.length <= 2 &&
        digitsOnly &&
        share < 0.05 &&
        // not an ID number / heading printed big on purpose, not a page number in the margin
        list.every((b) => b.h < medianH * 1.3 && b.str.replace(/\D/g, "").length < 10 && b.y > H * 0.05 && b.y + b.h < H * 0.94)
      ) {
        fontFlags++;
        for (const b of list) fontGrid.markRect(b.x, b.y, b.w, b.h, 0.75);
        ev({
          category: "pdf-font",
          severity: "warning",
          title: "A number in its own font",
          detail: `"${list.map((b) => normText(b.str)).join('", "')}" is the only text set in "${f.name}". Numbers typed in later often end up in a separate font.`,
          regions: list.map((b) => pxToRegion(b.x, b.y, b.w, b.h, W, H, normText(b.str))),
          layerId: "pdf-font",
        });
      }
    }
    if (fontGrid.max() > 0) {
      layers.push({
        id: "pdf-font",
        label: "Font mismatch",
        color: "#FFB800",
        description: "Text set in a font that doesn't match the rest of the document",
        grid: fontGrid.data,
        critical: false,
        strength: fontGrid.max(),
      });
    }
    checks.push({ id: "pdf-font", label: "Font consistency", status: fontFlags ? "flag" : "pass", note: `${fonts.size} fonts` });
  } else {
    checks.push({ id: "pdf-font", label: "Font consistency", status: "skip" });
  }

  // ── 5. Revisions: recover the older version inside the file ──
  // Signed files (e-Aadhaar, DigiLocker) get their signature in a later save — that's normal.
  // - last signature covers the whole file → everything before it was signed: nothing to diff
  // - last signature doesn't reach the end → diff the signed version against the final one
  // - no signature → diff the oldest version against the final one
  const lastSig = [...structure.signatures].sort((a, b) => b.signedEnd - a.signedEnd)[0];
  let target: number | null = null;
  if (lastSig) {
    if (!lastSig.coversEnd && lastSig.signedEnd > 200 && lastSig.signedEnd < bytes.length - 10) target = lastSig.signedEnd;
  } else {
    const prevEnds = structure.revisionEnds.slice(0, -1).filter((e) => e > 200 && e < bytes.length - 10);
    if (prevEnds.length) target = prevEnds[0]; // the oldest version = closest to the original
  }
  let postSignatureUnchanged = false;
  if (target !== null) {
    progress("Recovering the earlier version hidden inside the file");
    try {
      const oldDoc = await openPdf(bytes.slice(0, target), password);
      const old = await renderPdfPage(oldDoc, 1, ANALYSIS_WIDTH, true);
      const diff = diffRenders(old.render.canvas, final.render.canvas, grid);
      const { boxes: oldBoxes } = await extractTextBoxes(old);
      let changes = diffText(oldBoxes, boxes);
      // Signature boxes may be redrawn after signing (validity marks) — never count those as edits.
      try {
        const sigRects = (await final.page.getAnnotations())
          .filter((a: { subtype?: string; fieldType?: string }) => a.subtype === "Widget" && a.fieldType === "Sig")
          .map((a: { rect: number[] }) => {
            const [x1, y1, x2, y2] = final.convertRect(a.rect);
            return { x: Math.min(x1, x2) - 4, y: Math.min(y1, y2) - 4, w: Math.abs(x2 - x1) + 8, h: Math.abs(y2 - y1) + 8 };
          });
        if (sigRects.length) {
          const inSig = (x: number, y: number) => sigRects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
          for (let k = 0; k < diff.grid.data.length; k++) {
            const cx = ((k % diff.grid.cols) + 0.5) * diff.grid.cellW, cy = (Math.floor(k / diff.grid.cols) + 0.5) * diff.grid.cellH;
            if (diff.grid.data[k] > 0 && inSig(cx, cy)) {
              diff.grid.data[k] = 0;
              diff.changedCells--;
            }
          }
          changes = changes.filter((c) => !inSig(c.x + c.w / 2, c.y + c.h / 2));
        }
      } catch {
        /* annotations unavailable */
      }
      const signedAt = lastSig && lastSig.signedEnd === target ? lastSig : undefined;
      if (diff.changedCells > 0 || changes.length > 0) {
        layers.push({
          id: "pdf-revision",
          label: "Changed between saves",
          color: "#FF00E5",
          description: "Pixels that differ between the earlier version hidden in the file and the final version",
          grid: diff.grid.data,
          critical: true,
          strength: diff.grid.max(),
        });
        const regions = diff.grid.regions(0.35).slice(0, 8);
        for (const c of changes.slice(0, 8)) {
          ev({
            category: "pdf-structure",
            severity: "critical",
            title: signedAt ? "Changed after it was signed" : "Earlier version found inside the file",
            detail: `${signedAt ? "After the digital signature was applied, " : "In a later save, "}"${c.before || "(nothing)"}" was changed to "${c.after || "(removed)"}".`,
            regions: [pxToRegion(c.x, c.y, c.w, c.h, W, H, `${c.before || "∅"} → ${c.after || "∅"}`)],
            layerId: "pdf-revision",
            change: { before: c.before, after: c.after },
          });
        }
        if (!changes.length) {
          ev({
            category: "pdf-structure",
            severity: "critical",
            title: signedAt ? "Changed after it was signed" : "Earlier version found inside the file",
            detail: `The file keeps an older version of page 1, and ${regions.length} area(s) look different in the final version.`,
            regions,
            layerId: "pdf-revision",
          });
        }
      } else {
        if (signedAt) postSignatureUnchanged = true;
        ev({
          category: "pdf-structure",
          severity: "info",
          title: "Saved more than once — no visible change",
          detail: `The file was saved ${structure.revisionEnds.length} times, but the earlier version of page 1 looks identical (typical of signing or metadata updates).`,
        });
      }
      checks.push({ id: "pdf-rev", label: "Hidden earlier versions", status: diff.changedCells || changes.length ? "flag" : "pass", note: `${structure.revisionEnds.length} saves` });
      await oldDoc.destroy();
    } catch {
      checks.push({ id: "pdf-rev", label: "Hidden earlier versions", status: "skip", note: "older version unreadable" });
    }
  } else {
    checks.push({
      id: "pdf-rev",
      label: "Hidden earlier versions",
      status: "pass",
      note: lastSig ? "signed — nothing added after signing" : structure.revisionEnds.length > 1 ? `${structure.revisionEnds.length} saves` : "single save",
    });
  }

  // ── 6. Signatures ──
  if (structure.signatures.length) {
    const after = structure.signatures.filter((s) => !s.coversEnd);
    const sigLabel = structure.signatures.map((s) => s.signer).filter(Boolean).join(", ");
    if (after.length === 0) {
      ev({
        category: "pdf-structure",
        severity: "pass",
        title: "Digitally signed, nothing added after signing",
        detail: `Signature${sigLabel ? ` by ${sigLabel}` : ""} covers the whole file. (The signer's certificate isn't checked in this version.)`,
      });
    } else if (postSignatureUnchanged) {
      ev({
        category: "pdf-structure",
        severity: "info",
        title: "Validation data added after signing — page unchanged",
        detail: `Something was appended after the digital signature${sigLabel ? ` (${sigLabel})` : ""}, but the page looks exactly like the signed version and its text is identical. Signing services often add certificate/timestamp data this way.`,
      });
    } else if (!evidence.some((e) => e.title === "Changed after it was signed")) {
      ev({
        category: "pdf-structure",
        severity: "warning",
        title: "Data added after signing",
        detail: `The file was extended after its digital signature${sigLabel ? ` (${sigLabel})` : ""}. Page 1 may look unchanged, but the signed version is not the final one.`,
      });
    }
    checks.push({ id: "pdf-sig", label: "Digital signature", status: after.length ? "flag" : "pass" });
  } else {
    checks.push({ id: "pdf-sig", label: "Digital signature", status: "skip", note: "not signed" });
  }

  // ── Where images are drawn (so pixel checks don't mistake a logo's white box for a white-out) ──
  const imageRects: PdfAnalysis["imageRects"] = [];
  try {
    const pdfjs = await getPdfJs();
    const OPS = pdfjs.OPS;
    const ol = await final.page.getOperatorList();
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack: number[][] = [];
    for (let i = 0; i < ol.fnArray.length; i++) {
      const fn = ol.fnArray[i];
      const args = ol.argsArray[i];
      if (fn === OPS.save) stack.push(ctm.slice());
      else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.transform) ctm = pdfjs.Util.transform(ctm, args) as number[];
      else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(ctm.slice());
        if (Array.isArray(args?.[0]) && args[0].length === 6) ctm = pdfjs.Util.transform(ctm, args[0]) as number[];
      } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
        const m = pdfjs.Util.transform(final.viewportTransform, ctm) as number[];
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => pdfjs.Util.applyTransform([x, y], m) as number[]);
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const r = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        if (r.w > 4 && r.h > 4 && r.w * r.h < W * H * 0.9) imageRects.push(r);
      }
    }
  } catch {
    /* operator list unavailable — no exclusions */
  }

  // ── What a person sees: covered characters replaced, hidden text dropped ──
  const visibleBoxes: TextBox[] = [];
  boxes.forEach((b, i) => {
    if (consumed.has(i)) return;
    const e = edits.get(i);
    if (!e) return visibleBoxes.push(b);
    const str = applyEdits(b.str, e);
    if (str.trim()) visibleBoxes.push({ ...b, str });
  });
  const docText = [linesText(buildLines(visibleBoxes)), otherPagesText].filter(Boolean).join("\n");

  return {
    imageRects,
    render: final.render,
    textBoxes: visibleBoxes,
    rawTextBoxes: boxes,
    evidence,
    layers,
    checks,
    numPages,
    isScanned,
    docText,
    structure,
    meta,
    doc,
  };
}

function diffRenders(a: HTMLCanvasElement, b: HTMLCanvasElement, like: TamperGrid) {
  const W = b.width, H = b.height;
  let aCanvas = a;
  if (a.width !== W || a.height !== H) {
    aCanvas = document.createElement("canvas");
    aCanvas.width = W;
    aCanvas.height = H;
    aCanvas.getContext("2d")!.drawImage(a, 0, 0, W, H);
  }
  const A = luminanceData(aCanvas).lum;
  const B = luminanceData(b).lum;
  const g = TamperGrid.like(like);
  const counts = new Float32Array(g.data.length);
  for (let y = 0; y < H; y++) {
    const r = Math.min(g.rows - 1, Math.floor(y / g.cellH));
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (Math.abs(A[i] - B[i]) > 48) {
        const c = Math.min(g.cols - 1, Math.floor(x / g.cellW));
        counts[r * g.cols + c]++;
      }
    }
  }
  const cellArea = g.cellW * g.cellH;
  let changedCells = 0;
  for (let i = 0; i < counts.length; i++) {
    const f = counts[i] / cellArea;
    if (f > 0.004) {
      g.data[i] = Math.min(1, 0.5 + f * 10);
      changedCells++;
    }
  }
  return { grid: g, changedCells };
}

interface TextChange {
  before: string;
  after: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function diffText(oldBoxes: TextBox[], newBoxes: TextBox[]): TextChange[] {
  const out: TextChange[] = [];
  const usedNew = new Set<number>();
  const key = (b: TextBox) => normText(b.str);
  // exact matches at the same place are unchanged
  const unmatchedOld: TextBox[] = [];
  for (const o of oldBoxes) {
    const j = newBoxes.findIndex((n, idx) => !usedNew.has(idx) && key(n) === key(o) && Math.abs(n.x - o.x) < 3 && Math.abs(n.y - o.y) < 3);
    if (j >= 0) usedNew.add(j);
    else unmatchedOld.push(o);
  }
  const unmatchedNew = newBoxes.filter((_, i) => !usedNew.has(i));
  for (const o of unmatchedOld) {
    // the replacement is the unmatched new box overlapping the old one most
    let best = -1, bestOv = 0;
    unmatchedNew.forEach((n, i) => {
      const ov = intersect(o, n) / Math.max(1, Math.min(o.w * o.h, n.w * n.h));
      if (ov > bestOv) { bestOv = ov; best = i; }
    });
    if (best >= 0 && bestOv > 0.3) {
      const n = unmatchedNew.splice(best, 1)[0];
      if (key(n) !== key(o)) {
        out.push({ before: key(o), after: key(n), x: Math.min(o.x, n.x), y: Math.min(o.y, n.y), w: Math.max(o.x + o.w, n.x + n.w) - Math.min(o.x, n.x), h: Math.max(o.y + o.h, n.y + n.h) - Math.min(o.y, n.y) });
      }
    } else {
      // Old text still present in the new file under a cover is found by the hidden-text check
      const stillThere = newBoxes.some((n) => key(n) === key(o) && intersect(o, n) > 0);
      if (!stillThere) out.push({ before: key(o), after: "", x: o.x, y: o.y, w: o.w, h: o.h });
    }
  }
  for (const n of unmatchedNew) {
    // new text drawn over an old text that's still in the file
    const under = oldBoxes.find((o) => intersect(o, n) > Math.min(o.w * o.h, n.w * n.h) * 0.3 && key(o) !== key(n));
    out.push({ before: under ? focusBefore(coveredSubstring(under, n), key(n)) : "", after: key(n), x: n.x, y: n.y, w: n.w, h: n.h });
  }
  return out;
}

export type { Region };
