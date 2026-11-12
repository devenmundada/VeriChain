"use client";

import { motion } from "framer-motion";
import { Brain, ShieldCheck, AlertTriangle, Activity } from "lucide-react";
import { useApp } from "../lib/AppContext";

function getRiskColor(risk: string) {
  switch (risk) {
    case "LOW": return { color: "#39FF14", bg: "rgba(57,255,20,0.1)", label: "Low Risk" };
    case "MEDIUM": return { color: "#FFB800", bg: "rgba(255,184,0,0.1)", label: "Medium Risk" };
    case "HIGH": return { color: "#FF6B35", bg: "rgba(255,107,53,0.1)", label: "High Risk" };
    case "CRITICAL": return { color: "#FF3131", bg: "rgba(255,49,49,0.1)", label: "Critical" };
    default: return { color: "#39FF14", bg: "rgba(57,255,20,0.1)", label: "Low Risk" };
  }
}

function CircularGauge({ value, label, sublabel, color }: { value: number; label: string; sublabel: string; color: string }) {
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (value / 100) * circumference;

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative w-[100px] h-[100px]">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 90 90">
          <circle cx="45" cy="45" r={radius} fill="none" stroke="#1E1E22" strokeWidth="4" />
          <motion.circle
            cx="45" cy="45" r={radius} fill="none" stroke={color} strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={circumference}
            initial={{ strokeDashoffset: circumference }}
            animate={{ strokeDashoffset: offset }}
            transition={{ duration: 2, ease: "easeOut", delay: 0.3 }}
            style={{ filter: `drop-shadow(0 0 6px ${color}60)` }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <motion.span
            className="text-xl font-bold"
            style={{ color }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.8 }}
          >
            {value}%
          </motion.span>
        </div>
      </div>
      <div className="text-center">
        <div className="text-xs font-semibold text-zinc-300">{label}</div>
        <div className="text-[10px] text-zinc-600">{sublabel}</div>
      </div>
    </div>
  );
}

export default function AIForensicPanel() {
  const { state } = useApp();
  const isAnalyzing = state.stage === "analyzing";
  const hasData = !!state.forensicResult;

  const score = state.forensicResult?.authenticityScore ?? 0;
  const confidence = state.forensicResult?.aiConfidence ?? 0;
  const risk = state.forensicResult?.forgeryRisk ?? "LOW";
  const riskStyle = getRiskColor(risk);
  const ps = state.forensicResult?.pixelStats;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, delay: 0.2 }}
      className="glass-card"
    >
      <div className="flex items-center justify-between p-4 border-b border-[#1E1E22]">
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-[#39FF14]" />
          <span className="text-sm font-semibold text-zinc-300">AI Analysis</span>
        </div>
        {isAnalyzing && (
          <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.5, repeat: Infinity }} className="flex items-center gap-1.5">
            <Activity className="w-3 h-3 text-[#FFB800]" />
            <span className="text-[11px] text-[#FFB800]">Scanning...</span>
          </motion.div>
        )}
      </div>

      {hasData ? (
        <div className="p-5">
          {/* Gauges */}
          <div className="flex items-center justify-around mb-5">
            <CircularGauge
              value={score}
              label="Authenticity Score"
              sublabel="How genuine the document appears"
              color={score >= 80 ? "#39FF14" : score >= 60 ? "#FFB800" : "#FF3131"}
            />
            <CircularGauge
              value={confidence}
              label="AI Confidence"
              sublabel="How certain the analysis is"
              color="#00B4D8"
            />
          </div>

          {/* Risk badge */}
          <div className="flex items-center justify-between p-3 border rounded-sm" style={{ borderColor: riskStyle.color + "30", background: riskStyle.bg }}>
            <div className="flex items-center gap-2">
              {risk === "LOW" ? (
                <ShieldCheck className="w-5 h-5" style={{ color: riskStyle.color }} />
              ) : (
                <AlertTriangle className="w-5 h-5" style={{ color: riskStyle.color }} />
              )}
              <span className="text-sm text-zinc-300">Tampering Risk</span>
            </div>
            <span className="text-sm font-bold" style={{ color: riskStyle.color }}>{riskStyle.label}</span>
          </div>

          {/* Pixel stats — human readable */}
          {ps && (
            <div className="mt-4 grid grid-cols-3 gap-2">
              {[
                { label: "Image Complexity", value: ps.entropy.toFixed(1), desc: ps.entropy > 6.5 ? "Normal" : ps.entropy > 4 ? "Moderate" : "Synthetic-looking" },
                { label: "Noise Level", value: ps.noiseLevel.toFixed(0), desc: ps.noiseLevel < 20 ? "Clean" : ps.noiseLevel < 40 ? "Some noise" : "Heavy editing" },
                { label: "Color Spread", value: ps.stdDev.toFixed(0), desc: ps.stdDev > 60 ? "Rich detail" : ps.stdDev > 30 ? "Normal" : "Flat/uniform" },
              ].map((stat) => (
                <div key={stat.label} className="text-center p-2 bg-[#0D0D0F] border border-[#1E1E22] rounded-sm">
                  <div className="text-[10px] text-zinc-600 mb-1">{stat.label}</div>
                  <div className="text-sm font-semibold text-zinc-300">{stat.value}</div>
                  <div className="text-[9px] text-zinc-600">{stat.desc}</div>
                </div>
              ))}
            </div>
          )}

          {/* On-Device AI Analysis */}
          {state.forensicResult?.aiAnalysis && (
            <div className="mt-4 p-3 bg-[#0D0D0F] border border-[#9B59B6]/20 rounded-sm">
              <div className="flex items-center gap-2 mb-2">
                <Brain className="w-3 h-3 text-[#9B59B6]" />
                <span className="text-[10px] font-mono font-bold text-[#9B59B6]">ON-DEVICE AI ASSESSMENT</span>
                {state.forensicResult.aiTokensPerSecond && (
                  <span className="text-[8px] font-mono text-zinc-600 ml-auto">
                    {state.forensicResult.aiTokensPerSecond.toFixed(1)} tok/s • {state.forensicResult.aiLatencyMs}ms
                  </span>
                )}
              </div>
              <p className="text-[11px] text-zinc-400 leading-relaxed font-mono">
                {state.forensicResult.aiAnalysis}
              </p>
              <div className="mt-2 flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-[#39FF14]" />
                <span className="text-[8px] font-mono text-zinc-700">
                  Processed 100% on-device via RunAnywhere LLM — no data sent to cloud
                </span>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="p-8 flex flex-col items-center justify-center text-center gap-3 min-h-[200px]">
          <Brain className="w-10 h-10 text-zinc-800" />
          <div>
            <p className="text-sm text-zinc-500">
              {isAnalyzing ? "Analyzing your document..." : "Upload a document to start"}
            </p>
            <p className="text-[11px] text-zinc-700 mt-1">
              AI will check for signs of tampering and manipulation
            </p>
          </div>
        </div>
      )}
    </motion.div>
  );
}
