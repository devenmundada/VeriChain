"use client";

import { motion, AnimatePresence } from "framer-motion";
import {
  ShieldCheck, ShieldAlert, ShieldX, ShieldQuestion, BadgeCheck, Info, ChevronDown, ChevronUp,
  Volume2, VolumeX, ArrowRight, FileText, IdCard, GraduationCap, Clock,
} from "lucide-react";
import { useState } from "react";
import { useApp } from "../lib/AppContext";
import { speakText, stopSpeaking } from "../lib/runanywhere";
import type { VerdictKind } from "../lib/forensicEngine";

const VERDICTS: Record<VerdictKind, { label: string; icon: typeof ShieldCheck; color: string; bg: string }> = {
  EDITED: { label: "Edited", icon: ShieldX, color: "#FF3131", bg: "rgba(255,49,49,0.08)" },
  SUSPICIOUS: { label: "Suspicious", icon: ShieldAlert, color: "#FFB800", bg: "rgba(255,184,0,0.08)" },
  NO_SIGNS: { label: "No signs of editing", icon: ShieldCheck, color: "#39FF14", bg: "rgba(57,255,20,0.06)" },
  MATCHES_ORIGINAL: { label: "Matches original", icon: BadgeCheck, color: "#39FF14", bg: "rgba(57,255,20,0.08)" },
  INCONCLUSIVE: { label: "Inconclusive", icon: ShieldQuestion, color: "#00B4D8", bg: "rgba(0,180,216,0.06)" },
};

const DOC_LABEL: Record<string, { label: string; icon: typeof FileText }> = {
  aadhaar: { label: "Aadhaar card", icon: IdCard },
  marksheet: { label: "Marksheet", icon: GraduationCap },
  certificate: { label: "Certificate", icon: FileText },
  unknown: { label: "Document", icon: FileText },
};

const SEV_COLOR: Record<string, string> = { critical: "#FF3131", warning: "#FFB800", info: "#00B4D8", pass: "#39FF14" };

export default function VerdictCard() {
  const { state } = useApp();
  const [expanded, setExpanded] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  if (state.stage !== "complete" && state.stage !== "hashing" && state.stage !== "minting") return null;
  const fr = state.forensicResult;
  if (!fr) return null;

  const v = VERDICTS[fr.verdict] ?? VERDICTS.INCONCLUSIVE;
  const VerdictIcon = v.icon;
  const score = fr.authenticityScore;
  const critical = fr.evidence.filter((e) => e.severity === "critical");
  const warnings = fr.evidence.filter((e) => e.severity === "warning");
  const passes = fr.evidence.filter((e) => e.severity === "pass");
  const doc = DOC_LABEL[fr.docType] ?? DOC_LABEL.unknown;
  const DocIcon = doc.icon;
  const keyFindings = [...critical, ...warnings].slice(0, 4);

  const handleSpeak = () => {
    if (isSpeaking) {
      stopSpeaking();
      setIsSpeaking(false);
      return;
    }
    setIsSpeaking(true);
    const text = `Verdict: ${fr.verdictTitle}. ${fr.summary}${fr.aiAnalysis ? ` ${fr.aiAnalysis}` : ""}`;
    speakText(text);
    setTimeout(() => setIsSpeaking(false), Math.max(3000, text.length * 60));
  };

  return (
    <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.5, type: "spring" }} className="w-full">
      <div className="glass-card overflow-hidden" style={{ borderColor: v.color + "40" }}>
        <div className="p-6" style={{ background: v.bg }}>
          <div className="flex flex-col sm:flex-row sm:items-center gap-5">
            {/* Integrity score */}
            <div className="relative shrink-0 self-center">
              <svg className="w-24 h-24 -rotate-90" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="42" fill="none" stroke="#1E1E22" strokeWidth="6" />
                <motion.circle
                  cx="50" cy="50" r="42" fill="none" stroke={v.color} strokeWidth="6" strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * 42}
                  initial={{ strokeDashoffset: 2 * Math.PI * 42 }}
                  animate={{ strokeDashoffset: 2 * Math.PI * 42 * (1 - score / 100) }}
                  transition={{ duration: 1.5, ease: "easeOut" }}
                  style={{ filter: `drop-shadow(0 0 8px ${v.color}60)` }}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-2xl font-bold font-mono" style={{ color: v.color }}>{fr.verdict === "INCONCLUSIVE" ? "—" : Math.round(score)}</span>
                <span className="text-[8px] font-mono text-zinc-600 tracking-widest">INTEGRITY</span>
              </div>
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <VerdictIcon className="w-6 h-6" style={{ color: v.color }} />
                <h2 className="text-xl font-bold" style={{ color: v.color }}>{fr.verdictTitle}</h2>
                <button
                  onClick={handleSpeak}
                  className="ml-1 p-1.5 rounded hover:bg-white/5 transition-colors group"
                  title={isSpeaking ? "Stop speaking" : "Read verdict aloud (On-Device TTS)"}
                >
                  {isSpeaking ? <VolumeX className="w-4 h-4 text-[#FFB800]" /> : <Volume2 className="w-4 h-4 text-zinc-600 group-hover:text-[#39FF14] transition-colors" />}
                </button>
              </div>
              <p className="text-sm text-zinc-300 leading-relaxed max-w-2xl">{fr.summary}</p>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-3 text-xs">
                <span className="flex items-center gap-1.5 text-zinc-400">
                  <DocIcon className="w-3.5 h-3.5 text-zinc-500" />
                  {doc.label} · {fr.docKind.toUpperCase()}{fr.pages > 1 ? ` · ${fr.pages} pages` : ""}
                </span>
                {critical.length > 0 && (
                  <span className="flex items-center gap-1.5 text-zinc-400">
                    <span className="w-2 h-2 rounded-full bg-[#FF3131]" />{critical.length} critical
                  </span>
                )}
                {warnings.length > 0 && (
                  <span className="flex items-center gap-1.5 text-zinc-400">
                    <span className="w-2 h-2 rounded-full bg-[#FFB800]" />{warnings.length} warning{warnings.length > 1 ? "s" : ""}
                  </span>
                )}
                {passes.length > 0 && (
                  <span className="flex items-center gap-1.5 text-zinc-400">
                    <span className="w-2 h-2 rounded-full bg-[#39FF14]" />{passes.length} passed
                  </span>
                )}
                <span className="flex items-center gap-1.5 text-zinc-500">
                  <Clock className="w-3 h-3" />{(fr.analysisMs / 1000).toFixed(1)}s on-device
                </span>
              </div>
            </div>
          </div>

          {/* What changed */}
          {fr.changes.length > 0 && (
            <div className="mt-5">
              <div className="text-[10px] font-mono text-zinc-500 tracking-[0.2em] mb-2">WHAT WAS CHANGED</div>
              <div className="flex flex-wrap gap-2">
                {fr.changes.slice(0, 6).map((c, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3 + i * 0.1 }}
                    className="flex items-center gap-2 px-3 py-1.5 bg-[#0D0D0F] border border-[#FF3131]/30 font-mono text-xs"
                  >
                    {c.field && <span className="text-zinc-500">{c.field}:</span>}
                    <span className="text-zinc-400 line-through decoration-[#FF3131]/60">{c.before || "∅"}</span>
                    <ArrowRight className="w-3 h-3 text-[#FF3131]" />
                    <span className="text-[#FF3131] font-bold">{c.after || "∅"}</span>
                  </motion.div>
                ))}
              </div>
            </div>
          )}

          {/* Key findings */}
          {keyFindings.length > 0 && (
            <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-2">
              {keyFindings.map((e) => (
                <div key={e.id} className="p-3 bg-[#0D0D0F]/80 border border-[#1E1E22]" style={{ borderLeft: `2px solid ${SEV_COLOR[e.severity]}` }}>
                  <div className="text-xs font-semibold" style={{ color: SEV_COLOR[e.severity] }}>{e.title}</div>
                  <p className="text-[11px] text-zinc-500 leading-relaxed mt-1">{e.detail}</p>
                </div>
              ))}
            </div>
          )}

          {fr.verdict === "NO_SIGNS" && (
            <p className="mt-4 text-[11px] text-zinc-500 flex items-start gap-2">
              <Info className="w-3.5 h-3.5 text-[#00B4D8] shrink-0 mt-0.5" />
              No check found an edit. Only a match with the issuer&apos;s registered original proves a document is genuine.
            </p>
          )}
        </div>

        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full px-6 py-3 border-t border-[#1E1E22] flex items-center justify-between text-xs text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.02] transition-colors"
        >
          <div className="flex items-center gap-2">
            <Info className="w-3.5 h-3.5" />
            <span>{fr.evidence.length} finding{fr.evidence.length !== 1 ? "s" : ""} from {fr.checks.filter((c) => c.status !== "skip").length} checks — click to {expanded ? "hide" : "view all"}</span>
          </div>
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>

        <AnimatePresence>
          {expanded && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3 }} className="overflow-hidden">
              <div className="px-6 pb-4 space-y-2">
                {fr.evidence.map((d) => {
                  const c = SEV_COLOR[d.severity];
                  return (
                    <div key={d.id} className="p-3 bg-[#0D0D0F] border border-[#1E1E22]">
                      <div className="flex items-center gap-2 mb-1">
                        <div className="w-1.5 h-1.5 rounded-full" style={{ background: c }} />
                        <span className="text-xs font-medium" style={{ color: c }}>{d.title}</span>
                        <span className="ml-auto text-[9px] uppercase px-1.5 py-0.5 font-mono" style={{ color: c, background: c + "15" }}>
                          {d.severity === "pass" ? "passed" : d.severity}
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-500 leading-relaxed">{d.detail}</p>
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
