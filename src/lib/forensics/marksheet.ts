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

// ───────────────────────── Grade cards (credits, grade points, SGPA / CGPA) ─────────────────────────

/** Standard 10-point scales used by Indian universities. */
const GRADE_POINTS: Record<string, number> = {
  AA: 10, AB: 9, BB: 8, BC: 7, CC: 6, CD: 5, DD: 4, FF: 0,
  O: 10, "A+": 9, A: 8, "B+": 7, B: 6, C: 5, P: 4, F: 0,
};
const TWO_LETTER = new Set(["AA", "AB", "BB", "BC", "CC", "CD", "DD", "FF"]);
const GPA_LABEL = /^(SGPA|CGPA|GPA|SPI|CPI|YGPA)$/i;
const COURSE_CODE = /^[A-Z]{2,}[A-Z0-9]*\d{3,}[A-Z0-9-]*$/;

export interface GradeCardReport {
  checked: boolean;
  courses: { code: string; credits: number; grade: string }[];
  semester?: { C?: number; EC?: number; CP?: number; GPA?: number };
  cumulative?: { C?: number; EC?: number; CP?: number; GPA?: number };
  consistent?: boolean;
}

function round2(v: number) {
  return Math.round(v * 100) / 100;
}

/**
 * Grade cards (SGPA/CGPA) have their own arithmetic:
 *   SGPA = CP / C for the semester, CGPA = cumulative CP / cumulative C,
 *   CP = Σ credits × grade points (+ incentive points), C = Σ course credits.
 * A forger who raises the CGPA (or a grade) rarely recomputes all of these.
 */
export function checkGradeCard(boxes: TextBox[], pageW: number, pageH: number): { evidence: Evidence[]; report: GradeCardReport } {
  const evidence: Evidence[] = [];
  let eid = 0;
  const ev = (e: Omit<Evidence, "id">) => evidence.push({ id: `gc-${eid++}`, ...e });
  const report: GradeCardReport = { checked: false, courses: [] };
  const fromOcr = boxes.some((b) => b.source === "ocr");
  const reg = (t: Token, label?: string): Region => ({ x: t.x / pageW, y: t.y / pageH, w: t.w / pageW, h: t.h / pageH, label });
  const lines = groupLines(tokenize(boxes));

  // ── summary: a header line with C / EC / CP / SGPA … and the numbers under it ──
  let hdrIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const hasGpa = lines[i].some((t) => GPA_LABEL.test(t.text.replace(/[^A-Za-z]/g, "")));
    const numsBelow = lines.slice(i + 1, i + 4).some((l) => l.filter((t) => t.value !== null).length >= 3);
    if (hasGpa && numsBelow) {
      hdrIdx = i;
      break;
    }
  }
  if (hdrIdx < 0) return { evidence, report };
  const header = lines[hdrIdx].filter((t) => t.value === null);
  let valueLine: Token[] | null = null;
  for (let i = hdrIdx + 1; i < Math.min(lines.length, hdrIdx + 4); i++) {
    const nums = lines[i].filter((t) => t.value !== null);
    if (nums.length >= 3) {
      valueLine = nums;
      break;
    }
  }
  if (!valueLine) return { evidence, report };
  // Column labels may be garbled by OCR ("ΣC" → "YC", "XEC"). The GPA labels are reliable; the
  // values between them are, in order, C (credits), EC (earned credits), CP (credit points).
  const normLabel = (t: string) => t.toUpperCase().replace(/^[^A-Z]+/, "").replace(/^[ΣXYZE2](?=(C|EC|CP)$)/, "");
  const gpaHdr = header.filter((h) => GPA_LABEL.test(normLabel(h.text)));
  const nums = [...valueLine].sort((a, b) => a.x - b.x);
  const tol = pageW * 0.05;
  const labelled: { label: string; tok: Token; val: Token }[] = [];
  const gpaVals = gpaHdr.map((h) => {
    let best: Token | null = null, bd = Infinity;
    for (const v of nums) { const d = Math.abs(cx(v) - cx(h)); if (d < bd) { bd = d; best = v; } }
    return best && bd <= tol ? { h, v: best } : null;
  });
  let prevIdx = -1;
  const groups: { label: string; tok: Token; val: Token }[][] = [];
  for (const gv of gpaVals) {
    if (!gv) continue;
    const idx = nums.indexOf(gv.v);
    const between = nums.slice(prevIdx + 1, idx);
    prevIdx = idx;
    const names = between.length >= 3 ? ["C", "EC", "CP"] : between.length === 2 ? ["C", "CP"] : [];
    const g: { label: string; tok: Token; val: Token }[] = [];
    between.slice(-names.length || 0).forEach((v, k) => names.length && g.push({ label: names[k], tok: v, val: v }));
    g.push({ label: normLabel(gv.h.text), tok: gv.h, val: gv.v });
    labelled.push(...g);
    groups.push(g);
  }
  const summaries = groups.filter((g) => g.some((l) => GPA_LABEL.test(l.label)));
  if (!summaries.length) return { evidence, report };
  report.checked = true;
  let mismatches = 0, matches = 0;
  for (const g of summaries) {
    const get = (re: RegExp) => g.find((l) => re.test(l.label));
    const gpa = get(GPA_LABEL)!;
    const C = get(/^(C|TC)$/), EC = get(/^EC$/), CP = get(/^(CP|TCP|ECP|GP)$/);
    const part = { C: C?.val.value ?? undefined, EC: EC?.val.value ?? undefined, CP: CP?.val.value ?? undefined, GPA: gpa.val.value ?? undefined };
    if (/^(CGPA|CPI)$/i.test(gpa.label)) report.cumulative = part;
    else report.semester = part;
    if (!CP || !(C || EC) || part.GPA === undefined) continue;
    const cp = part.CP!;
    const divisors = [part.C, part.EC].filter((d): d is number => !!d && d > 0);
    const ok = divisors.some((d) => Math.abs(cp / d - part.GPA!) <= 0.0105 || Math.abs(Math.floor((cp / d) * 100) / 100 - part.GPA!) < 0.001);
    if (ok) {
      matches++;
      continue;
    }
    mismatches++;
    const d = divisors[0];
    ev({
      category: "marksheet",
      severity: "critical",
      title: `${gpa.label} doesn't match its credit points`,
      detail: `${gpa.label} must equal credit points ÷ credits: ${cp} ÷ ${d} = ${round2(cp / d).toFixed(2)}, but the card says ${part.GPA}. The ${gpa.label} (or the numbers next to it) was changed.`,
      regions: [reg(gpa.val, `${gpa.label} ${part.GPA} ≠ ${round2(cp / d).toFixed(2)}`)],
      layerId: "marksheet",
      change: { before: round2(cp / d).toFixed(2), after: String(part.GPA), field: gpa.label },
    });
  }
  const sem = report.semester, cum = report.cumulative;
  if (sem && cum) {
    for (const k of ["C", "EC", "CP"] as const) {
      if (sem[k] !== undefined && cum[k] !== undefined && cum[k]! + 0.001 < sem[k]!) {
        mismatches++;
        ev({
          category: "marksheet",
          severity: "critical",
          title: "Cumulative total smaller than the semester's",
          detail: `The cumulative ${k} (${cum[k]}) is smaller than this semester's ${k} (${sem[k]}) — impossible on a genuine grade card.`,
          layerId: "marksheet",
        });
      }
    }
    if (sem.EC !== undefined && sem.C !== undefined && sem.EC > sem.C + 0.001) {
      mismatches++;
      ev({ category: "marksheet", severity: "critical", title: "Earned credits above registered credits", detail: `Earned credits (${sem.EC}) can't exceed the credits registered (${sem.C}).`, layerId: "marksheet" });
    }
  }

  // ── courses: code … credits … grade, under a "Code … C … Grade" header ──
  const courseHdr = lines.findIndex((l, i) => i < hdrIdx && l.some((t) => /^code$/i.test(t.text)) && l.some((t) => /^grade$/i.test(t.text)));
  if (courseHdr >= 0) {
    const hdr = lines[courseHdr];
    const cTok = hdr.find((t) => /^(C|Cr|Credits?)$/i.test(t.text));
    const gTok = hdr.find((t) => /^grade$/i.test(t.text));
    let incentive = 0;
    for (let i = courseHdr + 1; i < hdrIdx; i++) {
      const l = lines[i];
      const txt = lineText(l);
      if (/incentive|bonus|extra/i.test(txt)) {
        const n = [...l].reverse().find((t) => t.value !== null);
        if (n) incentive += n.value!;
        continue;
      }
      const code = l.find((t) => COURSE_CODE.test(t.text));
      if (!code || !cTok || !gTok) continue;
      const near = (ref: Token, pred: (t: Token) => boolean) => {
        let best: Token | null = null, bd = Infinity;
        for (const t of l) if (pred(t)) { const d = Math.abs(cx(t) - cx(ref)); if (d < bd) { bd = d; best = t; } }
        return best && bd < pageW * 0.06 ? best : null;
      };
      const cr = near(cTok, (t) => t.value !== null);
      const gr = near(gTok, (t) => /^[A-F][A-F+]?$|^O$|^P$/.test(t.text.toUpperCase()));
      if (cr && gr) report.courses.push({ code: code.text, credits: cr.value!, grade: gr.text.toUpperCase() });
    }
    if (report.courses.length >= 3 && sem?.C !== undefined) {
      const sumC = report.courses.reduce((s, c) => s + c.credits, 0);
      const graded = report.courses.every((c) => c.grade in GRADE_POINTS);
      const cp = report.courses.reduce((s, c) => s + c.credits * (GRADE_POINTS[c.grade] ?? 0), 0) + incentive;
      const twoLetter = report.courses.every((c) => TWO_LETTER.has(c.grade));
      if (Math.abs(sumC - sem.C) > 0.01) {
        mismatches++;
        ev({
          category: "marksheet",
          // from a photo a course row may simply have been misread
          severity: fromOcr ? "warning" : "critical",
          title: "Course credits don't add up",
          detail: `The ${report.courses.length} courses carry ${sumC} credits in total, but the card says C = ${sem.C}.`,
          layerId: "marksheet",
        });
      } else if (graded && sem.CP !== undefined) {
        if (Math.abs(cp - sem.CP) < 0.01) matches++;
        else {
          mismatches++;
          const cpTok = labelled.find((l) => /^(CP|TCP|ECP|GP)$/.test(l.label))?.val;
          ev({
            category: "marksheet",
            severity: twoLetter ? "critical" : "warning",
            title: "Grades don't add up to the credit points",
            detail: `Credits × grade points of the ${report.courses.length} courses${incentive ? ` plus ${incentive} incentive points` : ""} give ${cp}, but the card says CP = ${sem.CP}. A grade or the credit points were changed${twoLetter ? "" : " (or this university uses a different grade scale)"}.`,
            regions: cpTok ? [reg(cpTok, `CP ${sem.CP} ≠ ${cp}`)] : undefined,
            layerId: "marksheet",
          });
        }
      }
    }
  }
  report.consistent = mismatches === 0 && matches > 0;
  if (report.consistent) {
    ev({
      category: "marksheet",
      severity: "pass",
      title: "Grade arithmetic is consistent",
      detail: `SGPA/CGPA equal credit points ÷ credits${report.courses.length ? `, and the ${report.courses.length} course grades add up to the credit points` : ""}. (A forger who recomputes every number would still pass this check.)`,
    });
  }
  return { evidence, report };
}
