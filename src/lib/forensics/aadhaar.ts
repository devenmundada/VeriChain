/**
 * Aadhaar checks — no original needed, because the card carries signed data.
 *
 *  - Secure QR (2019+): a big decimal number → bytes → gzip → fields separated
 *    by 0xFF, followed by the UIDAI RSA-2048 signature (last 256 bytes).
 *    Holds name, DOB, gender, address and the last 4 digits of the number.
 *  - Old QR: plain XML <PrintLetterBarcodeData uid=… name=… />.
 *  - Verhoeff check digit: every valid Aadhaar number passes it, and changing
 *    any single digit (or swapping two neighbours) always makes it fail.
 *
 * Pure functions here have no DOM dependency so they can be unit-tested in Node.
 */

export interface AadhaarQR {
  kind: "secure" | "xml";
  version?: string;
  name?: string;
  dob?: string; // DD-MM-YYYY or YYYY
  yob?: string;
  gender?: string; // M / F / T
  last4?: string;
  uid?: string; // full number (old XML QR only)
  careOf?: string;
  district?: string;
  state?: string;
  pincode?: string;
  vtc?: string;
  referenceId?: string;
  hasSignature: boolean;
}

// ── Verhoeff ──
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

export function verhoeffValid(num: string): boolean {
  const digits = num.replace(/\D/g, "");
  if (!digits.length) return false;
  let c = 0;
  const rev = digits.split("").reverse();
  for (let i = 0; i < rev.length; i++) c = D[c][P[i % 8][Number(rev[i])]];
  return c === 0;
}

/** Check digit to append to `num` (used only to build test data). */
export function verhoeffCheckDigit(num: string): number {
  let c = 0;
  const rev = num.replace(/\D/g, "").split("").reverse();
  for (let i = 0; i < rev.length; i++) c = D[c][P[(i + 1) % 8][Number(rev[i])]];
  return INV[c];
}

export function aadhaarNumberValid(num: string): { valid: boolean; reason?: string } {
  const d = num.replace(/\D/g, "");
  if (d.length !== 12) return { valid: false, reason: "must have 12 digits" };
  if (d[0] === "0" || d[0] === "1") return { valid: false, reason: "can't start with 0 or 1" };
  if (!verhoeffValid(d)) return { valid: false, reason: "fails the Verhoeff check digit" };
  return { valid: true };
}

/** 12-digit Aadhaar-looking numbers in free text (skips 16-digit VIDs). */
export function findAadhaarNumbers(text: string): string[] {
  const out: string[] = [];
  const re = /(?<!\d[ \u00a0]?)([2-9]\d{3})[  ]?(\d{4})[  ]?(\d{4})(?![  ]?\d)/g;
  for (const m of text.matchAll(re)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 8), m.index ?? 0);
    if (/VID\s*:?\s*$/i.test(before)) continue;
    out.push(m[1] + m[2] + m[3]);
  }
  return [...new Set(out)];
}

export function findMaskedLast4(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:X{4}|x{4}|\*{4})[  ]?(?:X{4}|x{4}|\*{4})[  ]?(\d{4})/g)) out.push(m[1]);
  return [...new Set(out)];
}

// ── QR parsing ──

function bigDecimalToBytes(dec: string): Uint8Array {
  let hex = BigInt(dec).toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } catch (e) {
    // trailing bytes after the gzip member are fine if we already have data
    if (!total) throw e;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function xmlAttr(xml: string, name: string) {
  return xml.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"))?.[1];
}

export async function parseAadhaarQR(text: string): Promise<AadhaarQR | null> {
  const t = text.trim();
  if (/PrintLetterBarcodeData/i.test(t)) {
    const uid = xmlAttr(t, "uid");
    return {
      kind: "xml",
      uid,
      last4: uid?.replace(/\D/g, "").slice(-4),
      name: xmlAttr(t, "name"),
      gender: xmlAttr(t, "gender"),
      yob: xmlAttr(t, "yob") ?? normDob(xmlAttr(t, "dob"))?.slice(-4),
      dob: normDob(xmlAttr(t, "dob")),
      careOf: xmlAttr(t, "co"),
      district: xmlAttr(t, "dist"),
      state: xmlAttr(t, "state"),
      pincode: xmlAttr(t, "pc"),
      vtc: xmlAttr(t, "vtc"),
      hasSignature: false,
    };
  }
  if (!/^\d{200,}$/.test(t)) return null;
  let raw: Uint8Array;
  try {
    raw = await gunzip(bigDecimalToBytes(t));
  } catch {
    return null;
  }
  const fields: string[] = [];
  let start = 0;
  const dec = new TextDecoder("latin1");
  for (let i = 0; i < raw.length && fields.length < 20; i++) {
    if (raw[i] === 255) {
      fields.push(dec.decode(raw.slice(start, i)));
      start = i + 1;
    }
  }
  if (fields.length < 6) return null;
  const off = /^V\d+$/.test(fields[0]) ? 1 : 0;
  const f = (n: number) => fields[off + n]?.trim() || undefined;
  const referenceId = f(1);
  const dob = normDob(f(3));
  return {
    kind: "secure",
    version: off ? fields[0] : "V1",
    referenceId,
    last4: referenceId?.slice(0, 4),
    name: f(2),
    dob,
    yob: dob?.match(/(\d{4})$/)?.[1],
    gender: f(4),
    careOf: f(5),
    district: f(6),
    pincode: f(10),
    state: f(12),
    vtc: f(15),
    hasSignature: raw.length > 256,
  };
}

// ── Comparing QR (signed) with what is printed ──

export function normName(s: string) {
  return s.toUpperCase().replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();
}

export function similarity(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - dp[m][n] / Math.max(m, n);
}

/** Best match of `needle` inside the lines of `hay`, by sliding a window of the same word count. */
export function bestNameMatch(needle: string, hay: string): { score: number; found: string } {
  const target = normName(needle);
  const words = target.split(" ").length;
  let best = { score: 0, found: "" };
  for (const line of hay.split(/\n/)) {
    const toks = normName(line).split(" ").filter(Boolean);
    for (let i = 0; i + words <= toks.length; i++) {
      const cand = toks.slice(i, i + words).join(" ");
      const s = similarity(target, cand);
      if (s > best.score) best = { score: s, found: cand };
    }
  }
  return best;
}

export function findPrintedDob(text: string): { dob?: string; yob?: string } {
  // Only a date explicitly labelled as birth date counts — e-Aadhaar also prints issue/download dates.
  const m = text.match(/(?:DOB|D\.O\.B|Date of Birth|जन्म तिथि)\s*[:/-]?\s*(\d{2})[/.-](\d{2})[/.-](\d{4})/i);
  if (m) return { dob: `${m[1]}-${m[2]}-${m[3]}`, yob: m[3] };
  const y = text.match(/(?:Year of Birth|YOB|जन्म वर्ष)\s*[:/-]?\s*(\d{4})/i);
  if (y) return { yob: y[1] };
  return {};
}

/** Normalise a QR date (DD-MM-YYYY, DD/MM/YYYY or YYYY-MM-DD) to DD-MM-YYYY. */
export function normDob(d?: string): string | undefined {
  if (!d) return undefined;
  const t = d.trim();
  let m = t.match(/^(\d{2})[/.-](\d{2})[/.-](\d{4})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{4})[/.-](\d{2})[/.-](\d{2})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return t;
}

export function findPrintedGender(text: string): string | undefined {
  if (/\b(FEMALE|महिला)\b/i.test(text)) return "F";
  if (/\b(MALE|पुरुष)\b/i.test(text)) return "M";
  if (/\bTRANSGENDER\b/i.test(text)) return "T";
  return undefined;
}

export function looksLikeAadhaar(text: string) {
  return /aadhaar|aadhar|uidai|unique identification authority|आधार|enrolment\s*no|enrollment\s*no|mera aadhaar/i.test(text);
}
