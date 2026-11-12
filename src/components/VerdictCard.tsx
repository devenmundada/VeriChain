"use client";

import { motion, AnimatePresence } from "framer-motion";
import { ShieldCheck, ShieldAlert, ShieldX, Info, ChevronDown, ChevronUp, Volume2, VolumeX } from "lucide-react";
import { useState, useCallback } from "react";
import { useApp } from "../lib/AppContext";
import { speakText, stopSpeaking } from "../lib/runanywhere";

function getVerdict(score: number) {
  if (score >= 80) return { label: "Authentic", icon: ShieldCheck, color: "#39FF14", bg: "rgba(57,255,20,0.08)", desc: "This document appears to be genuine. No significant signs of tampering were detected." };
  if (score >= 60) return { label: "Suspicious", icon: ShieldAlert, color: "#FFB800", bg: "rgba(255,184,0,0.08)", desc: "Some inconsistencies were found. This document may have been modified." };
  if (score >= 40) return { label: "Likely Tampered", icon: ShieldAlert, color: "#FF6B35", bg: "rgba(255,107,53,0.08)", desc: "Multiple signs of manipulation detected. This document has likely been altered." };
  return { label: "Forged", icon: ShieldX, color: "#FF3131", bg: "rgba(255,49,49,0.08)", desc: "Strong evidence of forgery. This document has been significantly manipulated." };
}

export default function VerdictCard() {
  const { state } = useApp();
  const [expanded, setExpanded] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  if (state.stage !== "complete" && state.stage !== "hashing" && state.stage !== "minting") return null;
  if (!state.forensicResult) return null;

  const score = state.forensicResult.authenticityScore;
  const verdict = getVerdict(score);
  const VerdictIcon = verdict.icon;
  const detections = state.forensicResult.detections;
  const criticalCount = detections.filter(d => d.severity === "critical").length;
  const warningCount = detections.filter(d => d.severity === "warning").length;

  const handleSpeak = () => {
    if (isSpeaking) {
      stopSpeaking();
      setIsSpeaking(false);
      return;
    }
    setIsSpeaking(true);
    const aiSummary = state.forensicResult?.aiAnalysis ?? "";
    const text = `Verdict: ${verdict.label}. Authenticity score: ${score} out of 100. ${verdict.desc}${aiSummary ? ` AI analysis: ${aiSummary}` : ""}`;
    speakText(text);
    // Reset speaking state after estimated duration
    setTimeout(() => setIsSpeaking(false), Math.max(3000, text.length * 60));
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5, type: "spring" }}
      className="w-full"
    >
      <div className="glass-card overflow-hidden" style={{ borderColor: verdict.color + "30" }}>
        {/* Main verdict */}
        <div className="p-6" style={{ background: verdict.bg }}>
          <div className="flex items-center gap-5">
            {/* Score circle */}
            <div className="relative shrink-0">
              <svg className="w-24 h-24 -rotate-90" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="42" fill="none" stroke="#1E1E22" strokeWidth="6" />
                <motion.circle
                  cx="50" cy="50" r="42" fill="none" stroke={verdict.color} strokeWidth="6"
                  strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * 42}
                  initial={{ strokeDashoffset: 2 * Math.PI * 42 }}
                  animate={{ strokeDashoffset: 2 * Math.PI * 42 * (1 - score / 100) }}
                  transition={{ duration: 1.5, ease: "easeOut" }}
                  style={{ filter: `drop-shadow(0 0 8px ${verdict.color}60)` }}
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-2xl font-bold font-mono" style={{ color: verdict.color }}>
                  {score}
                </span>
              </div>
            </div>

            {/* Verdict text */}
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <VerdictIcon className="w-6 h-6" style={{ color: verdict.color }} />
                <h2 className="text-xl font-bold" style={{ color: verdict.color }}>
                  {verdict.label}
                </h2>
                <button
                  onClick={handleSpeak}
                  className="ml-2 p-1.5 rounded hover:bg-white/5 transition-colors group"
                  title={isSpeaking ? "Stop speaking" : "Read verdict aloud (On-Device TTS)"}
                >
                  {isSpeaking ? (
                    <VolumeX className="w-4 h-4 text-[#FFB800]" />
                  ) : (
                    <Volume2 className="w-4 h-4 text-zinc-600 group-hover:text-[#39FF14] transition-colors" />
                  )}
                </button>
              </div>
              <p className="text-sm text-zinc-400 leading-relaxed max-w-lg">
                {verdict.desc}
              </p>

              {/* Quick stats */}
              <div className="flex items-center gap-4 mt-3">
                <div className="flex items-center gap-1.5 text-xs">
                  <div className="w-2 h-2 rounded-full bg-[#39FF14]" />
                  <span className="text-zinc-400">AI Confidence: <span className="text-zinc-200">{state.forensicResult.aiConfidence}%</span></span>
                </div>
                {criticalCount > 0 && (
                  <div className="flex items-center gap-1.5 text-xs">
                    <div className="w-2 h-2 rounded-full bg-[#FF3131]" />
                    <span className="text-zinc-400">{criticalCount} critical finding{criticalCount > 1 ? "s" : ""}</span>
                  </div>
                )}
                {warningCount > 0 && (
                  <div className="flex items-center gap-1.5 text-xs">
                    <div className="w-2 h-2 rounded-full bg-[#FFB800]" />
                    <span className="text-zinc-400">{warningCount} warning{warningCount > 1 ? "s" : ""}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Expandable findings */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full px-6 py-3 border-t border-[#1E1E22] flex items-center justify-between text-xs text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.02] transition-colors"
        >
          <div className="flex items-center gap-2">
            <Info className="w-3.5 h-3.5" />
            <span>{detections.length} detailed finding{detections.length !== 1 ? "s" : ""} — click to {expanded ? "hide" : "view"}</span>
          </div>
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>

        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="overflow-hidden"
            >
              <div className="px-6 pb-4 space-y-2">
                {detections.map((d, i) => {
                  const sColor = d.severity === "critical" ? "#FF3131" : d.severity === "warning" ? "#FFB800" : "#00B4D8";
                  return (
                    <div key={i} className="p-3 bg-[#0D0D0F] border border-[#1E1E22]">
                      <div className="flex items-center gap-2 mb-1">
                        <div className="w-1.5 h-1.5 rounded-full" style={{ background: sColor }} />
                        <span className="text-xs font-medium" style={{ color: sColor }}>{d.label}</span>
                        <span className="ml-auto text-[9px] uppercase px-1.5 py-0.5 font-mono"
                          style={{ color: sColor, background: sColor + "15" }}>
                          {d.severity}
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-500 leading-relaxed">{d.description}</p>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
