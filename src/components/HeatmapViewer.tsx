"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Eye, Layers, Sparkles, Info, Flame } from "lucide-react";
import { useApp } from "../lib/AppContext";
import type { Detection } from "../lib/forensicEngine";

type Tab = "visual" | "findings";

const severityConfig: Record<string, { color: string; label: string }> = {
  info: { color: "#00B4D8", label: "Info" },
  warning: { color: "#FFB800", label: "Warning" },
  critical: { color: "#FF3131", label: "Critical" },
};

export default function HeatmapViewer() {
  const { state } = useApp();
  const [activeTab, setActiveTab] = useState<Tab>("visual");

  const detections: Detection[] = state.forensicResult?.detections ?? [];
  const elaImage = state.forensicResult?.elaImageDataUrl;
  const hotspots = state.forensicResult?.hotspots ?? [];
  const hasData = !!state.forensicResult;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, delay: 0.3 }}
      className="glass-card col-span-2"
    >
      <div className="flex items-center justify-between p-4 border-b border-[#1E1E22]">
        <div className="flex items-center gap-2">
          <Eye className="w-4 h-4 text-[#FF6B35]" />
          <span className="text-sm font-semibold text-zinc-300">Tampering Evidence</span>
        </div>
        {hasData && (
          <span className="text-xs text-zinc-500">
            {detections.length} finding{detections.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[#1E1E22]">
        {([
          { key: "visual" as Tab, icon: Flame, label: "Heatmap View" },
          { key: "findings" as Tab, icon: Layers, label: "All Findings" },
        ]).map(({ key, icon: Icon, label }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`flex items-center gap-2 px-5 py-3 text-xs font-medium transition-colors
              ${activeTab === key
                ? "text-[#39FF14] border-b-2 border-[#39FF14] bg-[#39FF14]/5"
                : "text-zinc-500 hover:text-zinc-300"
              }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {activeTab === "visual" ? (
        <div className="p-4">
          <div className="relative aspect-[16/9] bg-[#0D0D0F] border border-[#1E1E22] overflow-hidden">
            {elaImage ? (
              <>
                {state.filePreviewUrl && (
                  <img src={state.filePreviewUrl} alt="Document" className="absolute inset-0 w-full h-full object-contain opacity-30" />
                )}
                <img src={elaImage} alt="Error Level Analysis heatmap" className="absolute inset-0 w-full h-full object-contain mix-blend-screen" />
                {hotspots.slice(0, 15).map((h, i) => (
                  <motion.div
                    key={i}
                    className="absolute border-2 rounded-sm"
                    style={{
                      left: `${(h.x / (state.forensicResult?.metadata.dimensions.width ?? 1)) * 100}%`,
                      top: `${(h.y / (state.forensicResult?.metadata.dimensions.height ?? 1)) * 100}%`,
                      width: `${Math.max(4, (h.width / (state.forensicResult?.metadata.dimensions.width ?? 1)) * 100)}%`,
                      height: `${Math.max(4, (h.height / (state.forensicResult?.metadata.dimensions.height ?? 1)) * 100)}%`,
                      borderColor: h.intensity > 0.7 ? "#FF3131" : h.intensity > 0.4 ? "#FFB800" : "#00B4D8",
                      background: h.intensity > 0.7 ? "rgba(255,49,49,0.12)" : h.intensity > 0.4 ? "rgba(255,184,0,0.08)" : "rgba(0,180,216,0.06)",
                    }}
                    animate={{ opacity: [0.5, 1, 0.5] }}
                    transition={{ duration: 2, repeat: Infinity, delay: i * 0.15 }}
                  />
                ))}
              </>
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center gap-2">
                <Sparkles className="w-8 h-8 text-zinc-800" />
                <span className="text-xs text-zinc-700">
                  {state.stage === "analyzing" ? "Creating heatmap..." : "Upload a file to see the heatmap"}
                </span>
              </div>
            )}

            {elaImage && (
              <div className="absolute bottom-2 left-2 flex items-center gap-3 bg-[#0A0A0B]/80 px-2 py-1 backdrop-blur-sm">
                <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 rounded-full bg-[#FF3131]" /><span className="text-[10px] text-zinc-400">Suspicious</span></div>
                <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 rounded-full bg-[#FFB800]" /><span className="text-[10px] text-zinc-400">Possible edit</span></div>
                <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 rounded-full bg-[#00B4D8]" /><span className="text-[10px] text-zinc-400">Minor</span></div>
              </div>
            )}
          </div>

          {elaImage && (
            <div className="flex items-start gap-2 mt-3 p-3 bg-[#0D0D0F] border border-[#1E1E22] rounded-sm">
              <Info className="w-4 h-4 text-[#00B4D8] shrink-0 mt-0.5" />
              <p className="text-[11px] text-zinc-500 leading-relaxed">
                This heatmap highlights areas where image compression levels differ — a sign of possible editing.
                <strong className="text-zinc-400"> Bright colored areas</strong> indicate regions that may have been modified after the original was saved.
                {hotspots.length === 0 && <span className="text-[#39FF14]"> No suspicious regions were found.</span>}
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="p-4 space-y-2 max-h-[350px] overflow-y-auto">
          {detections.length > 0 ? (
            detections.map((detection, i) => {
              const config = severityConfig[detection.severity] ?? severityConfig.info;
              return (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: 10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.08 }}
                  className="p-3 bg-[#0D0D0F] border border-[#1E1E22] rounded-sm"
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <div className="w-2 h-2 rounded-full" style={{ background: config.color }} />
                    <span className="text-xs font-semibold" style={{ color: config.color }}>{detection.label}</span>
                    <span className="ml-auto text-[9px] px-2 py-0.5 rounded-full"
                      style={{ color: config.color, background: config.color + "15" }}>
                      {config.label}
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-500 leading-relaxed">{detection.description}</p>
                </motion.div>
              );
            })
          ) : (
            <div className="flex flex-col items-center justify-center h-40 gap-2">
              <Sparkles className="w-6 h-6 text-zinc-800" />
              <span className="text-xs text-zinc-700">No findings yet</span>
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}
