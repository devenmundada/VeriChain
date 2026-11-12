/**
 * Shared types for the VeriChain "Tamper Map" engine.
 *
 * Every detector produces Evidence (plain-language findings) and/or a
 * TamperLayer (per-cell scores on one shared grid laid over page 1).
 * The fusion step turns them into one verdict and one heatmap.
 */

export type Severity = "critical" | "warning" | "info" | "pass";

export type EvidenceCategory =
  | "pdf-structure"
  | "pdf-text"
  | "pdf-font"
  | "metadata"
  | "pixel"
  | "qr"
  | "aadhaar"
  | "marksheet"
  | "glyph"
  | "registry";

/** Normalised rectangle on page 1 (0..1 of width/height). */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
}

export interface Evidence {
  id: string;
  category: EvidenceCategory;
  severity: Severity;
  title: string;
  detail: string;
  regions?: Region[];
  layerId?: string;
  /** e.g. { before: "45", after: "85" } when we can show the actual change */
  change?: { before: string; after: string; field?: string };
}

export interface TamperLayer {
  id: string;
  label: string;
  /** hex colour used for this layer in the heatmap */
  color: string;
  description: string;
  /** per-cell scores 0..1 on the shared grid (row-major), if grid-based */
  grid?: Float32Array;
  /** full-resolution overlay image (data URL), if image-based */
  overlayUrl?: string;
  /** critical layers can flag a region on their own; pixel layers need agreement */
  critical: boolean;
  /** max cell score 0..1 */
  strength: number;
}

export type VerdictKind =
  | "EDITED"
  | "SUSPICIOUS"
  | "NO_SIGNS"
  | "MATCHES_ORIGINAL"
  | "INCONCLUSIVE";

export type DocKind = "pdf" | "jpeg" | "png" | "image" | "other";

export type DocType = "aadhaar" | "marksheet" | "certificate" | "unknown";

export interface CheckRun {
  id: string;
  label: string;
  status: "pass" | "flag" | "skip";
  note?: string;
}

/** A positioned piece of text on page 1 (from the PDF text layer or OCR). */
export interface TextBox {
  str: string;
  x: number; // pixels in page render
  y: number;
  w: number;
  h: number;
  font?: string;
  source: "pdf" | "ocr";
}

export interface PageRender {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

export class TamperGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cellW: number;
  readonly cellH: number;
  readonly data: Float32Array;

  constructor(readonly width: number, readonly height: number, cols = 48) {
    this.cols = cols;
    this.rows = Math.max(1, Math.round((cols * height) / Math.max(1, width)));
    this.cellW = width / this.cols;
    this.cellH = height / this.rows;
    this.data = new Float32Array(this.cols * this.rows);
  }

  static like(g: TamperGrid) {
    return new TamperGrid(g.width, g.height, g.cols);
  }

  /** Raise every cell touched by a pixel rectangle to at least `score`. */
  markRect(x: number, y: number, w: number, h: number, score: number) {
    const c0 = Math.max(0, Math.floor(x / this.cellW));
    const c1 = Math.min(this.cols - 1, Math.floor((x + Math.max(1, w) - 1) / this.cellW));
    const r0 = Math.max(0, Math.floor(y / this.cellH));
    const r1 = Math.min(this.rows - 1, Math.floor((y + Math.max(1, h) - 1) / this.cellH));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * this.cols + c;
        if (this.data[i] < score) this.data[i] = score;
      }
    }
  }

  max() {
    let m = 0;
    for (let i = 0; i < this.data.length; i++) if (this.data[i] > m) m = this.data[i];
    return m;
  }

  /** Connected components of cells >= threshold → normalised regions. */
  regions(threshold: number, minCells = 1): Region[] {
    const seen = new Uint8Array(this.data.length);
    const out: Region[] = [];
    for (let i = 0; i < this.data.length; i++) {
      if (seen[i] || this.data[i] < threshold) continue;
      let minC = Infinity, minR = Infinity, maxC = -1, maxR = -1, count = 0;
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const j = stack.pop()!;
        const r = Math.floor(j / this.cols);
        const c = j % this.cols;
        count++;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        const nb = [
          r > 0 ? j - this.cols : -1,
          r < this.rows - 1 ? j + this.cols : -1,
          c > 0 ? j - 1 : -1,
          c < this.cols - 1 ? j + 1 : -1,
        ];
        for (const n of nb) {
          if (n >= 0 && !seen[n] && this.data[n] >= threshold) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
      if (count >= minCells) {
        out.push({
          x: (minC * this.cellW) / this.width,
          y: (minR * this.cellH) / this.height,
          w: ((maxC - minC + 1) * this.cellW) / this.width,
          h: ((maxR - minR + 1) * this.cellH) / this.height,
        });
      }
    }
    return out;
  }
}

export function pxToRegion(
  x: number,
  y: number,
  w: number,
  h: number,
  pageW: number,
  pageH: number,
  label?: string
): Region {
  return { x: x / pageW, y: y / pageH, w: w / pageW, h: h / pageH, label };
}
