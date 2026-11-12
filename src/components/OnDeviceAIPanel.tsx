"use client";

import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Brain, Cpu, Download, Check, Loader2, Mic, Volume2, Radio, Zap, HardDrive } from "lucide-react";
import { useApp } from "../lib/AppContext";
import { ensureLLMReady, ensureSTTReady, ensureTTSReady, ensureVADReady } from "../lib/runanywhere";
import type { ModelStatus } from "../lib/runanywhere";

function StatusDot({ status }: { status: ModelStatus }) {
  if (status === "loaded") return <div className="w-2 h-2 rounded-full bg-[#39FF14] shadow-[0_0_6px_rgba(57,255,20,0.5)]" />;
  if (status === "loading" || status === "downloading") return <Loader2 className="w-3 h-3 text-[#FFB800] animate-spin" />;
  if (status === "downloaded") return <Check className="w-3 h-3 text-[#00B4D8]" />;
  if (status === "error") return <div className="w-2 h-2 rounded-full bg-[#FF3131]" />;
  return <div className="w-2 h-2 rounded-full bg-zinc-700" />;
}

function ModelRow({ icon, label, status, progress }: { icon: React.ReactNode; label: string; status: ModelStatus; progress: number }) {
  const statusLabel: Record<ModelStatus, string> = {
    "not-downloaded": "Ready to download",
    downloading: `Downloading ${progress.toFixed(0)}%`,
    downloaded: "Cached locally",
    loading: "Loading to WASM...",
    loaded: "Active",
    error: "Error",
  };

  return (
    <div className="flex items-center gap-3">
      <div className="w-7 h-7 rounded bg-[#0D0D0F] border border-[#1E1E22] flex items-center justify-center shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-mono text-zinc-300 truncate">{label}</span>
          <StatusDot status={status} />
        </div>
        <div className="text-[9px] font-mono text-zinc-600">{statusLabel[status]}</div>
        {(status === "downloading") && (
          <div className="mt-1 h-0.5 bg-[#1E1E22] rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-[#39FF14]"
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default function OnDeviceAIPanel() {
  const { aiState } = useApp();
  const [isDownloading, setIsDownloading] = useState(false);

  const isReady = aiState.sdkStatus === "ready";
  const anyLoaded = aiState.llmStatus === "loaded";
  const allDownloaded =
    aiState.llmStatus !== "not-downloaded" &&
    aiState.sttStatus !== "not-downloaded" &&
    aiState.ttsStatus !== "not-downloaded" &&
    aiState.vadStatus !== "not-downloaded";

  const handleDownloadAll = useCallback(async () => {
    if (isDownloading) return;
    setIsDownloading(true);
    try {
      await Promise.all([
        ensureLLMReady().catch(() => {}),
        ensureSTTReady().catch(() => {}),
        ensureTTSReady().catch(() => {}),
        ensureVADReady().catch(() => {}),
      ]);
    } finally {
      setIsDownloading(false);
    }
  }, [isDownloading]);

  return (
    <div className="glass-card p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-[#9B59B6]" />
          <h3 className="text-[11px] font-mono font-bold tracking-wider text-zinc-300">ON-DEVICE AI</h3>
        </div>
        <div className="flex items-center gap-1.5">
          <AnimatePresence mode="wait">
            {aiState.sdkStatus === "initializing" && (
              <motion.span key="init" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-[9px] font-mono text-[#FFB800]">
                INITIALIZING...
              </motion.span>
            )}
            {isReady && (
              <motion.span key="ready" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-[9px] font-mono text-[#39FF14]">
                SDK READY
              </motion.span>
            )}
            {aiState.sdkStatus === "error" && (
              <motion.span key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-[9px] font-mono text-[#FF3131]">
                ERROR
              </motion.span>
            )}
          </AnimatePresence>
          <div className={`w-1.5 h-1.5 rounded-full ${isReady ? "bg-[#39FF14]" : aiState.sdkStatus === "error" ? "bg-[#FF3131]" : "bg-[#FFB800] animate-pulse"}`} />
        </div>
      </div>

      {/* Acceleration badge */}
      {isReady && (
        <div className="flex items-center gap-2 p-2 bg-[#0D0D0F] border border-[#1E1E22] rounded">
          <Zap className="w-3.5 h-3.5 text-[#FFB800]" />
          <div>
            <div className="text-[10px] font-mono text-zinc-400">
              Inference: <span className="text-[#FFB800]">{aiState.acceleration === "webgpu" ? "WebGPU" : "CPU (WASM)"}</span>
            </div>
            <div className="text-[8px] font-mono text-zinc-700">
              All processing happens in your browser — zero cloud calls
            </div>
          </div>
        </div>
      )}

      {/* Model rows */}
      <div className="space-y-3">
        <ModelRow
          icon={<Brain className="w-3.5 h-3.5 text-[#9B59B6]" />}
          label="LLM — Forensic Reasoning"
          status={aiState.llmStatus}
          progress={aiState.llmProgress}
        />
        <ModelRow
          icon={<Mic className="w-3.5 h-3.5 text-[#00B4D8]" />}
          label="STT — Voice Commands"
          status={aiState.sttStatus}
          progress={aiState.sttProgress}
        />
        <ModelRow
          icon={<Volume2 className="w-3.5 h-3.5 text-[#39FF14]" />}
          label="TTS — Verdict Readout"
          status={aiState.ttsStatus}
          progress={aiState.ttsProgress}
        />
        <ModelRow
          icon={<Radio className="w-3.5 h-3.5 text-[#FFB800]" />}
          label="VAD — Activity Detection"
          status={aiState.vadStatus}
          progress={aiState.vadProgress}
        />
      </div>

      {/* Download All button */}
      {isReady && !allDownloaded && (
        <button
          onClick={handleDownloadAll}
          disabled={isDownloading}
          className="w-full flex items-center justify-center gap-2 py-2 rounded border border-[#9B59B6]/30 bg-[#9B59B6]/10 text-[#9B59B6] text-[10px] font-mono font-bold hover:bg-[#9B59B6]/20 transition-colors disabled:opacity-50"
        >
          {isDownloading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Download className="w-3.5 h-3.5" />
          )}
          {isDownloading ? "DOWNLOADING MODELS..." : "DOWNLOAD ALL MODELS (~425 MB)"}
        </button>
      )}

      {/* Storage info */}
      {anyLoaded && (
        <div className="flex items-center gap-2 p-2 bg-[#0D0D0F] border border-[#1E1E22] rounded">
          <HardDrive className="w-3.5 h-3.5 text-zinc-500" />
          <div className="text-[9px] font-mono text-zinc-500">
            Models stored in OPFS • Persistent across sessions • One-time download
          </div>
        </div>
      )}

      {/* Privacy badge */}
      <div className="border-t border-[#1E1E22] pt-3">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-full bg-[#39FF14]/10 border border-[#39FF14]/20 flex items-center justify-center">
            <Cpu className="w-2.5 h-2.5 text-[#39FF14]" />
          </div>
          <div>
            <div className="text-[9px] font-mono text-[#39FF14]/80 font-bold">100% PRIVATE — ZERO CLOUD</div>
            <div className="text-[8px] font-mono text-zinc-700">
              {anyLoaded
                ? "AI models loaded in WASM • Documents never leave your device"
                : "Models download once, run locally forever • No internet needed after setup"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
