/**
 * Runs the Aadhaar checks and turns them into evidence.
 * DOM-free (QR text is decoded elsewhere) so it can be tested in Node.
 *
 * Every field is read from reading-order lines (label and value on the same visual line),
 * from the text a person actually sees. Checks:
 *  - signed QR vs printed: number (last 4), name (the card's own name line and the
 *    letter's "To" name), date of birth, gender, PIN code
 *  - fields every Aadhaar prints (DOB / gender / number) that are missing — with or without a QR
 *  - copies that must agree: the number and the VID are printed several times
 *  - Verhoeff check digit
 */

import {
  type AadhaarQR,
  aadhaarNumberValid,
  bestNameMatch,
  findMaskedLast4,
  normName,
  parseAadhaarQR,
  similarity,
} from "./aadhaar";
import { buildLines, linesText, spanOf, type TextLine } from "./textLines";
import type { CheckRun, Evidence, Region, TextBox } from "./types";

export interface AadhaarReport {
  qr: AadhaarQR | null;
  printedNumbers: string[];
  maskedLast4: string[];
  printedDob?: string;
  printedYob?: string;
  printedGender?: string;
  printedName?: string;
  printedPincode?: string;
  numberValid?: boolean;
  qrMatches?: boolean;
  /** where the identity fields are printed (pixels of the analysed page) */
  fields?: { x: number; y: number; w: number; h: number; label: string }[];
  /** photo on the card vs the photo signed inside the QR (filled in by the engine) */
  photo?: { score: number; verdict: "match" | "unsure" | "mismatch" | "not-compared"; note?: string };
}

export interface QRInput {
  text: string;
  box?: { x: number; y: number; w: number; h: number };
}

const INDIC = /[\u0900-\u0DFF]/;
const DOB_LABEL = /(?:D[O0Q][B8]|D\.O\.B\.?|Date\s*of\s*Birth|जन्म\s*(?:तिथि|तारीख))/i;
const DATE = /(\d{2})\s*[/.-]\s*(\d{2})\s*[/.-]\s*(\d{4})/;
const YOB_LABEL = /(?:Year\s*of\s*Birth|Y[O0]B|जन्म\s*वर्ष)/i;
const GENDER = /\b(FEMALE|MALE|TRANSGENDER)\b|(महिला|पुरुष|स्त्री)/i;
const RELATION = /^(?:S|D|W|C)\s*[/.]?\s*O\b|^(?:Son|Daughter|Wife)\s+of\b/i;
const TEMPLATE_WORDS = /government|india|unique|identification|authority|aadhaar|aadhar|enrol|address|proof|identity|citizenship|issue|download|details|signature|digitally|help|uidai|www|mobile|vid|valid|information|male|female|birth|dob|to\b/i;

function maskNumber(n: string) {
  return `XXXX XXXX ${n.slice(-4)}`;
}

function gender0(g?: string) {
  if (!g) return undefined;
  const t = g.trim().toUpperCase();
  if (/^F|महिला|स्त्री/.test(t)) return "F";
  if (/^M|पुरुष/.test(t)) return "M";
  if (/^T/.test(t)) return "T";
  return t[0];
}

const genderWord = (g?: string) => (g === "M" ? "Male" : g === "F" ? "Female" : g === "T" ? "Transgender" : "?");

interface Found {
  line: TextLine;
  li: number;
  start: number;
  end: number;
}

/** The longest run of plain words in an OCR line (drops noise read from a photo or a border). */
function nameRun(t: string) {
  const toks = t.split(/\s+/);
  let best: string[] = [], cur: string[] = [];
  for (const w of toks) {
    if (/^[A-Za-z][A-Za-z.'-]+$/.test(w)) cur.push(w);
    else cur = [];
    if (cur.join("").length > best.join("").length) best = [...cur];
  }
  return best.join(" ");
}

/** A name-like English line: 2–5 words of letters, no digits, not template text. */
function nameLike(t: string) {
  if (INDIC.test(t) || /\d|:/.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 5) return false;
  if (!words.every((w) => /^[A-Za-z.'-]+$/.test(w))) return false;
  if (TEMPLATE_WORDS.test(t)) return false;
  return t.replace(/[^A-Za-z]/g, "").length >= 5;
}

/** Lines directly above / below `l` in the same column, nearest first. */
function neighbours(lines: TextLine[], l: TextLine, dir: "above" | "below", maxGap: number, xTol: number): TextLine[] {
  return lines
    .filter((o) => o !== l && Math.abs(o.x - l.x) <= xTol)
    .filter((o) => (dir === "above" ? o.y + o.h <= l.y + l.h * 0.4 && l.y - (o.y + o.h) <= maxGap : o.y >= l.y + l.h * 0.6 && o.y - (l.y + l.h) <= maxGap))
    .sort((a, b) => (dir === "above" ? b.y - a.y : a.y - b.y));
}

export async function runAadhaarChecks(
  qrs: QRInput[],
  boxes: TextBox[],
  docText: string,
  source: "pdf" | "ocr",
  pageW: number,
  pageH: number,
  ocrWordConfidence?: (needle: string) => number
): Promise<{ evidence: Evidence[]; checks: CheckRun[]; report: AadhaarReport }> {
  const evidence: Evidence[] = [];
  const checks: CheckRun[] = [];
  let eid = 0;
  const ev = (e: Omit<Evidence, "id">) => evidence.push({ id: `aad-${eid++}`, ...e });
  const reg = (r: { x: number; y: number; w: number; h: number }, label?: string): Region => ({
    x: Math.max(0, r.x / pageW),
    y: Math.max(0, r.y / pageH),
    w: Math.min(1, r.w / pageW),
    h: Math.min(1, r.h / pageH),
    label,
  });
  const pad = (r: { x: number; y: number; w: number; h: number }, k = 0.25) => ({ x: r.x - r.h * k, y: r.y - r.h * k, w: r.w + 2 * r.h * k, h: r.h * (1 + 2 * k) });
  const conf = (needle: string) => (source === "pdf" ? 100 : ocrWordConfidence?.(needle) ?? 0);

  const lines = buildLines(boxes);
  const text = linesText(lines) + "\n" + docText;

  // ── QR ──
  let qr: AadhaarQR | null = null;
  let qrBox: QRInput["box"];
  for (const q of qrs) {
    qr = await parseAadhaarQR(q.text);
    if (qr) {
      qrBox = q.box;
      break;
    }
  }
  const qrRegion: Region[] = qrBox ? [reg(qrBox, "signed QR")] : [];

  // ── Read the printed fields by position ──
  const numbers: (Found & { num: string })[] = [];
  const vids: (Found & { vid: string })[] = [];
  let dob = null as (Found & { dob?: string; yob?: string }) | null;
  let gender = null as (Found & { g: string }) | null;
  const pincodes: (Found & { pin: string })[] = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const t = line.text;
    for (const m of t.matchAll(/VID\s*:?\s*(\d{4})\s?(\d{4})\s?(\d{4})\s?(\d{4})/gi)) {
      vids.push({ line, li, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, vid: m.slice(1, 5).join("") });
    }
    // the 16-digit VID (OCR may garble its "VID" label) is not an Aadhaar number
    const noVid = t
      .replace(/(?:V\s*[I1l|!]\s*[D0O]|\bID)\s*[:;.]?\s*[\d\s]{14,24}/gi, (x) => " ".repeat(x.length))
      .replace(/^\s*[:;]\s*\d{4}\s?\d{4}\s?\d{4}\s?\d{3,4}\b/, (x) => " ".repeat(x.length));
    for (const m of noVid.matchAll(/(?<![\d/])([2-9]\d{3})[  ]?(\d{4})[  ]?(\d{4})(?![  ]?\d)/g)) {
      numbers.push({ line, li, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, num: m[1] + m[2] + m[3] });
    }
    if (!dob) {
      // a date with a birth-date label shortly before it (issue / download dates have other labels)
      for (const dm of t.matchAll(new RegExp(DATE.source, "g"))) {
        const at = dm.index ?? 0;
        if (DOB_LABEL.test(t.slice(Math.max(0, at - 28), at)) && !/issue|download|details|as on|enrol/i.test(t.slice(Math.max(0, at - 18), at))) {
          dob = { line, li, start: at, end: at + dm[0].length, dob: `${dm[1]}-${dm[2]}-${dm[3]}`, yob: dm[3] };
          break;
        }
      }
      // label at the end of a line, value at the start of the next one (OCR line breaks)
      if (!dob && DOB_LABEL.test(t) && !DATE.test(t)) {
        const nx = neighbours(lines, line, "below", line.h * 1.5, pageW * 0.1)[0] ?? lines.find((o) => o !== line && Math.abs(o.y - line.y) < line.h * 0.5 && o.x > line.x + line.w && o.x - (line.x + line.w) < line.h * 6);
        const nm = nx?.text.match(/^\s*[:;.-]?\s*(\d{2})\s*[/.-]\s*(\d{2})\s*[/.-]\s*(\d{4})/);
        if (nx && nm) dob = { line: nx, li: lines.indexOf(nx), start: 0, end: nm[0].length, dob: `${nm[1]}-${nm[2]}-${nm[3]}`, yob: nm[3] };
      }
      const ym = !dob ? t.match(new RegExp(`${YOB_LABEL.source}\\s*[:/;.-]?\\s*(\\d{4})`, "i")) : null;
      if (ym) dob = { line, li, start: ym.index ?? 0, end: (ym.index ?? 0) + ym[0].length, yob: ym[1] };
    }
    if (!gender) {
      const gm = t.match(GENDER);
      // "Male"/"Female" as a field value, not inside a sentence
      if (gm && t.length < 40) gender = { line, li, start: gm.index ?? 0, end: (gm.index ?? 0) + gm[0].length, g: gender0(gm[0])! };
    }
    for (const m of t.matchAll(/(?:PIN\s*(?:Code)?\s*:?|-|,)\s*(\d{6})\b/gi)) {
      pincodes.push({ line, li, start: (m.index ?? 0) + m[0].length - 6, end: (m.index ?? 0) + m[0].length, pin: m[1] });
    }
  }
  const maskedLast4 = findMaskedLast4(text);
  const distinctNumbers = [...new Set(numbers.map((n) => n.num))];

  // The card's own name: the English line just above the DOB (or gender) line; on the e-Aadhaar
  // letter also the English name under "To". From an image, only lines read with confidence
  // count — OCR turns Hindi name lines into Latin-looking junk.
  const qrNameN = qr?.name ? normName(qr.name) : "";
  const lineConf = (l: TextLine, t: string) => {
    if (source === "pdf") return 100;
    const toks = new Set(t.split(" "));
    const cs = l.boxes.filter((b) => toks.has(b.str)).map((b) => (b as TextBox & { confidence?: number }).confidence ?? 0);
    return cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : 0;
  };
  const pickName = (cands: TextLine[]): (TextLine & { conf: number }) | null => {
    let best: (TextLine & { conf: number }) | null = null;
    let bestScore = -1;
    for (const l of cands) {
      const t = source === "ocr" ? nameRun(l.text) : l.text;
      if (!nameLike(t) || RELATION.test(l.text)) continue;
      const conf = lineConf(l, t);
      if (source === "ocr" && conf < 70) continue;
      const score = qrNameN ? similarity(qrNameN, normName(t)) : 1;
      if (score > bestScore) {
        bestScore = score;
        best = { ...l, text: t, conf };
      }
      if (!qrNameN) break;
    }
    return best;
  };
  const anchor = dob ?? gender;
  const cardName = anchor ? pickName(neighbours(lines, anchor.line, "above", anchor.line.h * 4.5, pageW * 0.12).slice(0, 4)) : null;
  const toLine = lines.find((l) => /^To$/i.test(l.text.trim()));
  const letterName = toLine ? pickName(neighbours(lines, toLine, "below", toLine.h * 6, pageW * 0.08).slice(0, 3)) : null;

  const report: AadhaarReport = {
    qr,
    printedNumbers: distinctNumbers.map(maskNumber),
    maskedLast4,
    printedDob: dob?.dob,
    printedYob: dob?.yob,
    printedGender: gender?.g,
    printedName: cardName?.text ?? letterName?.text,
    printedPincode: pincodes[0]?.pin,
    fields: [
      ...(cardName ? [{ ...pad(cardName), label: "name" }] : []),
      ...(letterName ? [{ ...pad(letterName), label: "name" }] : []),
      ...(dob ? [{ ...pad(spanOf(dob.line, dob.start, dob.end)), label: "dob" }] : []),
      ...(gender ? [{ ...pad(spanOf(gender.line, gender.start, gender.end)), label: "gender" }] : []),
      ...numbers.map((n) => ({ ...pad(spanOf(n.line, n.start, n.end)), label: "number" })),
    ],
  };

  // ── Check digit ──
  // In an image, a copy that fails the check digit while another copy of the number passes it was
  // usually just misread (the copies are printed in different sizes).
  const validCopies = distinctNumbers.filter((n) => aadhaarNumberValid(n).valid);
  const qrConfirmed = !!qr?.last4 && validCopies.some((v) => v.endsWith(qr!.last4!));
  const misread = (n: string) =>
    source === "ocr" && !aadhaarNumberValid(n).valid && conf(n) < 95 && (validCopies.some((v) => similarity(v, n) >= 0.75) || qrConfirmed);
  if (distinctNumbers.length) {
    let allValid = true;
    for (const n of distinctNumbers) {
      const res = aadhaarNumberValid(n);
      if (res.valid || misread(n)) continue;
      allValid = false;
      const where = numbers.filter((x) => x.num === n);
      const sure = conf(n) >= 90;
      ev({
        category: "aadhaar",
        severity: sure ? "critical" : "warning",
        title: "Aadhaar number is not valid",
        detail: sure
          ? `The printed number ${maskNumber(n)} ${res.reason}. Every real Aadhaar number passes this check, and changing even one digit breaks it.`
          : `The number read as ${maskNumber(n)} ${res.reason}. It may have been misread from the image — check the digits by eye. If they are right, the number was changed.`,
        regions: where.slice(0, 3).map((w) => reg(pad(spanOf(w.line, w.start, w.end)), "invalid number")),
        layerId: "aadhaar",
      });
    }
    report.numberValid = allValid;
    if (allValid)
      ev({
        category: "aadhaar",
        severity: "pass",
        title: "Aadhaar number passes the check digit",
        detail: `${distinctNumbers.map(maskNumber).join(", ")} — the Verhoeff check digit is correct (a changed digit would fail).`,
      });
    checks.push({ id: "aad-verhoeff", label: "Aadhaar check digit", status: allValid ? "pass" : "flag" });
  } else {
    checks.push({ id: "aad-verhoeff", label: "Aadhaar check digit", status: "skip", note: maskedLast4.length ? "number is masked" : "number not found" });
  }

  // ── Copies that must agree (no QR needed) ──
  const validNumbers = validCopies;
  if (validNumbers.length >= 2) {
    const sure = source === "pdf" || validNumbers.every((n) => conf(n) >= 85);
    ev({
      category: "aadhaar",
      severity: sure ? "critical" : "warning",
      title: "Different Aadhaar numbers on one card",
      detail: `The card prints its number several times, and the copies disagree: ${validNumbers.map(maskNumber).join(" vs ")}. One copy was changed.`,
      regions: numbers.filter((x) => validNumbers.includes(x.num)).slice(0, 4).map((w) => reg(pad(spanOf(w.line, w.start, w.end)), "number copy")),
      layerId: "aadhaar",
      change: { before: maskNumber(validNumbers[0]), after: maskNumber(validNumbers[1]), field: "Aadhaar number" },
    });
  }
  const distinctVids = [...new Set(vids.map((v) => v.vid))];
  if (distinctVids.length >= 2) {
    ev({
      category: "aadhaar",
      severity: source === "pdf" ? "critical" : "warning",
      title: "VID copies don't match",
      detail: `The Virtual ID is printed more than once and the copies differ (…${distinctVids.map((v) => v.slice(-4)).join(" vs …")}).`,
      regions: vids.slice(0, 4).map((w) => reg(pad(spanOf(w.line, w.start, w.end)), "VID copy")),
      layerId: "aadhaar",
    });
  }

  // Where the date of birth and gender belong on the card, if they were removed:
  // under the card's name (and the S/O-D/O line after it), above the next printed line.
  const expectedFieldsRegion = (): Region[] => {
    let nameLine: TextLine | null = cardName;
    if (!nameLine) {
      // the name line closest above the card's own number (the lowest copy of the number on the left)
      const cardNum = [...numbers].sort((a, b) => b.line.y - a.line.y).find((n) => n.line.x < pageW * 0.6) ?? numbers[numbers.length - 1];
      if (cardNum) {
        const cl = cardNum.line;
        const above = lines
          .filter((l) => l.y + l.h <= cl.y + cl.h * 0.2 && cl.y - (l.y + l.h) < cl.h * 14)
          .filter((l) => !(l.x > cl.x + cl.w || l.x + l.w < cl.x - pageW * 0.25))
          .sort((a, b) => b.y - a.y);
        for (const l of above) {
          const t = source === "ocr" ? nameRun(l.text) : l.text;
          if (!nameLike(t)) continue;
          if (qr?.name && similarity(normName(qr.name), normName(t)) < 0.5) continue;
          nameLine = t === l.text ? l : { ...l, text: t };
          break;
        }
      }
      if (!nameLine && qr?.name) {
        let best = 0;
        lines.forEach((l) => {
          const s = similarity(normName(qr!.name!), normName(l.text));
          if (s > best && s > 0.6) {
            best = s;
            nameLine = l;
          }
        });
      }
    }
    if (!nameLine) return [];
    let last: TextLine = nameLine;
    for (let k = 0; k < 2; k++) {
      const l = neighbours(lines, last, "below", last.h * 1.3, pageW * 0.06)[0];
      if (l && (RELATION.test(l.text) || INDIC.test(l.text))) last = l;
      else break;
    }
    const lh = Math.max(nameLine.h, 8);
    const next = neighbours(lines, last, "below", lh * 12, pageW * 0.08).find((l) => l.text.replace(/[^A-Za-z0-9]/g, "").length >= 3);
    const y0 = last.y + last.h + lh * 0.1;
    const y1 = next ? Math.min(next.y - lh * 0.1, y0 + lh * 4.5) : y0 + lh * 3;
    const w = Math.max(nameLine.w * 1.25, lh * 9);
    return [reg({ x: nameLine.x - lh * 0.3, y: y0, w: Math.min(w, pageW - nameLine.x), h: Math.max(lh, y1 - y0) }, "DOB / gender missing here")];
  };

  // How well the printed side was read — a missing field is only "removed" when the rest was read well.
  const readWellNoQr =
    source === "pdf" || (validNumbers.some((n) => conf(n) >= 85) && (numbers.length >= 2 || !!cardName || !!letterName));

  // ── QR vs printed ──
  const mismatches: string[] = [];
  const missing: string[] = [];
  let compared = 0;
  if (qr) {
    ev({
      category: "qr",
      severity: "info",
      title: qr.kind === "secure" ? `Secure QR read (${qr.version})` : "Old-style Aadhaar QR read",
      detail:
        qr.kind === "secure"
          ? `The QR holds the cardholder's details${qr.photo ? " and photo" : ""}, signed by UIDAI${qr.hasSignature ? " (signature present; certificate not checked in this version)" : ""}. We compare them with what's printed.`
          : "This older QR holds unsigned details; we still compare them with what's printed.",
      regions: qrRegion,
    });

    // number
    const printedLast4 = [...distinctNumbers.map((n) => n.slice(-4)), ...maskedLast4];
    if (qr.last4 && printedLast4.length) {
      compared++;
      const misreadLast4 = new Set(distinctNumbers.filter(misread).map((n) => n.slice(-4)));
      const wrong = [...new Set(printedLast4.filter((l4) => l4 !== qr!.last4 && !misreadLast4.has(l4)))];
      if (wrong.length) {
        mismatches.push("number");
        const sure = source === "pdf" || conf(wrong[0]) >= 85;
        const where = numbers.filter((n) => n.num.endsWith(wrong[0]));
        ev({
          category: "aadhaar",
          severity: sure ? "critical" : "warning",
          title: "Aadhaar number doesn't match the QR",
          detail: `The QR says the number ends in ${qr.last4}, but the card shows …${wrong[0]}${wrong.length < printedLast4.length ? " (other copies on the card do match the QR — one copy was changed)" : ""}.`,
          regions: [...where.slice(0, 3).map((w) => reg(pad(spanOf(w.line, w.start, w.end)), "number ≠ QR")), ...qrRegion],
          layerId: "aadhaar",
          change: { before: `…${qr.last4} (QR)`, after: `…${wrong[0]} (printed)`, field: "Aadhaar number" },
        });
      }
    }

    // name: the card's name line and the letter's "To" name, each against the QR
    const printedReadable = !!(dob || gender || distinctNumbers.length || maskedLast4.length);
    if (qr.name && printedReadable) {
      const threshold = source === "pdf" ? 0.9 : 0.72;
      const targets = [cardName, letterName].filter((l): l is TextLine & { conf: number } => !!l);
      const qn = normName(qr.name);
      const scoreOf = (t: string) => Math.max(similarity(qn, normName(t)), similarity(qn.replace(/ /g, ""), normName(t).replace(/ /g, "")));
      // word by word: OCR slips a letter ("Kunar" for "Kumar"), an edit changes a word ("Rohan" → "Rohit")
      const changedWord = (t: string): { qrWord: string; printed: string } | null => {
        const pt = normName(t).split(" ").filter(Boolean);
        if (!pt.length) return null;
        if (similarity(qn.replace(/ /g, ""), pt.join("")) >= 0.97) return null;
        for (const q of qn.split(" ").filter((w) => w.length >= 2)) {
          let bestW = "", bs = 0;
          for (const w of pt) {
            const sc = similarity(q, w);
            if (sc > bs) { bs = sc; bestW = w; }
          }
          // merged words (Canva "RohanKumar") contain the QR word
          if (pt.some((w) => w.length > q.length + 2 && w.includes(q))) continue;
          if (bs < 0.8 || (Math.abs(bestW.length - q.length) >= 2 && bs < 0.9)) return { qrWord: q, printed: bestW };
        }
        return null;
      };
      let judged = false;
      for (const l of targets) {
        compared++;
        judged = true;
        const sc = scoreOf(l.text);
        const cw = changedWord(l.text);
        if (sc >= threshold && !cw) continue;
        const wordConf = cw?.printed ? conf(cw.printed) : 0;
        const sure = source === "pdf" || sc < 0.6 || (wordConf >= 85 && !!cw);
        mismatches.push("name");
        ev({
          category: "aadhaar",
          severity: sure ? "critical" : "warning",
          title: "Name doesn't match the QR",
          detail: `The signed QR holds "${qr.name}", but the ${l === cardName ? "card" : "address block"} shows "${l.text}".`,
          regions: [reg(pad(l), "name ≠ QR"), ...qrRegion],
          layerId: "aadhaar",
          change: { before: `${qr.name} (QR)`, after: `${l.text} (printed)`, field: "Name" },
        });
        break;
      }
      if (!judged) {
        const m = bestNameMatch(qr.name, text);
        compared++;
        report.printedName = m.found || undefined;
        if (m.score < threshold) {
          const sure = source === "pdf" || (m.score < 0.5 && !!(dob || gender));
          mismatches.push("name");
          ev({
            category: "aadhaar",
            severity: sure ? "critical" : "warning",
            title: "Name doesn't match the QR",
            detail: `The QR holds "${qr.name}", but the closest printed name is "${m.found || "(none found)"}".`,
            regions: qrRegion,
            layerId: "aadhaar",
            change: { before: `${qr.name} (QR)`, after: `${m.found || "?"} (printed)`, field: "Name" },
          });
        }
      }
    } else if (qr.name && !printedReadable && text.trim().length > 20) {
      ev({
        category: "aadhaar",
        severity: "info",
        title: "Printed details not readable",
        detail: `The QR was read, but the printed text couldn't be read reliably — compare the card with the QR by eye, or use the e-Aadhaar PDF.`,
      });
    }

    // date of birth
    const ocrSure = (needle: string) => conf(needle) >= 85;
    if (dob && ((qr.dob && dob.dob) || (qr.yob && dob.yob))) {
      compared++;
      const dobRegion = [reg(pad(spanOf(dob.line, dob.start, dob.end)), "DOB ≠ QR"), ...qrRegion];
      if (qr.dob && dob.dob && qr.dob.replace(/\//g, "-") !== dob.dob) {
        mismatches.push("dob");
        const sure = ocrSure(dob.dob);
        ev({
          category: "aadhaar",
          severity: sure ? "critical" : "warning",
          title: "Date of birth doesn't match the QR",
          detail: sure
            ? `The UIDAI-signed QR says ${qr.dob}, but the card shows ${dob.dob}.`
            : `The signed QR says ${qr.dob}; the date read from the image is ${dob.dob}. The image text may be misread — check the printed date by eye. If it really shows ${dob.dob}, the card was edited.`,
          regions: dobRegion,
          layerId: "aadhaar",
          change: { before: `${qr.dob} (QR)`, after: `${dob.dob} (printed)`, field: "Date of birth" },
        });
      } else if (!dob.dob && qr.yob && dob.yob && qr.yob !== dob.yob) {
        mismatches.push("yob");
        ev({
          category: "aadhaar",
          severity: ocrSure(dob.yob) ? "critical" : "warning",
          title: "Birth year doesn't match the QR",
          detail: `The QR says ${qr.yob}, but the card shows ${dob.yob}.`,
          regions: dobRegion,
          layerId: "aadhaar",
          change: { before: `${qr.yob} (QR)`, after: `${dob.yob} (printed)`, field: "Year of birth" },
        });
      }
    }

    // gender
    const qg = gender0(qr.gender);
    if (qg && gender) {
      compared++;
      if (qg !== gender.g) {
        mismatches.push("gender");
        ev({
          category: "aadhaar",
          severity: source === "pdf" || conf(gender.line.text) >= 80 ? "critical" : "warning",
          title: "Gender doesn't match the QR",
          detail: `The QR says ${genderWord(qg)}, the card shows ${genderWord(gender.g)}.`,
          regions: [reg(pad(spanOf(gender.line, gender.start, gender.end)), "gender ≠ QR"), ...qrRegion],
          layerId: "aadhaar",
          change: { before: `${genderWord(qg)} (QR)`, after: `${genderWord(gender.g)} (printed)`, field: "Gender" },
        });
      }
    }

    // PIN code (address)
    if (qr.pincode && /^\d{6}$/.test(qr.pincode) && pincodes.length) {
      compared++;
      const wrong = pincodes.filter((p) => p.pin !== qr!.pincode);
      if (wrong.length) {
        mismatches.push("pincode");
        const sure = source === "pdf" || conf(wrong[0].pin) >= 85;
        ev({
          category: "aadhaar",
          severity: sure ? "critical" : "warning",
          title: "Address PIN code doesn't match the QR",
          detail: `The signed QR holds PIN code ${qr.pincode}, but the address shows ${wrong[0].pin}.`,
          regions: [...wrong.slice(0, 2).map((w) => reg(pad(spanOf(w.line, w.start, w.end)), "PIN ≠ QR")), ...qrRegion],
          layerId: "aadhaar",
          change: { before: `${qr.pincode} (QR)`, after: `${wrong[0].pin} (printed)`, field: "PIN code" },
        });
      }
    }
    if (source === "pdf" && qr.district && qr.district.length >= 4 && text.length > 200) {
      const d = qr.district.toLowerCase();
      const present = lines.some((l) => l.text.toLowerCase().includes(d)) || bestNameMatch(qr.district, text).score >= 0.85;
      if (!present) {
        ev({
          category: "aadhaar",
          severity: "warning",
          title: "Address doesn't match the QR",
          detail: `The signed QR says the district is "${qr.district}", but it isn't printed in the address.`,
          regions: qrRegion,
          layerId: "aadhaar",
        });
      }
    }

    // fields the signed QR says must be printed, but aren't
    if (printedReadable) {
      const nameScore = qr.name ? bestNameMatch(qr.name, text).score : 0;
      const readWell = source === "pdf" || (nameScore >= 0.85 && (distinctNumbers.length > 0 || maskedLast4.length > 0 || !!gender));
      const qd = qr.dob?.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      const dateAnywhere = qd ? new RegExp(`${qd[1]}\\s*[/.-]\\s*${qd[2]}\\s*[/.-]\\s*${qd[3]}`).test(text) : false;
      if ((qr.dob || qr.yob) && !dob && !dateAnywhere) {
        missing.push("dob");
        ev({
          category: "aadhaar",
          severity: readWell ? "critical" : "warning",
          title: "Date of birth missing from the card",
          detail: readWell
            ? `The signed QR holds a date of birth (${qr.dob ?? qr.yob}), but no date of birth is printed on the card. Every Aadhaar prints it — it was removed or covered.`
            : `The QR holds a date of birth (${qr.dob ?? qr.yob}) but none could be read from the image. Check the card by eye: if it's really missing, the card was edited.`,
          regions: [...expectedFieldsRegion(), ...qrRegion],
          layerId: "aadhaar",
          change: { before: `${qr.dob ?? qr.yob} (QR)`, after: "(missing)", field: "Date of birth" },
        });
      }
      if (qg && !gender) {
        missing.push("gender");
        ev({
          category: "aadhaar",
          severity: readWell ? "critical" : "warning",
          title: "Gender missing from the card",
          detail: `The QR records the gender (${genderWord(qg)}), but it isn't printed on the card${readWell ? "" : " (or couldn't be read)"}. Every Aadhaar prints it.`,
          regions: [...expectedFieldsRegion(), ...qrRegion],
          layerId: "aadhaar",
          change: { before: `${genderWord(qg)} (QR)`, after: "(missing)", field: "Gender" },
        });
      }
      if (qr.last4 && !distinctNumbers.length && !maskedLast4.length) {
        missing.push("number");
        ev({
          category: "aadhaar",
          severity: source === "pdf" ? "critical" : "warning",
          title: "Aadhaar number missing from the card",
          detail: `The QR belongs to a number ending in ${qr.last4}, but no Aadhaar number (full or masked) is printed or readable.`,
          regions: qrRegion,
          layerId: "aadhaar",
        });
      }
    }

    report.qrMatches = compared > 0 && mismatches.length === 0 && missing.length === 0;
    if (report.qrMatches) {
      const what = [
        qr.name && "name",
        dob && "date of birth",
        gender && "gender",
        qr.last4 && (distinctNumbers.length || maskedLast4.length) && "number",
        qr.pincode && pincodes.length && "PIN code",
      ].filter(Boolean);
      ev({
        category: "aadhaar",
        severity: "pass",
        title: "Printed details match the signed QR",
        detail: `The ${what.join(", ")} printed on the card agree with the UIDAI-signed data inside the QR.`,
      });
    }
    checks.push({
      id: "aad-qr",
      label: "Aadhaar QR vs printed text",
      status: mismatches.length || missing.length ? "flag" : compared ? "pass" : "skip",
      note: compared ? `${compared} field(s) compared${missing.length ? `, ${missing.length} missing` : ""}` : "QR read; printed text not readable",
    });
  } else {
    ev({
      category: "qr",
      severity: "info",
      title: "Aadhaar QR not readable",
      detail:
        "Couldn't read the QR code (forwarded or small images are usually too blurry for the dense Aadhaar QR). Use the e-Aadhaar PDF or a sharp, straight photo where the QR fills a good part of the frame — the QR is the strongest Aadhaar check.",
    });
    checks.push({ id: "aad-qr", label: "Aadhaar QR vs printed text", status: "skip", note: "QR not readable" });

    // Without the QR: the card itself must still print DOB (or year of birth) and gender.
    const cardPresent = numbers.length >= 2 || !!cardName || (!!gender && distinctNumbers.length > 0);
    if (cardPresent && (!dob || !gender)) {
      const what = [!dob && "date of birth", !gender && "gender"].filter(Boolean).join(" and ");
      const sure = readWellNoQr && !dob && !gender;
      ev({
        category: "aadhaar",
        severity: sure || (readWellNoQr && source === "pdf") ? "critical" : "warning",
        title: `${what[0].toUpperCase()}${what.slice(1)} missing from the card`,
        detail: sure
          ? `Every Aadhaar card prints the holder's date of birth and gender under the name. This card's number and name were read clearly, but there is no ${what} — that part was removed or covered.`
          : `Every Aadhaar card prints the date of birth and gender under the name, but no ${what} could be read here. Check the card by eye: if it's really missing, the card was edited.`,
        regions: expectedFieldsRegion(),
        layerId: "aadhaar",
        change: { before: "(printed on every Aadhaar)", after: "(missing)", field: what },
      });
      checks.push({ id: "aad-fields", label: "Required Aadhaar fields", status: "flag", note: `${what} missing` });
    } else if (cardPresent) {
      checks.push({ id: "aad-fields", label: "Required Aadhaar fields", status: "pass", note: "DOB and gender printed" });
    }
  }

  return { evidence, checks, report };
}
