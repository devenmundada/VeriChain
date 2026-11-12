/**
 * Marksheet arithmetic — the document's own rules as the reference.
 * Forgers usually change one subject's marks and forget the Total or the
 * percentage. We rebuild the table from positioned text (PDF text layer or
 * OCR) and check: column sums = Total row, obtained ≤ max, percentage.
 *
 * DOM-free so it can be unit-tested in Node.
 */

import type { Evidence, Region, TextBox } from "./types";

export interface Token {
  text: string;
  value: number | null;
  /** drawing order — later tokens are painted on top of earlier ones */
  order: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MarksheetReport {
  checked: boolean;
  subjects: { name: string; values: number[] }[];
  totalRow?: number[];
  percentage?: number;
  consistent?: boolean;
}

const NUM_RE = /^\(?(\d{1,4}(?:\.\d{1,2})?)\)?[*,]?$/;

export function tokenize(boxes: TextBox[]): Token[] {
  const out: Token[] = [];
  let order = 0;
  for (const b of boxes) {
    const s = b.str;
    const len = Math.max(1, s.length);
    for (const m of s.matchAll(/\S+/g)) {
      const off = m.index ?? 0;
      const text = m[0];
      const nm = text.match(NUM_RE);
      out.push({
        text,
        order: order++,
        value: nm ? Number(nm[1]) : null,
        x: b.x + (b.w * off) / len,
        y: b.y,
        w: (b.w * text.length) / len,
        h: b.h,
      });
    }
  }
  return out;
}

export function groupLines(tokens: Token[]): Token[][] {
  const sorted = [...tokens].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
  const lines: Token[][] = [];
  for (const t of sorted) {
    const yc = t.y + t.h / 2;
    const line = lines.find((l) => {
      const ly = l[0].y + l[0].h / 2;
      return Math.abs(ly - yc) < Math.max(l[0].h, t.h) * 0.5;
    });
    if (line) line.push(t);
    else lines.push([t]);
  }
  // Text painted over other text (white box + retyped value): only the top-most is visible.
  const visible = lines.map((l) =>
    l.filter((t) => !l.some((o) => o !== t && o.order > t.order && Math.min(t.x + t.w, o.x + o.w) - Math.max(t.x, o.x) > Math.min(t.w, o.w) * 0.5))
  );
  for (const l of visible) l.sort((a, b) => a.x - b.x);
  return visible.filter((l) => l.length).sort((a, b) => a[0].y - b[0].y);
}

const SKIP_LINE = /roll|seat|enrol|enroll|registration|reg\.?\s*no|year|semester|sem\b|date|dob|birth|percentage|result|sgpa|cgpa|grade point|credits?\s*earned|page|phone|mobile|pin/i;

function lineText(l: Token[]) {
  return l.map((t) => t.text).join(" ");
}

function cx(t: Token) {
  return t.x + t.w / 2;
}

export function checkMarksheet(
  boxes: TextBox[],
  pageW: number,
  pageH: number,
  fullText: string
): { evidence: Evidence[]; report: MarksheetReport } {
  const evidence: Evidence[] = [];
  let eid = 0;
  const ev = (e: Omit<Evidence, "id">) => evidence.push({ id: `ms-${eid++}`, ...e });
  const report: MarksheetReport = { checked: false, subjects: [] };
  const reg = (t: Token, label?: string): Region => ({ x: t.x / pageW, y: t.y / pageH, w: t.w / pageW, h: t.h / pageH, label });

  const lines = groupLines(tokenize(boxes));
  // Total row: prefer "grand total" / "total marks", else the last line starting with "total"
  let totalIdx = lines.findIndex((l) => /grand\s+total|total\s+marks|marks\s+total|aggregate/i.test(lineText(l)) && l.some((t) => t.value !== null));
  if (totalIdx < 0) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/\btotal\b/i.test(lineText(lines[i])) && lines[i].some((t) => t.value !== null)) {
        totalIdx = i;
        break;
      }
    }
  }
  if (totalIdx < 0) return { evidence, report };
  const totalLine = lines[totalIdx];
  const totalNums = totalLine.filter((t) => t.value !== null);

  const headerIdx = lines.findIndex((l, i) => i < totalIdx && /subject|course|paper|name of/i.test(lineText(l)));
  const subjectLines = lines
    .slice(headerIdx >= 0 ? headerIdx + 1 : 0, totalIdx)
    .filter((l) => {
      const txt = lineText(l);
      if (SKIP_LINE.test(txt)) return false;
      const hasWord = l.some((t) => t.value === null && /[A-Za-z]{3,}/.test(t.text));
      const nums = l.filter((t) => t.value !== null && t.value <= 1000);
      return hasWord && nums.length >= 1;
    })
;
  if (subjectLines.length < 3) return { evidence, report };

  report.checked = true;
  report.subjects = subjectLines.map((l) => ({
    name: l.filter((t) => t.value === null).map((t) => t.text).join(" "),
    values: l.filter((t) => t.value !== null).map((t) => t.value!),
  }));
  report.totalRow = totalNums.map((t) => t.value!);

  // Columns: for every number in the Total row, collect the aligned number from each subject line.
  const columns: { total: Token; cells: Token[] }[] = [];
  for (const tt of totalNums) {
    const tol = Math.max(pageW * 0.025, tt.w * 1.5);
    const cells: Token[] = [];
    for (const l of subjectLines) {
      let best: Token | null = null;
      let bestD = Infinity;
      for (const t of l) {
        if (t.value === null) continue;
        const dd = Math.abs(cx(t) - cx(tt));
        if (dd < bestD) { bestD = dd; best = t; }
      }
      if (best && bestD <= tol) cells.push(best);
    }
    if (cells.length >= 3) columns.push({ total: tt, cells });
  }

  let mismatches = 0;
  let matches = 0;
  for (const col of columns) {
    const sum = col.cells.reduce((s, t) => s + (t.value ?? 0), 0);
    const total = col.total.value!;
    if (col.cells.length < subjectLines.length) continue; // incomplete column — can't judge
    if (Math.abs(sum - total) < 0.01) {
      matches++;
    } else {
      mismatches++;
      ev({
        category: "marksheet",
        severity: "critical",
        title: "Marks don't add up",
        detail: `The ${col.cells.length} subject marks in this column add up to ${sum}, but the Total row says ${total} (off by ${Math.abs(sum - total)}). One of these numbers was changed.`,
        regions: [reg(col.total, `Total ${total} ≠ ${sum}`)],
        layerId: "marksheet",
      });
    }
  }

  // Obtained ≤ maximum: two columns where one is constant (max) and the other varies
  if (columns.length >= 2) {
    const isConst = (c: { cells: Token[] }) => new Set(c.cells.map((t) => t.value)).size === 1;
    const maxCol = columns.find(isConst);
    if (maxCol) {
      for (const col of columns) {
        if (col === maxCol) continue;
        for (const t of col.cells) {
          if ((t.value ?? 0) > (maxCol.cells[0].value ?? Infinity)) {
            mismatches++;
            ev({
              category: "marksheet",
              severity: "critical",
              title: "Marks above the maximum",
              detail: `A subject shows ${t.value} marks, but the maximum for subjects is ${maxCol.cells[0].value}.`,
              regions: [reg(t, `${t.value} > ${maxCol.cells[0].value}`)],
              layerId: "marksheet",
            });
          }
        }
      }
    }
  }

  // Percentage — read from the visible text only (covered values don't count)
  const visibleText = lines.map(lineText).join("\n") || fullText;
  const pm = visibleText.match(/percentage\s*[:=-]?\s*(\d{1,3}(?:\.\d{1,3})?)\s*%?/i) ?? visibleText.match(/(\d{1,3}\.\d{1,3})\s*%/);
  if (pm && totalNums.length >= 2) {
    const pct = Number(pm[1]);
    report.percentage = pct;
    const vals = totalNums.map((t) => t.value!).sort((a, b) => b - a);
    const [maxTotal, obtained] = vals;
    if (maxTotal > 0 && obtained <= maxTotal) {
      const expected = (obtained / maxTotal) * 100;
      if (Math.abs(expected - pct) > 0.6) {
        mismatches++;
        const pctTok = lines.flat().find((t) => t.text.startsWith(pm[1]));
        ev({
          category: "marksheet",
          severity: "critical",
          title: "Percentage doesn't match the total",
          detail: `${obtained} out of ${maxTotal} is ${expected.toFixed(2)}%, but the document says ${pct}%.`,
          regions: pctTok ? [reg(pctTok, `${pct}% ≠ ${expected.toFixed(2)}%`)] : undefined,
          layerId: "marksheet",
        });
      } else {
        matches++;
      }
    }
  }

  report.consistent = mismatches === 0 && matches > 0;
  if (report.consistent) {
    ev({
      category: "marksheet",
      severity: "pass",
      title: "Marks add up",
      detail: `${subjectLines.length} subjects checked against the Total row${report.percentage ? " and the percentage" : ""} — the arithmetic is consistent. (A forger who changes every number consistently would still pass this check.)`,
    });
  }
  return { evidence, report };
}

export function looksLikeMarksheet(text: string) {
  return /marks?\s*(sheet|statement|obtained|card)|statement of (marks|grades)|grade\s*card|transcript|semester|examination|sgpa|cgpa|max(imum)?\s*marks/i.test(text);
}
