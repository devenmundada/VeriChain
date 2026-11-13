/**
 * Reading-order lines from positioned text (PDF text layer or OCR words).
 *
 * PDF text items come in drawing order, not reading order: Canva, for example, writes the
 * "DOB" label and the date that follows it as far-apart items. Labels and values must be
 * matched by position, so every parser works on these geometric lines instead.
 * Lines are split at wide gaps, so the two columns of an e-Aadhaar letter stay separate.
 *
 * DOM-free (unit-testable in Node).
 */

import type { TextBox } from "./types";

export interface TextLine {
  text: string;
  boxes: TextBox[];
  x: number;
  y: number;
  w: number;
  h: number;
}

export function buildLines(boxesIn: TextBox[]): TextLine[] {
  const boxes = boxesIn.filter((b) => b.str && b.str.trim() && b.h > 0);
  // Chain words left to right: a word continues a line when it sits at the same height and
  // starts close to where the line ends. Columns at the same height stay separate lines.
  const byX = [...boxes].sort((a, b) => a.x - b.x);
  const segs: { items: TextBox[]; c: number; h: number; right: number }[] = [];
  for (const b of byX) {
    const c = b.y + b.h / 2;
    let best: (typeof segs)[number] | undefined;
    let bestD = Infinity;
    for (const s of segs) {
      const hh = Math.min(s.h, b.h);
      const d = Math.abs(s.c - c);
      if (d >= Math.max(2, hh * 0.5)) continue;
      if (b.h > s.h * 2.4 || s.h > b.h * 2.4) continue;
      const gap = b.x - s.right;
      if (gap > Math.max(s.h, b.h) * 3 + 2 || gap < -Math.max(s.h, b.h) * 1.5) continue;
      const score = d + Math.max(0, gap) * 0.05;
      if (score < bestD) {
        bestD = score;
        best = s;
      }
    }
    if (best) {
      best.items.push(b);
      const n = best.items.length;
      best.c = (best.c * (n - 1) + c) / n;
      best.h = (best.h * (n - 1) + b.h) / n;
      best.right = Math.max(best.right, b.x + b.w);
    } else segs.push({ items: [b], c, h: b.h, right: b.x + b.w });
  }

  const lines: TextLine[] = segs.map((sg) => {
    const seg = sg.items;
    let text = "";
    for (let i = 0; i < seg.length; i++) {
      const b = seg[i];
      if (i > 0) {
        const p = seg[i - 1];
        const gap = b.x - (p.x + p.w);
        const needSpace = gap > Math.min(p.h, b.h) * 0.18 && !/\s$/.test(text) && !/^\s/.test(b.str);
        text += needSpace ? " " : "";
      }
      text += b.str;
    }
    const x = Math.min(...seg.map((b) => b.x));
    const y = Math.min(...seg.map((b) => b.y));
    const x1 = Math.max(...seg.map((b) => b.x + b.w));
    const y1 = Math.max(...seg.map((b) => b.y + b.h));
    return { text: text.replace(/\s+/g, " ").trim(), boxes: seg, x, y, w: x1 - x, h: y1 - y };
  });
  // reading order: top to bottom; lines on the same visual row left to right
  const center = (l: TextLine) => l.y + l.h / 2;
  lines.sort((a, b) => {
    const same = Math.abs(center(a) - center(b)) < Math.min(a.h, b.h) * 0.5;
    return same ? a.x - b.x : center(a) - center(b);
  });
  return lines.filter((l) => l.text);
}

/** Rough advance width of a character in em (Helvetica-like), to place characters inside a box. */
export function charWidth(ch: string): number {
  if (/\s/.test(ch)) return 0.28;
  if (/[.,:;'|!]/.test(ch)) return 0.28;
  if (/[/()[\]\-]/.test(ch)) return 0.33;
  if (/[iljtfI1]/.test(ch)) return 0.3;
  if (/[0-9]/.test(ch)) return 0.556;
  if (/[mwMW]/.test(ch)) return 0.83;
  if (/[A-Z]/.test(ch)) return 0.67;
  if (/[a-z]/.test(ch)) return 0.52;
  return 0.6;
}

/** Left edge of every character (and the right edge of the last) of a string drawn in a box. */
export function charEdges(str: string, x: number, w: number): number[] {
  const ws = [...str].map(charWidth);
  const total = ws.reduce((a, b) => a + b, 0) || 1;
  const out = [x];
  let acc = 0;
  for (const cw of ws) {
    acc += cw;
    out.push(x + (w * acc) / total);
  }
  return out;
}

export function linesText(lines: TextLine[]): string {
  return lines.map((l) => l.text).join("\n");
}

/** Pixel span of a substring inside a line, estimated from the boxes it came from. */
export function spanOf(line: TextLine, start: number, end: number): { x: number; y: number; w: number; h: number } {
  // walk the boxes, mapping character offsets in line.text to boxes (spaces may have been added)
  let pos = 0;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const t = line.text;
  for (const b of line.boxes) {
    const s = b.str.replace(/\s+/g, " ").trim();
    if (!s) continue;
    const at = t.indexOf(s, pos);
    if (at < 0) continue;
    const bStart = at, bEnd = at + s.length;
    pos = bEnd;
    const o0 = Math.max(start, bStart), o1 = Math.min(end, bEnd);
    if (o1 <= o0) continue;
    const edges = charEdges(s, b.x, b.w);
    x0 = Math.min(x0, edges[o0 - bStart]);
    x1 = Math.max(x1, edges[o1 - bStart]);
    y0 = Math.min(y0, b.y);
    y1 = Math.max(y1, b.y + b.h);
  }
  if (!isFinite(x0)) return { x: line.x, y: line.y, w: line.w, h: line.h };
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}
