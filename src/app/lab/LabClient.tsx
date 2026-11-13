"use client";

/**
 * Dev-only regression lab: runs the real forensic engine over a list of files and prints a compact
 * JSON summary plus the page image with the fused heatmap and evidence boxes drawn on it.
 * Not available in production builds. Files are fetched from a local URL (?base=…&files=a,b) and
 * analysed in this browser only.
 */

import { useEffect, useRef, useState } from "react";
import { analyzeDocument, type ForensicResult } from "../../lib/forensicEngine";
import { ocrRegion, runOcr } from "../../lib/forensics/ocr";
import { buildLines } from "../../lib/forensics/textLines";

interface Row {
  file: string;
  verdict?: string;
  title?: string;
  summary?: string;
  score?: number;
  docType?: string;
  ms?: number;
  error?: string;
  evidence?: { sev: string; cat: string; title: string; detail: string; regions: string[] }[];
  checks?: string[];
  changes?: string[];
  layers?: string[];
  hotspots?: number;
  aadhaar?: unknown;
  ocrLines?: string[];
  gradeCard?: unknown;
  overlay?: string;
}

function overlayImage(r: ForensicResult): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (!r.pageImageUrl) return resolve(undefined);
    const img = new Image();
    img.onload = () => {
      const maxW = 700;
      const s = Math.min(1, maxW / img.width);
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const { cols, rows, data } = r.fusedGrid;
      const cw = c.width / cols, ch = c.height / rows;
      for (let k = 0; k < data.length; k++) {
        if (data[k] <= 0) continue;
        ctx.fillStyle = `rgba(255,0,0,${0.15 + 0.45 * data[k]})`;
        ctx.fillRect((k % cols) * cw, Math.floor(k / cols) * ch, cw, ch);
      }
      for (const e of r.evidence) {
        if (e.severity === "pass" || e.severity === "info") continue;
        ctx.strokeStyle = e.severity === "critical" ? "#ff00ff" : "#ffaa00";
        ctx.lineWidth = 2;
        for (const g of e.regions ?? []) ctx.strokeRect(g.x * c.width, g.y * c.height, g.w * c.width, g.h * c.height);
      }
      resolve(c.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => resolve(undefined);
    img.src = r.pageImageUrl;
  });
}

export default function LabClient() {
  const [rows, setRows] = useState<Row[]>([]);
  const [done, setDone] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const q = new URLSearchParams(window.location.search);
    const base = q.get("base") ?? "/samples/";
    const files = (q.get("files") ?? "").split(",").filter(Boolean);
    const short = q.has("short");
    (async () => {
      const out: Row[] = [];
      for (const f of files) {
        const row: Row = { file: f };
        try {
          const res = await fetch(base + f, { cache: "no-store" });
          const blob = await res.blob();
          const type = blob.type && blob.type !== "application/octet-stream" ? blob.type : f.endsWith(".pdf") ? "application/pdf" : f.endsWith(".png") ? "image/png" : "image/jpeg";
          const r = await analyzeDocument(new File([blob], f, { type }));
          if (q.has("ocr") && !f.endsWith(".pdf")) {
            const bmp = await createImageBitmap(blob);
            const c = document.createElement("canvas");
            c.width = bmp.width;
            c.height = bmp.height;
            c.getContext("2d")!.drawImage(bmp, 0, 0);
            const crop = q.get("crop")?.split(",").map(Number);
            const words = crop
              ? await ocrRegion(c, { x: crop[0], y: crop[1], w: crop[2], h: crop[3] }, { scale: Number(q.get("scale") ?? 3), psm: (q.get("psm") ?? "6") as "6" })
              : (await runOcr(c)).words;
            row.ocrLines = buildLines(words).map((l) => `${Math.round(l.x)},${Math.round(l.y)} h${Math.round(l.h)} | ${l.text} | ${l.boxes.map((b) => Math.round((b as { confidence?: number }).confidence ?? 0)).join(",")}`);
          }
          Object.assign(row, {
            verdict: r.verdict,
            title: r.verdictTitle,
            summary: r.summary,
            score: r.authenticityScore,
            docType: r.docType,
            ms: r.analysisMs,
            evidence: r.evidence.map((e) => ({
              sev: e.severity,
              cat: e.category,
              title: e.title,
              detail: short ? e.detail.slice(0, 140) : e.detail,
              regions: (e.regions ?? []).map((g) => `${g.label ?? ""}@${g.x.toFixed(3)},${g.y.toFixed(3)} ${g.w.toFixed(3)}x${g.h.toFixed(3)}`),
            })),
            checks: r.checks.map((c) => `${c.id}:${c.status}${c.note ? ` (${c.note})` : ""}`),
            changes: r.changes.map((c) => `${c.field ? c.field + ": " : ""}${c.before} → ${c.after}`),
            layers: r.layers.map((l) => `${l.id}${l.critical ? "*" : ""}:${l.strength.toFixed(2)}`),
            hotspots: r.hotspots.length,
            aadhaar: r.aadhaar
              ? { ...r.aadhaar, qr: r.aadhaar.qr ? { kind: r.aadhaar.qr.kind, dob: r.aadhaar.qr.dob, gender: r.aadhaar.qr.gender, last4: r.aadhaar.qr.last4, pincode: r.aadhaar.qr.pincode, photoBytes: r.aadhaar.qr.photo?.length ?? 0 } : null }
              : undefined,
            gradeCard: r.gradeCard ?? undefined,
            overlay: await overlayImage(r),
          });
        } catch (e) {
          row.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        }
        out.push(row);
        setRows([...out]);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__lab = out.map(({ overlay, ...rest }) => rest);
      setDone(true);
    })();
  }, []);

  return (
    <div style={{ padding: 16, fontFamily: "monospace", fontSize: 12, color: "#ddd", background: "#111", minHeight: "100vh" }}>
      <h1 id="lab-status">{done ? "LAB DONE" : `LAB RUNNING (${rows.length} done)`}</h1>
      {rows.map((r) => (
        <div key={r.file} style={{ borderTop: "1px solid #444", padding: "8px 0" }}>
          <div>
            <b>{r.file}</b> → <b>{r.verdict}</b> ({r.score}) {r.title} [{r.docType}] {r.ms}ms {r.error}
          </div>
          {r.overlay && <img src={r.overlay} alt={r.file} style={{ maxWidth: 700, display: "block", margin: "6px 0" }} />}
        </div>
      ))}
    </div>
  );
}
