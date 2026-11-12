/**
 * Builds the demo test set in public/samples/ — a fictional "Demo Institute"
 * marksheet clearly marked SAMPLE, plus edited copies that mimic the most
 * common real-world forgery techniques:
 *
 *  1. marksheet-genuine.pdf            untouched issuer PDF
 *  2. marksheet-edited-whitebox.pdf    online-editor style: white box + retyped mark, file re-saved
 *  3. marksheet-edited-incremental.pdf desktop-editor style: incremental save, marks + total +
 *                                      percentage all changed consistently (arithmetic passes!)
 *  4. marksheet-photo.jpg              photo/scan of the genuine marksheet
 *  5. marksheet-photo-edited.jpg       same photo, one mark whited-out and digits pasted in
 *  6. marksheet-screenshot-edited.png  clean digital image, box painted + digits pasted
 *
 * Run: npm run make-samples   (macOS: uses qlmanage to rasterise the PDF)
 */

import { PDFDocument, StandardFonts, rgb, PDFName, PDFArray, PDFString } from "pdf-lib";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import QRCode from "qrcode";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const out = path.join(root, "public", "samples");
fs.mkdirSync(out, { recursive: true });

// ── Layout (PDF points, origin bottom-left) ──
const PAGE_W = 595, PAGE_H = 842;
const COL = { code: 50, subject: 110, max: 360, obt: 440, grade: 515 };
const TABLE_TOP = 600, ROW_H = 24, FS = 11;
const SUBJECTS = [
  ["CS301", "Data Structures", 100, 78, "B+"],
  ["CS302", "Discrete Mathematics", 100, 45, "C"],
  ["CS303", "Computer Networks", 100, 82, "A"],
  ["CS304", "Operating Systems", 100, 69, "B"],
  ["CS305", "Database Systems", 100, 88, "A"],
  ["HS301", "Professional Ethics", 100, 74, "B+"],
];
const TOTAL_MAX = 600;
const TOTAL = SUBJECTS.reduce((s, r) => s + r[3], 0); // 436
const PCT = ((TOTAL / TOTAL_MAX) * 100).toFixed(2); // 72.67
const rowY = (i) => TABLE_TOP - ROW_H * (i + 1);
const TOTAL_Y = rowY(SUBJECTS.length);
const PCT_Y = TOTAL_Y - 34;

async function makeGenuine() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const fb = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.18);
  const cream = rgb(0.995, 0.985, 0.955);
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: cream });
  page.drawRectangle({ x: 24, y: 24, width: PAGE_W - 48, height: PAGE_H - 48, borderColor: rgb(0.55, 0.45, 0.2), borderWidth: 2 });

  const center = (t, font, size, y, color = ink) =>
    page.drawText(t, { x: (PAGE_W - font.widthOfTextAtSize(t, size)) / 2, y, size, font, color });
  center("DEMO INSTITUTE OF TECHNOLOGY", fb, 18, 770);
  center("SAMPLE DOCUMENT - FOR VERICHAIN DEMO ONLY - NOT A REAL RECORD", f, 8, 752, rgb(0.75, 0.1, 0.1));
  center("Statement of Marks - Semester III (Academic Year 2025-26)", fb, 12, 728);

  const info = [
    ["Name of Student", "ARJUN SAMPLE"],
    ["Roll No.", "DIT/CS/2024/0417"],
    ["Programme", "B.Tech Computer Engineering"],
    ["Examination", "Winter Examination, December 2025"],
  ];
  info.forEach(([k, v], i) => {
    page.drawText(`${k}:`, { x: 60, y: 692 - i * 18, size: 10, font: fb, color: ink });
    page.drawText(v, { x: 190, y: 692 - i * 18, size: 10, font: f, color: ink });
  });

  // header row
  const hdrY = TABLE_TOP;
  page.drawRectangle({ x: 44, y: hdrY - 7, width: PAGE_W - 88, height: 22, color: rgb(0.9, 0.88, 0.82) });
  [["Code", COL.code], ["Subject", COL.subject], ["Max Marks", COL.max], ["Obtained", COL.obt], ["Grade", COL.grade]].forEach(([t, x]) =>
    page.drawText(t, { x, y: hdrY, size: FS, font: fb, color: ink })
  );
  SUBJECTS.forEach(([code, subj, max, obt, grade], i) => {
    const y = rowY(i);
    page.drawText(code, { x: COL.code, y, size: FS, font: f, color: ink });
    page.drawText(subj, { x: COL.subject, y, size: FS, font: f, color: ink });
    page.drawText(String(max), { x: COL.max, y, size: FS, font: f, color: ink });
    page.drawText(String(obt), { x: COL.obt, y, size: FS, font: f, color: ink });
    page.drawText(grade, { x: COL.grade, y, size: FS, font: f, color: ink });
    page.drawLine({ start: { x: 44, y: y - 8 }, end: { x: PAGE_W - 44, y: y - 8 }, thickness: 0.4, color: rgb(0.7, 0.7, 0.7) });
  });
  page.drawText("Total", { x: COL.subject, y: TOTAL_Y, size: FS, font: fb, color: ink });
  page.drawText(String(TOTAL_MAX), { x: COL.max, y: TOTAL_Y, size: FS, font: fb, color: ink });
  page.drawText(String(TOTAL), { x: COL.obt, y: TOTAL_Y, size: FS, font: fb, color: ink });
  page.drawText(`Percentage: ${PCT} %`, { x: COL.subject, y: PCT_Y, size: FS, font: fb, color: ink });
  page.drawText("Result: PASS - First Class", { x: COL.subject, y: PCT_Y - 20, size: FS, font: f, color: ink });

  // verification QR, as many universities print (reserved .example domain)
  const qrPng = await QRCode.toBuffer("https://results.demo-institute.example/verify/DIT-CS-2024-0417", { margin: 1, scale: 6, errorCorrectionLevel: "M" });
  const qrImg = await doc.embedPng(qrPng);
  page.drawImage(qrImg, { x: 60, y: 110, width: 78, height: 78 });
  page.drawText("Scan to verify", { x: 66, y: 100, size: 7, font: f, color: ink });

  page.drawText("Controller of Examinations", { x: 380, y: 150, size: 10, font: fb, color: ink });
  page.drawLine({ start: { x: 375, y: 168 }, end: { x: 530, y: 168 }, thickness: 0.8, color: ink });
  center("Issued electronically by the DIT Exam Cell. This is a fictional sample for testing tamper detection.", f, 7.5, 60, rgb(0.4, 0.4, 0.4));

  doc.setTitle("Statement of Marks - ARJUN SAMPLE");
  doc.setAuthor("Demo Institute of Technology");
  doc.setProducer("DIT Exam Cell Results System 4.2 (VeriChain sample)");
  doc.setCreator("DIT Results Portal");
  const created = new Date("2026-01-08T10:30:00+05:30");
  doc.setCreationDate(created);
  doc.setModificationDate(created);
  return Buffer.from(await doc.save({ useObjectStreams: false, updateMetadata: false }));
}

async function makeWhiteboxEdit(genuine) {
  const doc = await PDFDocument.load(genuine, { updateMetadata: false });
  const page = doc.getPage(0);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const y = rowY(1); // Discrete Mathematics: 45 → 85
  page.drawRectangle({ x: COL.obt - 1, y: y - 3, width: 16, height: 13, color: rgb(0.995, 0.985, 0.955) });
  page.drawText("85", { x: COL.obt, y, size: FS, font: f, color: rgb(0.1, 0.1, 0.18) });
  doc.setProducer("iLovePDF");
  doc.setModificationDate(new Date("2026-11-10T22:14:00+05:30"));
  return Buffer.from(await doc.save({ useObjectStreams: false, updateMetadata: false }));
}

/** Appends a real incremental update (what Acrobat/Foxit "Save" does). */
async function makeIncrementalEdit(genuine) {
  const doc = await PDFDocument.load(genuine, { updateMetadata: false });
  const ctx = doc.context;
  const page = doc.getPage(0);
  const text = genuine.toString("latin1");
  const prevXref = Number(text.match(/startxref\s+(\d+)\s+%%EOF\s*$/)[1]);

  // find the Helvetica resource name on the page
  const fontDict = page.node.Resources().lookup(PDFName.of("Font"));
  let helv = null;
  for (const [k, v] of fontDict.entries()) {
    const fd = ctx.lookup(v);
    const base = fd.get(PDFName.of("BaseFont"))?.toString();
    if (base === "/Helvetica") helv = k.toString();
  }
  if (!helv) throw new Error("Helvetica resource not found");

  const cream = "0.995 0.985 0.955 rg";
  const edits = [
    { x: COL.obt, y: rowY(4), w: 16, txt: "98" }, // Database Systems 88 → 98
    { x: COL.obt, y: TOTAL_Y, w: 22, txt: "446", bold: true }, // Total 436 → 446
  ];
  let ops = "q\n";
  for (const e of edits) ops += `${cream} ${e.x - 1} ${e.y - 3} ${e.w} 13 re f\n`;
  // percentage 72.67 → 74.33
  const pctX = COL.subject + 64;
  ops += `${cream} ${pctX - 1} ${PCT_Y - 3} 30 13 re f\n`;
  ops += "Q\n";
  // fontDict keys for bold
  let helvB = null;
  for (const [k, v] of fontDict.entries()) {
    const base = ctx.lookup(v).get(PDFName.of("BaseFont"))?.toString();
    if (base === "/Helvetica-Bold") helvB = k.toString();
  }
  for (const e of edits) ops += `BT 0.1 0.1 0.18 rg ${e.bold ? helvB : helv} ${FS} Tf ${e.x} ${e.y} Td (${e.txt}) Tj ET\n`;
  ops += `BT 0.1 0.1 0.18 rg ${helvB} ${FS} Tf ${pctX} ${PCT_Y} Td (74.33) Tj ET\n`;

  let next = ctx.largestObjectNumber + 1;
  const streamNum = next++;
  const infoNum = next++;
  const pageRef = page.ref;
  const contents = page.node.get(PDFName.of("Contents"));
  const arr = PDFArray.withContext(ctx);
  if (contents instanceof PDFArray) for (let i = 0; i < contents.size(); i++) arr.push(contents.get(i));
  else arr.push(contents);
  arr.push(ctx.obj(null)); // placeholder, replaced in string form below
  const pageDict = page.node.clone(ctx);
  pageDict.set(PDFName.of("Contents"), arr);
  const pageStr = pageDict.toString().replace(/null\s*\]/, `${streamNum} 0 R ]`);

  const info = ctx.lookup(ctx.trailerInfo.Info).clone(ctx);
  info.set(PDFName.of("Producer"), PDFString.of("Foxit PDF Editor 13.0"));
  info.set(PDFName.of("ModDate"), PDFString.of("D:20261111091500+05'30'"));

  const chunks = [];
  let offset = genuine.length;
  const offsets = {};
  const push = (s) => {
    const b = Buffer.from(s, "latin1");
    chunks.push(b);
    offset += b.length;
  };
  push("\n");
  offsets[streamNum] = offset;
  push(`${streamNum} 0 obj\n<< /Length ${Buffer.byteLength(ops, "latin1")} >>\nstream\n${ops}endstream\nendobj\n`);
  offsets[pageRef.objectNumber] = offset;
  push(`${pageRef.objectNumber} ${pageRef.generationNumber} obj\n${pageStr}\nendobj\n`);
  offsets[infoNum] = offset;
  push(`${infoNum} 0 obj\n${info.toString()}\nendobj\n`);
  const xrefAt = offset;
  const entry = (n) => `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  let xref = "xref\n0 1\n0000000000 65535 f \n";
  for (const n of [pageRef.objectNumber, streamNum, infoNum].sort((a, b) => a - b)) xref += `${n} 1\n${entry(n)}`;
  push(xref);
  push(`trailer\n<< /Size ${next} /Root ${ctx.trailerInfo.Root.toString()} /Info ${infoNum} 0 R /Prev ${prevXref} >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  return Buffer.concat([genuine, ...chunks]);
}

/**
 * Appends a signature dictionary as an incremental save — the same file structure a
 * signing step (DigiLocker, Acrobat) produces. The /Contents is a zero placeholder:
 * this is a test fixture for the "changed after signing" logic, not a real certificate.
 */
function addSignatureStructure(base, signer) {
  const text = base.toString("latin1");
  const prevXref = Number(text.match(/startxref\s+(\d+)\s+%%EOF\s*$/)[1]);
  const size = Number([...text.matchAll(/\/Size\s+(\d+)/g)].pop()[1]);
  const root = [...text.matchAll(/\/Root\s+(\d+\s+\d+\s+R)/g)].pop()[1];
  const info = [...text.matchAll(/\/Info\s+(\d+\s+\d+\s+R)/g)].pop()[1];
  const n = size;
  const PH = "0000000000 0000000000 0000000000 0000000000";
  const objStart = base.length + 1;
  const obj = `${n} 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /Name (${signer}) /M (D:20260108103500+05'30') /ByteRange [${PH}] /Contents <${"0".repeat(512)}> >>\nendobj\n`;
  const xrefAt = objStart + obj.length;
  const tail = `xref\n0 1\n0000000000 65535 f \n${n} 1\n${String(objStart).padStart(10, "0")} 00000 n \ntrailer\n<< /Size ${n + 1} /Root ${root} /Info ${info} /Prev ${prevXref} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  let appended = "\n" + obj + tail;
  const total = base.length + appended.length;
  const cStart = objStart + obj.indexOf("/Contents <") + "/Contents ".length;
  const cEnd = objStart + obj.indexOf(">", obj.indexOf("/Contents <")) + 1;
  const br = [0, cStart, cEnd, total - cEnd].map((v) => String(v).padStart(10, "0")).join(" ");
  appended = appended.replace(PH, br);
  return Buffer.concat([base, Buffer.from(appended, "latin1")]);
}

// ── Raster helpers ──
function rasterise(pdfPath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vc-"));
  execFileSync("qlmanage", ["-t", "-s", "1700", "-o", tmp, pdfPath], { stdio: "ignore" });
  const pngPath = path.join(tmp, path.basename(pdfPath) + ".png");
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  return png; // { width, height, data RGBA }
}

function clone(img) {
  return { width: img.width, height: img.height, data: Buffer.from(img.data) };
}

// deterministic noise
let seed = 1234567;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function toPhoto(img) {
  const { width: W, height: H } = img;
  const src = img.data;
  const blurred = Buffer.from(src);
  // light 3x3 blur = camera optics
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++)
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += src[((y + dy) * W + x + dx) * 4 + c];
        blurred[(y * W + x) * 4 + c] = s / 9;
      }
  const outBuf = Buffer.from(blurred);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const light = 0.93 + 0.07 * (1 - Math.hypot(x / W - 0.45, y / H - 0.4)); // uneven lighting
      const n = gauss() * 4.2;
      outBuf[i] = Math.max(0, Math.min(255, blurred[i] * light * 0.99 + n));
      outBuf[i + 1] = Math.max(0, Math.min(255, blurred[i + 1] * light * 0.97 + n));
      outBuf[i + 2] = Math.max(0, Math.min(255, blurred[i + 2] * light * 0.92 + n));
    }
  return { width: W, height: H, data: outBuf };
}

function pdfToPx(img, x, y) {
  const s = img.width / PAGE_W;
  return { x: Math.round(x * s), y: Math.round((PAGE_H - y) * s), s };
}

function copyRect(dst, src, sx, sy, w, h, dx, dy) {
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const si = ((sy + y) * src.width + sx + x) * 4, di = ((dy + y) * dst.width + dx + x) * 4;
      for (let c = 0; c < 4; c++) dst.data[di + c] = src.data[si + c];
    }
}

function fillRect(dst, x0, y0, w, h, rgbv) {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * dst.width + x) * 4;
      dst.data[i] = rgbv[0]; dst.data[i + 1] = rgbv[1]; dst.data[i + 2] = rgbv[2]; dst.data[i + 3] = 255;
    }
}

function avgColor(img, x0, y0, w, h) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * img.width + x) * 4;
      r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
    }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

function writeJpeg(img, file, quality) {
  fs.writeFileSync(file, jpeg.encode({ width: img.width, height: img.height, data: img.data }, quality).data);
}

function writePng(img, file) {
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy(png.data);
  fs.writeFileSync(file, PNG.sync.write(png));
}

// ── Build ──
const genuine = await makeGenuine();
fs.writeFileSync(path.join(out, "marksheet-genuine.pdf"), genuine);
fs.writeFileSync(path.join(out, "marksheet-edited-whitebox.pdf"), await makeWhiteboxEdit(genuine));
fs.writeFileSync(path.join(out, "marksheet-edited-incremental.pdf"), await makeIncrementalEdit(genuine));
const signed = addSignatureStructure(genuine, "Demo Institute Exam Cell");
fs.writeFileSync(path.join(out, "marksheet-signed.pdf"), signed);
fs.writeFileSync(path.join(out, "marksheet-signed-then-edited.pdf"), await makeIncrementalEdit(signed));

const clean = rasterise(path.join(out, "marksheet-genuine.pdf"));
const photo = toPhoto(clean);
writeJpeg(photo, path.join(out, "marksheet-photo.jpg"), 88);

// cell geometry: "45" (row 1) → replace with "88" copied from row 4
const tgt = pdfToPx(clean, COL.obt - 2, rowY(1) + FS);
const srcCell = pdfToPx(clean, COL.obt - 2, rowY(4) + FS);
const cw = Math.round(18 * tgt.s), ch = Math.round((FS + 5) * tgt.s);

// photo forgery: white-out (flat paper colour, no grain) + digits pasted from the clean render
const photoEdit = clone(photo);
const paper = avgColor(photo, tgt.x + cw + 6, tgt.y, 12, ch);
fillRect(photoEdit, tgt.x, tgt.y, cw, ch, paper);
const tintedClean = clone(clean);
for (let i = 0; i < tintedClean.data.length; i += 4) {
  tintedClean.data[i] *= 0.95; tintedClean.data[i + 1] *= 0.93; tintedClean.data[i + 2] *= 0.88;
}
copyRect(photoEdit, tintedClean, srcCell.x, srcCell.y, cw, ch, tgt.x, tgt.y);
writeJpeg(photoEdit, path.join(out, "marksheet-photo-edited.jpg"), 88);

// genuine digital screenshot (tests that the QR's white margin etc. don't raise false alarms)
writePng(clean, path.join(out, "marksheet-screenshot.png"));

// digital screenshot forgery: slightly-off box + pasted digits sitting 3px low
const shot = clone(clean);
const bg = avgColor(clean, tgt.x + cw + 6, tgt.y, 10, ch);
fillRect(shot, tgt.x - 2, tgt.y - 2, cw + 4, ch + 4, bg.map((v) => Math.max(0, v - 3)));
copyRect(shot, clean, srcCell.x, srcCell.y, cw, ch - 3, tgt.x, tgt.y + 3);
writePng(shot, path.join(out, "marksheet-screenshot-edited.png"));

const manifest = [
  { file: "marksheet-genuine.pdf", title: "Genuine marksheet", kind: "PDF", expect: "No signs of editing" },
  { file: "marksheet-edited-whitebox.pdf", title: "Edited: white box + retyped mark", kind: "PDF", expect: "Edited (45 → 85)" },
  { file: "marksheet-edited-incremental.pdf", title: "Edited: marks, total & % changed", kind: "PDF", expect: "Edited (hidden earlier version)" },
  { file: "marksheet-signed.pdf", title: "Signed marksheet (like DigiLocker)", kind: "PDF", expect: "No signs of editing (signed, nothing added after)" },
  { file: "marksheet-signed-then-edited.pdf", title: "Signed, then edited", kind: "PDF", expect: "Edited (changed after it was signed)" },
  { file: "marksheet-photo.jpg", title: "Photo of genuine marksheet", kind: "JPG", expect: "No signs of editing" },
  { file: "marksheet-photo-edited.jpg", title: "Photo: mark whited-out & pasted", kind: "JPG", expect: "Edited / suspicious area" },
  { file: "marksheet-screenshot.png", title: "Screenshot of genuine marksheet", kind: "PNG", expect: "No signs of editing" },
  { file: "marksheet-screenshot-edited.png", title: "Screenshot: pasted digits", kind: "PNG", expect: "Edited / suspicious area" },
];
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("samples written to", out);
for (const m of manifest) console.log(" -", m.file, fs.statSync(path.join(out, m.file)).size, "bytes");
