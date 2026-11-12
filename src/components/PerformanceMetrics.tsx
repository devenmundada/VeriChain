"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Zap, Clock, Shield, WifiOff, Gauge, BarChart3, Cpu } from "lucide-react";
import { useApp } from "../lib/AppContext";

interface PerfSnapshot {
  label: string;
  value: string;
  unit: string;
  icon: React.ReactNode;
  color: string;
  description: string;
}

export default function PerformanceMetrics() {
  const { state, aiState } = useApp();
  const [elapsed, setElapsed] = useState(0);

  // Track time since analysis started
  useEffect(() => {
    if (state.stage !== "idle" && state.stage !== "complete" && state.stage !== "error") {
      const start = Date.now();
      const interval = setInterval(() => setElapsed(Date.now() - start), 100);
      return () => clearInterval(interval);
    }
  }, [state.stage]);

  const fr = state.forensicResult;

  const metrics: PerfSnapshot[] = [
    {
      label: "LLM Inference",
      value: fr?.aiTokensPerSecond ? fr.aiTokensPerSecond.toFixed(1) : "—",
      unit: "tok/s",
      icon: <Zap className="w-3.5 h-3.5" />,
      color: "#FFB800",
      description: "On-device language model throughput",
    },
    {
      label: "AI Latency",
      value: fr?.aiLatencyMs ? fr.aiLatencyMs.toFixed(0) : "—",
      unit: "ms",
      icon: <Clock className="w-3.5 h-3.5" />,
      color: "#00B4D8",
      description: "Time to first AI response",
    },
    {
      label: "Privacy Score",
      value: "100",
      unit: "%",
      icon: <Shield className="w-3.5 h-3.5" />,
      color: "#39FF14",
      description: "Zero data sent to any server",
    },
    {
      label: "Cloud Calls",
      value: "0",
      unit: "req",
      icon: <WifiOff className="w-3.5 h-3.5" />,
      color: "#9B59B6",
      description: "Everything runs in your browser",
    },
    {
      label: "Acceleration",
      value: aiState.acceleration === "webgpu" ? "GPU" : "CPU",
      unit: "WASM",
      icon: <Cpu className="w-3.5 h-3.5" />,
      color: "#FFB800",
      description: aiState.acceleration === "webgpu" ? "WebGPU accelerated" : "Multi-threaded WebAssembly",
    },
    {
      label: "Models Active",
      value: String(
        [aiState.llmStatus, aiState.sttStatus, aiState.ttsStatus, aiState.vadStatus].filter(
          (s) => s === "loaded"
        ).length
      ),
      unit: "/ 4",
      icon: <BarChart3 className="w-3.5 h-3.5" />,
      color: "#39FF14",
      description: "On-device AI models loaded",
    },
  ];

  return (
    <div className="glass-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Gauge className="w-4 h-4 text-[#FFB800]" />
          <h3 className="text-[11px] font-mono font-bold tracking-wider text-zinc-300">
            PERFORMANCE
          </h3>
        </div>
        <span className="text-[8px] font-mono text-zinc-600">ON-DEVICE METRICS</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {metrics.map((m, i) => (
          <motion.div
            key={m.label}
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            className="p-2 bg-[#0D0D0F] border border-[#1E1E22] rounded"
          >
            <div className="flex items-center gap-1.5 mb-1">
              <div style={{ color: m.color }}>{m.icon}</div>
              <span className="text-[9px] font-mono text-zinc-500">{m.label}</span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-lg font-bold font-mono" style={{ color: m.color }}>
                {m.value}
              </span>
              <span className="text-[9px] font-mono text-zinc-600">{m.unit}</span>
            </div>
            <div className="text-[7px] font-mono text-zinc-700 mt-0.5">{m.description}</div>
          </motion.div>
        ))}
      </div>

      {/* On-device advantage callout */}
      <div className="p-2 bg-gradient-to-r from-[#39FF14]/5 to-[#9B59B6]/5 border border-[#39FF14]/10 rounded">
        <div className="text-[9px] font-mono text-zinc-400 text-center">
          <span className="text-[#39FF14] font-bold">ON-DEVICE ADVANTAGE:</span>{" "}
          No API keys • No usage costs • No rate limits • No internet required • Complete privacy
        </div>
      </div>
    </div>
  );
}
