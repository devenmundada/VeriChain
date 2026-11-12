/**
 * Runs the Aadhaar checks and turns them into evidence.
 * DOM-free (QR text is decoded elsewhere) so it can be tested in Node.
 */

import {
  type AadhaarQR,
  aadhaarNumberValid,
  bestNameMatch,
  findAadhaarNumbers,
  findMaskedLast4,
  findPrintedDob,
  findPrintedGender,
  parseAadhaarQR,
} from "./aadhaar";
import type { CheckRun, Evidence, Region, TextBox } from "./types";

export interface AadhaarReport {
  qr: AadhaarQR | null;
  printedNumbers: string[];
  maskedLast4: string[];
  printedDob?: string;
  printedYob?: string;
  printedGender?: string;
  printedName?: string;
  numberValid?: boolean;
  qrMatches?: boolean;
}

export interface QRInput {
  text: string;
  box?: { x: number; y: number; w: number; h: number };
}

function qg0(g?: string) {
  return g?.[0]?.toUpperCase();
}

function maskNumber(n: string) {
  return `XXXX XXXX ${n.slice(-4)}`;
}

function findBoxes(boxes: TextBox[], needle: string): TextBox[] {
  const n = needle.replace(/\s+/g, "");
  if (!n) return [];
  const direct = boxes.filter((b) => b.str.replace(/\s+/g, "").includes(n));
  if (direct.length) return direct;
  // numbers are often split into 4-digit groups across boxes
  if (/^\d{12}$/.test(n)) {
    const groups = [n.slice(0, 4), n.slice(4, 8), n.slice(8)];
    const hits = boxes.filter((b) => groups.some((g) => b.str.replace(/\s+/g, "") === g));
    return hits;
  }
  return [];
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
  const regionsFor = (bs: TextBox[], label?: string): Region[] =>
    bs.slice(0, 4).map((b) => ({ x: b.x / pageW, y: b.y / pageH, w: b.w / pageW, h: b.h / pageH, label }));

  let qr: AadhaarQR | null = null;
  let qrBox: QRInput["box"];
  for (const q of qrs) {
    qr = await parseAadhaarQR(q.text);
    if (qr) {
      qrBox = q.box;
      break;
    }
  }

  const printedNumbers = findAadhaarNumbers(docText);
  const maskedLast4 = findMaskedLast4(docText);
  const pd = findPrintedDob(docText);
  const pg = findPrintedGender(docText);
  const report: AadhaarReport = {
    qr,
    printedNumbers: printedNumbers.map(maskNumber),
    maskedLast4,
    printedDob: pd.dob,
    printedYob: pd.yob,
    printedGender: pg,
  };

  // ── Check digit ──
  if (printedNumbers.length) {
    let allValid = true;
    for (const n of printedNumbers) {
      const res = aadhaarNumberValid(n);
      const bs = findBoxes(boxes, n);
      if (!res.valid) {
        allValid = false;
        const conf = source === "ocr" ? ocrWordConfidence?.(n) ?? 0 : 100;
        const sure = source === "pdf" || conf >= 90;
        ev({
          category: "aadhaar",
          severity: sure ? "critical" : "warning",
          title: "Aadhaar number is not valid",
          detail: sure
            ? `The printed number ${maskNumber(n)} ${res.reason}. Every real Aadhaar number passes this check, and changing even one digit breaks it.`
            : `The number read as ${maskNumber(n)} ${res.reason}. It may have been misread from the image — check the digits by eye. If they are right, the number was changed.`,
          regions: regionsFor(bs, "invalid number"),
          layerId: "aadhaar",
        });
      }
    }
    report.numberValid = allValid;
    if (allValid) {
      ev({
        category: "aadhaar",
        severity: "pass",
        title: "Aadhaar number passes the check digit",
        detail: `${printedNumbers.map(maskNumber).join(", ")} — the Verhoeff check digit is correct (a changed digit would fail).`,
      });
    }
    checks.push({ id: "aad-verhoeff", label: "Aadhaar check digit", status: allValid ? "pass" : "flag" });
  } else {
    checks.push({ id: "aad-verhoeff", label: "Aadhaar check digit", status: "skip", note: maskedLast4.length ? "number is masked" : "number not found" });
  }

  // ── QR vs printed ──
  if (qr) {
    const mismatches: string[] = [];
    let compared = 0;
    const qrRegion: Region[] = qrBox ? [{ x: qrBox.x / pageW, y: qrBox.y / pageH, w: qrBox.w / pageW, h: qrBox.h / pageH, label: "signed QR" }] : [];
    ev({
      category: "qr",
      severity: "info",
      title: qr.kind === "secure" ? `Secure QR read (${qr.version})` : "Old-style Aadhaar QR read",
      detail:
        qr.kind === "secure"
          ? `The QR holds the cardholder's details signed by UIDAI${qr.hasSignature ? " (signature present; certificate not checked in this version)" : ""}. We compare them with what's printed.`
          : "This older QR holds unsigned details; we still compare them with what's printed.",
      regions: qrRegion,
    });

    const printedLast4 = [...printedNumbers.map((n) => n.slice(-4)), ...maskedLast4];
    if (qr.last4 && printedLast4.length) {
      compared++;
      if (!printedLast4.includes(qr.last4)) {
        mismatches.push("number");
        const bs = printedNumbers.length ? findBoxes(boxes, printedNumbers[0]) : boxes.filter((b) => maskedLast4.some((m) => b.str.includes(m)));
        ev({
          category: "aadhaar",
          severity: "critical",
          title: "Aadhaar number doesn't match the QR",
          detail: `The QR says the number ends in ${qr.last4}, but the card shows …${printedLast4[0]}.`,
          regions: [...regionsFor(bs, "number ≠ QR"), ...qrRegion],
          layerId: "aadhaar",
          change: { before: `…${qr.last4} (QR)`, after: `…${printedLast4[0]} (printed)`, field: "Aadhaar number" },
        });
      }
    }
    // Only judge the name when the printed side was actually read (DOB / gender / number found);
    // otherwise OCR noise (e.g. from the QR pattern or the photo) would be compared with the QR.
    const printedReadable = !!(pd.dob || pd.yob || pg || printedNumbers.length || maskedLast4.length);
    if (qr.name && docText.trim().length > 20 && !printedReadable) {
      ev({
        category: "aadhaar",
        severity: "info",
        title: "Printed details not readable",
        detail: `The QR was read (name "${qr.name}", DOB ${qr.dob ?? qr.yob ?? "?"}), but the printed text couldn't be read reliably — compare them by eye, or use the e-Aadhaar PDF.`,
      });
    }
    if (qr.name && docText.trim().length > 20 && printedReadable) {
      const m = bestNameMatch(qr.name, docText);
      compared++;
      report.printedName = m.found || undefined;
      const threshold = source === "pdf" ? 0.9 : 0.72;
      if (m.score < threshold) {
        const sure = source === "pdf" || (m.score < 0.5 && !!(pd.dob || pg));
        mismatches.push("name");
        ev({
          category: "aadhaar",
          severity: sure ? "critical" : "warning",
          title: "Name doesn't match the QR",
          detail: `The QR holds "${qr.name}", but the closest printed name is "${m.found || "(none found)"}".`,
          regions: [...regionsFor(findBoxes(boxes, m.found.split(" ")[0] ?? ""), "name ≠ QR"), ...qrRegion],
          layerId: "aadhaar",
          change: { before: `${qr.name} (QR)`, after: `${m.found || "?"} (printed)`, field: "Name" },
        });
      }
    }
    if ((qr.dob && pd.dob) || (qr.yob && pd.yob)) compared++;
    if (qg0(qr.gender) && pg) compared++;
    if (qr.dob && pd.dob && qr.dob.replace(/\//g, "-") !== pd.dob) {
      mismatches.push("dob");
      const raw = pd.dob.split("-");
      const bs = boxes.filter((b) => b.str.includes(raw[2]) && (b.str.includes(raw[0]) || b.str.includes(raw[1])));
      ev({
        category: "aadhaar",
        severity: "critical",
        title: "Date of birth doesn't match the QR",
        detail: `The signed QR says ${qr.dob}, but the card shows ${pd.dob}.`,
        regions: [...regionsFor(bs, "DOB ≠ QR"), ...qrRegion],
        layerId: "aadhaar",
        change: { before: `${qr.dob} (QR)`, after: `${pd.dob} (printed)`, field: "Date of birth" },
      });
    } else if (qr.yob && pd.yob && qr.yob !== pd.yob) {
      mismatches.push("yob");
      ev({
        category: "aadhaar",
        severity: "critical",
        title: "Birth year doesn't match the QR",
        detail: `The QR says ${qr.yob}, but the card shows ${pd.yob}.`,
        regions: [...regionsFor(boxes.filter((b) => b.str.includes(pd.yob!)), "year ≠ QR"), ...qrRegion],
        layerId: "aadhaar",
        change: { before: `${qr.yob} (QR)`, after: `${pd.yob} (printed)`, field: "Year of birth" },
      });
    }
    const qg = qr.gender?.[0]?.toUpperCase();
    if (qg && pg && qg !== pg) {
      mismatches.push("gender");
      ev({
        category: "aadhaar",
        severity: "critical",
        title: "Gender doesn't match the QR",
        detail: `The QR says ${qg === "M" ? "Male" : qg === "F" ? "Female" : "Transgender"}, the card shows ${pg === "M" ? "Male" : pg === "F" ? "Female" : "Transgender"}.`,
        regions: qrRegion,
        layerId: "aadhaar",
        change: { before: `${qg} (QR)`, after: `${pg} (printed)`, field: "Gender" },
      });
    }
    report.qrMatches = compared > 0 && mismatches.length === 0;
    if (!mismatches.length && compared > 0) {
      ev({
        category: "aadhaar",
        severity: "pass",
        title: "Printed details match the signed QR",
        detail: "Name, date of birth, gender and the number's last 4 digits on the card agree with the data inside the QR.",
      });
    }
    checks.push({
      id: "aad-qr",
      label: "Aadhaar QR vs printed text",
      status: mismatches.length ? "flag" : compared ? "pass" : "skip",
      note: compared ? `${compared} field(s) compared` : "QR read; printed text not readable",
    });
  } else {
    ev({
      category: "qr",
      severity: "info",
      title: "Aadhaar QR not readable",
      detail: "Couldn't read the QR code. Use the e-Aadhaar PDF or a sharp, straight photo where the QR fills a good part of the frame — the QR is the strongest Aadhaar check.",
    });
    checks.push({ id: "aad-qr", label: "Aadhaar QR vs printed text", status: "skip", note: "QR not readable" });
  }

  return { evidence, checks, report };
}
