"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Eye, Layers, Sparkles, Info, Flame, Square, SquareCheck } from "lucide-react";
import { useApp } from "../lib/AppContext";
import type { Evidence, TamperLayer } from "../lib/forensicEngine";

type Tab = "visual" | "findings";

const SEV: Record<string, { color: string; label: string }> = {
  critical: { color: "#FF3131", label: "Critical" },
  warning: { color: "#FFB800", label: "Warning" },
  info: { color: "#00B4D8", label: "Info" },
  pass: { color: "#39FF14", label: "Passed" },
};

const CATEGORY_LABEL: Record<string, string> = {
  "pdf-structure": "PDF structure & saves",
  "pdf-text": "Hidden / covered text",
  "pdf-font": "Fonts",
  metadata: "Metadata",
  pixel: "Pixel consistency",
  qr: "QR code",
  aadhaar: "Aadhaar checks",
  marksheet: "Marksheet arithmetic",
  glyph: "Digit shapes",
  registry: "Registered original",
};

function hexToRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function heatColor(v: number): [number, number, number] {
  if (v >= 0.85) return [255, 49, 49];
  if (v >= 0.6) return [255, 107, 53];
  return [255, 184, 0];
}

function gridToDataUrl(cols: number, rows: number, data: Float32Array, color?: string): string | null {
  if (typeof document === "undefined") return null;
  let any = false;
  const c = document.createElement("canvas");
  c.width = cols;
  c.height = rows;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(cols, rows);
  const fixed = color ? hexToRgb(color) : null;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v <= 0.01) continue;
    any = true;
    const [r, g, b] = fixed ?? heatColor(v);
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = Math.round(Math.min(1, v) * 190);
  }
  if (!any) return null;
  ctx.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}

export default function HeatmapViewer() {
  const { state } = useApp();
  const [activeTab, setActiveTab] = useState<Tab>("visual");
  const [layerId, setLayerId] = useState<string>("combined");
  const [showBoxes, setShowBoxes] = useState(true);
  const fr = state.forensicResult;

  const layers: TamperLayer[] = fr?.layers ?? [];
  const gridLayers = layers.filter((l) => l.grid);
  const imageLayers = layers.filter((l) => l.overlayUrl);

  const overlays = useMemo(() => {
    const out: Record<string, string | null> = {};
    if (!fr) return out;
    out.combined = gridToDataUrl(fr.fusedGrid.cols, fr.fusedGrid.rows, fr.fusedGrid.data);
    for (const l of fr.layers) {
      if (l.grid) out[l.id] = gridToDataUrl(fr.fusedGrid.cols, fr.fusedGrid.rows, l.grid, l.color);
      else if (l.overlayUrl) out[l.id] = l.overlayUrl;
    }
    if (fr.elaImageDataUrl) out.ela = fr.elaImageDataUrl;
    return out;
  }, [fr]);

  if (!fr) return null;
  const pageW = fr.metadata.dimensions.width || 1;
  const pageH = fr.metadata.dimensions.height || 1;
  const aspect = pageW / pageH;

  const visibleEvidence: Evidence[] = fr.evidence.filter(
    (e) => e.regions?.length && (e.severity === "critical" || e.severity === "warning") && (layerId === "combined" || e.layerId === layerId)
  );
  const isImageLayer = imageLayers.some((l) => l.id === layerId) || layerId === "ela";
  const overlay = overlays[layerId];

  const chips: { id: string; label: string; color: string; strength?: number }[] = [
    { id: "combined", label: "Combined", color: "#FF3131" },
    ...gridLayers.map((l) => ({ id: l.id, label: l.label, color: l.color, strength: l.strength })),
    ...imageLayers.map((l) => ({ id: l.id, label: l.label, color: l.color })),
    ...(fr.elaImageDataUrl ? [{ id: "ela", label: "ELA (raw)", color: "#00B4D8" }] : []),
  ];

  const currentDesc =
    layerId === "combined"
      ? "All checks combined. Red = a deterministic check (hidden version, covered text, failed arithmetic, QR mismatch) or several independent checks agree. Amber = one statistical check only."
      : layerId === "ela"
      ? "Raw Error Level Analysis. Text edges are always bright — compare similar areas, not text against background."
      : layers.find((l) => l.id === layerId)?.description ?? "";

  const grouped = fr.evidence.reduce<Record<string, Evidence[]>>((acc, e) => {
    (acc[e.category] ??= []).push(e);
    return acc;
  }, {});

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.3 }} className="glass-card md:col-span-2">
      <div className="flex items-center justify-between p-4 border-b border-[#1E1E22]">
        <div className="flex items-center gap-2">
          <Eye className="w-4 h-4 text-[#FF6B35]" />
          <span className="text-sm font-semibold text-zinc-300">Tamper Map</span>
          <span className="text-[10px] font-mono text-zinc-600 hidden sm:inline">— where the document was changed</span>
        </div>
        <span className="text-xs text-zinc-500">{fr.hotspots.length} flagged area{fr.hotspots.length !== 1 ? "s" : ""}</span>
      </div>

      <div className="flex border-b border-[#1E1E22]">
        {([
          { key: "visual" as Tab, icon: Flame, label: "Heatmap" },
          { key: "findings" as Tab, icon: Layers, label: `All findings (${fr.evidence.length})` },
        ]).map(({ key, icon: Icon, label }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`flex items-center gap-2 px-5 py-3 text-xs font-medium transition-colors ${
              activeTab === key ? "text-[#39FF14] border-b-2 border-[#39FF14] bg-[#39FF14]/5" : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {activeTab === "visual" ? (
        <div className="p-4">
          {/* Layer chips */}
          <div className="flex flex-wrap gap-1.5 mb-3">
            {chips.map((c) => (
              <button
                key={c.id}
                onClick={() => setLayerId(c.id)}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] border transition-colors ${
                  layerId === c.id ? "border-zinc-500 text-zinc-200 bg-white/5" : "border-[#1E1E22] text-zinc-500 hover:text-zinc-300"
                }`}
              >
                <span className="w-2 h-2 rounded-full" style={{ background: c.color }} />
                {c.label}
              </button>
            ))}
            <button
              onClick={() => setShowBoxes((s) => !s)}
              className="ml-auto flex items-center gap-1.5 px-2.5 py-1 text-[11px] border border-[#1E1E22] text-zinc-500 hover:text-zinc-300"
            >
              {showBoxes ? <SquareCheck className="w-3 h-3" /> : <Square className="w-3 h-3" />}
              Labels
            </button>
          </div>

          <div className="flex justify-center bg-[#0D0D0F] border border-[#1E1E22] p-2">
            <div className="relative w-full" style={{ aspectRatio: `${aspect}`, maxWidth: `min(100%, ${Math.round(680 * aspect)}px)` }}>
              {fr.pageImageUrl ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={fr.pageImageUrl}
                    alt="Document page"
                    className="absolute inset-0 w-full h-full object-fill"
                    style={{ opacity: isImageLayer ? 0.25 : 0.9 }}
                  />
                  {overlay && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={overlay}
                      alt={`${layerId} layer`}
                      className="absolute inset-0 w-full h-full object-fill pointer-events-none"
                      style={{ mixBlendMode: isImageLayer ? "normal" : "multiply", opacity: isImageLayer ? 0.95 : 1, imageRendering: "auto", filter: isImageLayer ? undefined : "blur(1.5px)" }}
                    />
                  )}
                  {showBoxes &&
                    visibleEvidence.flatMap((e) =>
                      (e.regions ?? []).slice(0, 6).map((r, i) => {
                        const color = SEV[e.severity].color;
                        return (
                          <motion.div
                            key={`${e.id}-${i}`}
                            className="absolute border-2 pointer-events-none"
                            title={`${e.title}: ${e.detail}`}
                            style={{
                              left: `${r.x * 100}%`,
                              top: `${r.y * 100}%`,
                              width: `${Math.max(0.8, r.w * 100)}%`,
                              height: `${Math.max(0.8, r.h * 100)}%`,
                              borderColor: color,
                              boxShadow: `0 0 12px ${color}80`,
                            }}
                            initial={{ opacity: 0, scale: 1.4 }}
                            animate={{ opacity: [0.65, 1, 0.65], scale: 1 }}
                            transition={{ duration: 2, repeat: Infinity }}
                          >
                            {r.label && i < 3 && (
                              <span
                                className="absolute -top-5 left-0 whitespace-nowrap px-1.5 py-0.5 text-[9px] font-mono font-bold text-black"
                                style={{ background: color }}
                              >
                                {r.label}
                              </span>
                            )}
                          </motion.div>
                        );
                      })
                    )}
                </>
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                  <Sparkles className="w-8 h-8 text-zinc-800" />
                  <span className="text-xs text-zinc-700">No page image for this file type</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-start gap-2 mt-3 p-3 bg-[#0D0D0F] border border-[#1E1E22]">
            <Info className="w-4 h-4 text-[#00B4D8] shrink-0 mt-0.5" />
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              {currentDesc}
              {fr.hotspots.length === 0 && layerId === "combined" && <span className="text-[#39FF14]"> No area of the page was flagged.</span>}
            </p>
          </div>
        </div>
      ) : (
        <div className="p-4 space-y-4 max-h-[520px] overflow-y-auto">
          {Object.entries(grouped).map(([cat, list]) => (
            <div key={cat}>
              <div className="text-[10px] font-mono text-zinc-500 tracking-[0.15em] uppercase mb-2">{CATEGORY_LABEL[cat] ?? cat}</div>
              <div className="space-y-2">
                {list.map((d, i) => {
                  const cfg = SEV[d.severity] ?? SEV.info;
                  return (
                    <motion.div key={d.id} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }} className="p-3 bg-[#0D0D0F] border border-[#1E1E22]">
                      <div className="flex items-center gap-2 mb-1.5">
                        <div className="w-2 h-2 rounded-full" style={{ background: cfg.color }} />
                        <span className="text-xs font-semibold" style={{ color: cfg.color }}>{d.title}</span>
                        <span className="ml-auto text-[9px] px-2 py-0.5 rounded-full" style={{ color: cfg.color, background: cfg.color + "15" }}>{cfg.label}</span>
                      </div>
                      <p className="text-[11px] text-zinc-500 leading-relaxed">{d.detail}</p>
                    </motion.div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </motion.div>
  );
}
