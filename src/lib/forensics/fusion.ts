/**
 * Fusion — one verdict and one heatmap from all detectors.
 *
 * Rule: a region is flagged on its own only by a deterministic ("critical")
 * layer — hidden earlier version, covered text, preview mismatch, failed
 * arithmetic, QR mismatch. Pixel-statistics layers flag a region only when
 * at least two *independent* groups agree on it.
 */

import type { CheckRun, Evidence, Region, Severity, TamperLayer, VerdictKind } from "./types";
import { TamperGrid } from "./types";

const GROUP: Record<string, string> = {
  "pdf-text": "text",
  "pdf-annot": "annot",
  "pdf-font": "font",
  "pdf-revision": "revision",
  "px-noise": "noise",
  "px-ela": "compression",
  "px-bg": "background",
  glyph: "glyph",
  thumb: "thumbnail",
  marksheet: "math",
  registry: "registry",
};

export interface FusionResult {
  verdict: VerdictKind;
  title: string;
  summary: string;
  score: number;
  risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  confidence: number;
  fused: TamperGrid;
  evidence: Evidence[];
  hotspots: { x: number; y: number; width: number; height: number; intensity: number; type: "ela" | "clone" | "noise" | "edit" }[];
  changes: { before: string; after: string; field?: string }[];
}

const SEV_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2, pass: 3 };
const DETERMINISTIC = new Set(["pdf-text", "pdf-structure", "marksheet", "aadhaar", "registry"]);

/** The part that actually changed ("Percentage: 72.67" → "Percentage:74.33" is "72.67→74.33"). */
function changeKey(before: string, after: string) {
  const a = before.replace(/\s+/g, ""), b = after.replace(/\s+/g, "");
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  while (p > 0 && /[\w.]/.test(a[p - 1])) p--;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  while (q > 0 && /[\w.]/.test(a[a.length - q])) q--;
  return `${a.slice(p, a.length - q)}→${b.slice(p, b.length - q)}`;
}

function dedupe(evidence: Evidence[]): Evidence[] {
  const out: Evidence[] = [];
  const byChange = new Map<string, Evidence>();
  for (const e of evidence) {
    if (e.change && e.change.after && e.severity === "critical") {
      const key = changeKey(e.change.before, e.change.after);
      const prev = byChange.get(key);
      if (prev) {
        // the recovered earlier version is the more convincing headline
        if (e.layerId === "pdf-revision" && prev.layerId !== "pdf-revision") {
          const otherDetail = prev.detail;
          prev.title = e.title;
          prev.detail = `${e.detail} ${otherDetail}`;
          prev.layerId = e.layerId;
          prev.category = e.category;
        } else if (!prev.detail.includes(e.detail)) {
          prev.detail += ` ${e.detail}`;
        }
        prev.regions = [...(prev.regions ?? []), ...(e.regions ?? [])].slice(0, 8);
        // show the most focused label ("72.67 → 74.33" rather than "Percentage: 72.67 → Percentage:74.33")
        if (prev.change && e.change && e.change.before.length + e.change.after.length < prev.change.before.length + prev.change.after.length)
          prev.change = { ...e.change, field: e.change.field ?? prev.change.field };
        continue;
      }
      byChange.set(key, e);
    }
    out.push(e);
  }
  return out.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
}

export function fuse(
  grid: TamperGrid,
  layers: TamperLayer[],
  evidenceIn: Evidence[],
  checks: CheckRun[],
  opts: { lowContent?: boolean; idCard?: boolean; idVerifiable?: boolean; idMask?: Uint8Array; smallImage?: boolean } = {}
): FusionResult {
  const fused = TamperGrid.like(grid);
  const C = fused.cols, R = fused.rows;
  // ID cards (Aadhaar) have photos, emblems, colour bands, Hindi and bold fonts that trip pixel/font
  // statistics. There, statistical findings only count on the identity fields (name, DOB, gender,
  // number — idMask); elsewhere they're shown for information only.
  const STATISTICAL = new Set(["px-noise", "px-ela", "px-bg", "glyph", "pdf-font"]);
  const mask = opts.idCard ? opts.idMask : undefined;
  const gridLayers = layers
    .filter((l) => l.grid)
    .map((l) =>
      opts.idCard && STATISTICAL.has(l.id)
        ? { ...l, grid: mask ? l.grid!.map((v, k) => (mask[k] ? v : 0)) : new Float32Array(l.grid!.length) }
        : l
    );
  const agree = new Uint8Array(fused.data.length);

  for (let k = 0; k < fused.data.length; k++) {
    let crit = 0;
    const groups = new Map<string, number>();
    const r = Math.floor(k / C), c = k % C;
    for (const l of gridLayers) {
      const g = l.grid!;
      if (l.critical) {
        if (g[k] > crit) crit = g[k];
        continue;
      }
      // allow one cell of misalignment between independent detectors
      let best = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= R || cc >= C) continue;
          const v = g[rr * C + cc];
          if (v > best) best = v;
        }
      }
      const own = g[k];
      if (own >= 0.5 || best >= 0.5) {
        const grp = GROUP[l.id] ?? l.id;
        groups.set(grp, Math.max(groups.get(grp) ?? 0, Math.max(own, best * 0.9)));
      }
    }
    let v = crit;
    if (groups.size >= 2) {
      v = Math.max(v, 0.85);
      agree[k] = 1;
    }
    // a single statistical detector on its own is not painted on the combined map
    // (it shows in its own layer) — borders, colour bands and logos would glow otherwise
    fused.data[k] = v;
  }

  // A background patch on its own is easily caused by logos, photos or QR margins — only a
  // warning when another detector agrees on the same spot; otherwise just information.
  const evidence = evidenceIn.map((e) => {
    if (e.layerId !== "px-bg" || e.severity !== "warning" || !e.regions?.length) return e;
    const others = gridLayers.filter((l) => l.id !== "px-bg");
    const corroborated = e.regions.some((rg) => {
      const c0 = Math.max(0, Math.floor((rg.x * fused.width) / fused.cellW) - 1), c1 = Math.min(C - 1, Math.ceil(((rg.x + rg.w) * fused.width) / fused.cellW) + 1);
      const r0 = Math.max(0, Math.floor((rg.y * fused.height) / fused.cellH) - 1), r1 = Math.min(R - 1, Math.ceil(((rg.y + rg.h) * fused.height) / fused.cellH) + 1);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (others.some((l) => l.grid![r * C + c] >= 0.5)) return true;
      return false;
    });
    return corroborated ? e : { ...e, severity: "info" as const, title: "Possible background patch (one check only)" };
  });
  // Agreement between independent pixel detectors
  const agreeGrid = TamperGrid.like(grid);
  for (let k = 0; k < fused.data.length; k++) if (agree[k]) agreeGrid.data[k] = 1;
  const agreeRegions = agreeGrid.regions(0.5).filter((rg) => rg.w * rg.h < 0.25);
  if (agreeRegions.length) {
    evidence.push({
      id: "fusion-agree",
      category: "pixel",
      severity: "warning",
      title: `Independent checks agree on ${agreeRegions.length} area${agreeRegions.length > 1 ? "s" : ""}`,
      detail:
        "Two or more unrelated pixel tests (noise, compression, background, glyph shape) flag the same spot. That's the strongest sign of a local edit that pixel analysis alone can give.",
      regions: agreeRegions.map((rg) => ({ ...rg, label: "checks agree" })),
    });
  }

  const idInfo =
    "Shown for information only: ID cards have photos, emblems and colour bands that trip pixel and font statistics, so the verdict uses the QR, check digit and file structure instead. ";
  const onIdField = (e: Evidence) =>
    !!mask &&
    (e.regions ?? []).some((rg) => {
      const c0 = Math.max(0, Math.floor((rg.x * fused.width) / fused.cellW)), c1 = Math.min(C - 1, Math.floor(((rg.x + rg.w) * fused.width) / fused.cellW));
      const r0 = Math.max(0, Math.floor((rg.y * fused.height) / fused.cellH)), r1 = Math.min(R - 1, Math.floor(((rg.y + rg.h) * fused.height) / fused.cellH));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (mask[r * C + c]) return true;
      return false;
    });
  // ID cards: one statistical detector alone is information only; two independent detectors
  // agreeing on an identity field (name, DOB, gender, number) stay a warning.
  const ev = dedupe(evidence).map((e) =>
    opts.idCard &&
    (e.severity === "warning" || e.severity === "critical") &&
    (e.category === "pixel" || e.category === "glyph" || e.category === "pdf-font") &&
    !(e.id === "fusion-agree" && onIdField(e))
      ? { ...e, severity: "info" as const, detail: idInfo + e.detail }
      : e
  );
  const crit = ev.filter((e) => e.severity === "critical");
  const warn = ev.filter((e) => e.severity === "warning");
  const pass = ev.filter((e) => e.severity === "pass");
  const ran = checks.filter((c) => c.status !== "skip").length;
  const coverage = Math.min(1, ran / 6 + pass.length * 0.1);

  let verdict: VerdictKind;
  let title: string;
  if (ev.some((e) => e.category === "registry" && e.severity === "pass") && !crit.length) {
    verdict = "MATCHES_ORIGINAL";
    title = "Matches the registered original";
  } else if (crit.length) {
    verdict = "EDITED";
    title = "Edited — evidence found";
  } else if (warn.length) {
    verdict = "SUSPICIOUS";
    title = warn.length >= 3 ? "Likely edited" : "Suspicious — check the flagged areas";
  } else if (opts.idCard && opts.idVerifiable === false) {
    verdict = "INCONCLUSIVE";
    title = opts.smallImage ? "Couldn't verify — image too small" : "Couldn't verify — QR not readable";
  } else if (ran < 3 || opts.lowContent) {
    verdict = "INCONCLUSIVE";
    title = "Not enough evidence to judge";
  } else {
    verdict = "NO_SIGNS";
    title = "No signs of editing found";
  }

  let score: number;
  let risk: FusionResult["risk"];
  let confidence: number;
  switch (verdict) {
    case "MATCHES_ORIGINAL":
      score = 100; risk = "LOW"; confidence = 99; break;
    case "EDITED": {
      score = Math.max(3, 30 - 8 * (crit.length - 1) - 3 * warn.length);
      risk = "CRITICAL";
      confidence = crit.some((e) => DETERMINISTIC.has(e.category)) ? 97 : 85;
      break;
    }
    case "SUSPICIOUS":
      score = Math.max(40, Math.min(69, 64 - 7 * (warn.length - 1)));
      risk = warn.length >= 3 ? "HIGH" : "MEDIUM";
      confidence = 60 + Math.min(25, warn.length * 6);
      break;
    case "INCONCLUSIVE":
      score = 70; risk = "MEDIUM"; confidence = 40; break;
    default:
      score = Math.round(80 + 15 * coverage);
      risk = "LOW";
      confidence = Math.round(55 + 40 * coverage);
  }

  const changes = ev.filter((e) => e.change && e.severity === "critical").map((e) => e.change!);
  const summary =
    verdict === "INCONCLUSIVE" && opts.idCard && opts.idVerifiable === false && opts.smallImage
      ? "No signs of editing were found in what could be read, but this image is too small (forwarded or downsized) to read the card's digits and QR reliably — so it can't be verified. Upload the e-Aadhaar PDF, or a sharper photo where the text and QR are clear."
      : verdict === "INCONCLUSIVE" && opts.idCard && opts.idVerifiable === false
      ? "The Aadhaar QR code couldn't be read, so the strongest check (UIDAI-signed QR vs printed details) didn't run — and pixel statistics aren't reliable on ID cards. Upload the e-Aadhaar PDF, or a larger, sharper image where the QR is clearly visible."
      : buildSummary(verdict, crit, warn, pass);

  const hotspots = fused.regions(0.5).slice(0, 24).map((rg: Region) => {
    let intensity = 0;
    const x0 = Math.floor((rg.x * fused.width) / fused.cellW), y0 = Math.floor((rg.y * fused.height) / fused.cellH);
    const x1 = Math.ceil(((rg.x + rg.w) * fused.width) / fused.cellW), y1 = Math.ceil(((rg.y + rg.h) * fused.height) / fused.cellH);
    for (let r = y0; r < Math.min(R, y1); r++) for (let c = x0; c < Math.min(C, x1); c++) intensity = Math.max(intensity, fused.data[r * C + c]);
    return {
      x: rg.x * fused.width,
      y: rg.y * fused.height,
      width: rg.w * fused.width,
      height: rg.h * fused.height,
      intensity,
      type: "edit" as const,
    };
  });

  return { verdict, title, summary, score, risk, confidence, fused, evidence: ev, hotspots, changes };
}

function buildSummary(verdict: VerdictKind, crit: Evidence[], warn: Evidence[], pass: Evidence[]) {
  const describe = (e: Evidence) => {
    if (e.change && e.change.after && !e.change.before.includes("(")) return `${e.title.toLowerCase()} ("${e.change.before}" → "${e.change.after}")`;
    return e.title.toLowerCase();
  };
  if (verdict === "MATCHES_ORIGINAL")
    return pass.some((e) => e.id === "reg-exact")
      ? "This file is byte-for-byte identical to the original registered by the issuer."
      : "Page 1 has the same content as the original registered by the issuer (the file itself was re-saved or re-signed).";
  if (verdict === "EDITED") {
    const top = crit.slice(0, 3).map(describe);
    return `${crit.length} strong sign${crit.length > 1 ? "s" : ""} of editing: ${top.join("; ")}.`;
  }
  if (verdict === "SUSPICIOUS") {
    const top = warn.slice(0, 3).map((e) => e.title.toLowerCase());
    return `No proof of editing, but ${warn.length} warning${warn.length > 1 ? "s" : ""}: ${top.join("; ")}. Ask for the original or verify with the issuer.`;
  }
  if (verdict === "INCONCLUSIVE")
    return "Too few checks could run on this file (for example a small, re-compressed image with no metadata). Ask for the original PDF or a clear photo.";
  const passed = pass.slice(0, 3).map((e) => e.title.toLowerCase());
  return `No signs of editing found${passed.length ? ` — ${passed.join("; ")}` : ""}. This is not proof it is genuine: only a match with the issuer's registered original proves that.`;
}
