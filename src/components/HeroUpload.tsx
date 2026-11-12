"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Upload, FileSearch, ImageIcon, RotateCcw, Lock, FileText, FlaskConical } from "lucide-react";
import { useApp } from "../lib/AppContext";

interface Sample {
  file: string;
  title: string;
  kind: string;
  expect: string;
}

export default function HeroUpload() {
  const { state, startPipeline, submitPassword, reset } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [password, setPassword] = useState("");

  useEffect(() => {
    fetch("/samples/manifest.json")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Sample[]) => setSamples(list))
      .catch(() => setSamples([]));
  }, []);

  const runSample = useCallback(
    async (s: Sample) => {
      const res = await fetch(`/samples/${s.file}`);
      const blob = await res.blob();
      startPipeline(new File([blob], s.file, { type: blob.type || (s.file.endsWith(".pdf") ? "application/pdf" : "image/jpeg") }));
    },
    [startPipeline]
  );

  const isIdle = state.stage === "idle";
  const isProcessing = !isIdle && state.stage !== "complete" && state.stage !== "error";
  // once the analysis is done the user can start over, even while the blockchain step finishes
  const canReset = state.stage === "complete" || state.stage === "error" || state.stage === "hashing" || state.stage === "minting";

  const handleFile = useCallback(
    (file: File) => {
      startPipeline(file);
    },
    [startPipeline]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const handleReset = () => {
    reset();
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div className="w-full">
      <AnimatePresence mode="wait">
        {isIdle ? (
          <motion.div
            key="hero"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.5 }}
          >
            {/* Hero text */}
            <div className="text-center mb-8">
              <motion.h2
                className="text-3xl md:text-4xl font-bold tracking-tight mb-3"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
              >
                Catch edited documents —{" "}
                <span className="text-[#39FF14]">without the original</span>
              </motion.h2>
              <motion.p
                className="text-zinc-400 text-base md:text-lg max-w-xl mx-auto"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.2 }}
              >
                Upload an Aadhaar card, marksheet or certificate (PDF or photo). VeriChain finds hidden earlier
                versions, covered text, pasted digits, QR mismatches and totals that don&apos;t add up — then shows
                exactly where it was changed. <span className="text-[#39FF14]">100% in your browser, zero cloud</span>.
              </motion.p>
            </div>

            {/* Upload area */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="glass-card max-w-2xl mx-auto"
            >
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleDrop}
                onClick={() => inputRef.current?.click()}
                className="p-10 flex flex-col items-center justify-center gap-5 cursor-pointer
                  border-2 border-dashed border-[#2A2A30] hover:border-[#39FF14]/40 transition-all duration-300 m-1"
              >
                <input
                  ref={inputRef}
                  type="file"
                  accept="image/*,.pdf,application/pdf"
                  className="hidden"
                  onChange={handleInputChange}
                />

                <motion.div
                  animate={{ y: [0, -6, 0] }}
                  transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
                  className="w-16 h-16 rounded-2xl bg-[#39FF14]/10 border border-[#39FF14]/20 flex items-center justify-center"
                >
                  <Upload className="w-7 h-7 text-[#39FF14]" />
                </motion.div>

                <div className="text-center">
                  <p className="text-base font-medium text-zinc-300">
                    Drag & drop your file here
                  </p>
                  <p className="text-sm text-zinc-500 mt-1">
                    or click to browse — PDF, JPG, PNG (e-Aadhaar, DigiLocker, scans, photos)
                  </p>
                </div>
              </div>

              {/* Demo samples */}
              {samples.length > 0 && (
                <div className="px-5 pb-5 pt-1" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center gap-2 mb-2 text-[10px] font-mono text-zinc-500 tracking-[0.15em]">
                    <FlaskConical className="w-3 h-3" /> TRY A TEST DOCUMENT (FICTIONAL SAMPLES)
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {samples.map((s) => (
                      <button
                        key={s.file}
                        onClick={() => runSample(s)}
                        className="flex items-center gap-2 px-3 py-2 text-left border border-[#1E1E22] hover:border-[#39FF14]/40 hover:bg-[#39FF14]/5 transition-colors group"
                      >
                        <FileText className="w-3.5 h-3.5 text-zinc-600 group-hover:text-[#39FF14] shrink-0" />
                        <span className="text-[11px] text-zinc-300 truncate">{s.title}</span>
                        <span className="ml-auto text-[9px] font-mono text-zinc-600 shrink-0">{s.kind}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>

            {/* Trust badges */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 }}
              className="flex items-center justify-center gap-6 mt-8 text-[11px] text-zinc-600"
            >
              <span className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-[#39FF14]" />
                Files never leave your device
              </span>
              <span className="hidden md:flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-[#00B4D8]" />
                Blockchain proof on Polygon
              </span>
              <span className="hidden md:flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-[#9B59B6]" />
                Powered by RunAnywhere SDK
              </span>
            </motion.div>
          </motion.div>
        ) : (
          <motion.div
            key="processing"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="glass-card max-w-2xl mx-auto"
          >
            <div className="p-4 flex items-center justify-between border-b border-[#1E1E22]">
              <div className="flex items-center gap-3">
                {state.filePreviewUrl ? (
                  <div className="w-10 h-10 bg-[#0D0D0F] border border-[#1E1E22] overflow-hidden flex items-center justify-center">
                    <img src={state.filePreviewUrl} alt="" className="w-full h-full object-cover" />
                  </div>
                ) : (
                  <div className="w-10 h-10 bg-[#0D0D0F] border border-[#1E1E22] flex items-center justify-center">
                    <ImageIcon className="w-5 h-5 text-zinc-600" />
                  </div>
                )}
                <div>
                  <p className="text-sm text-zinc-200 truncate max-w-[300px]">{state.file?.name}</p>
                  <p className="text-[11px] text-zinc-600">
                    {state.file ? `${(state.file.size / 1024).toFixed(1)} KB` : ""}
                    {state.documentId && <span className="ml-2 text-zinc-700">ID: {state.documentId}</span>}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {isProcessing && (
                  <div className="flex items-center gap-2">
                    <FileSearch className="w-4 h-4 text-[#FFB800] animate-pulse" />
                    <span className="text-xs text-[#FFB800] max-w-[220px] truncate">{state.progressMessage ?? "Processing..."}</span>
                  </div>
                )}
                {canReset && (
                  <button
                    onClick={handleReset}
                    className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-3 py-1.5 border border-[#1E1E22] hover:border-[#2A2A30]"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Start Over
                  </button>
                )}
              </div>
            </div>

            {/* PDF password prompt */}
            {state.passwordPrompt && (
              <form
                className="p-4 border-b border-[#1E1E22] space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  submitPassword(password);
                  setPassword("");
                }}
              >
                <div className="flex items-center gap-2 text-sm text-zinc-300">
                  <Lock className="w-4 h-4 text-[#FFB800]" />
                  {state.passwordPrompt.incorrect ? "Wrong password — try again" : "This PDF is password-protected"}
                </div>
                <p className="text-[11px] text-zinc-500">
                  e-Aadhaar: first 4 letters of the name in CAPITALS + year of birth (e.g. RAHU1990). The password is used only in this browser.
                </p>
                <div className="flex gap-2">
                  <input
                    type="password"
                    autoFocus
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="flex-1 bg-[#0D0D0F] border border-[#2A2A30] px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-[#39FF14]/50"
                    placeholder="PDF password"
                  />
                  <button type="submit" className="px-4 py-1.5 text-xs border border-[#39FF14]/40 text-[#39FF14] hover:bg-[#39FF14]/10">
                    Unlock
                  </button>
                  <button type="button" onClick={() => submitPassword(null)} className="px-3 py-1.5 text-xs border border-[#1E1E22] text-zinc-500 hover:text-zinc-300">
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {/* Progress visualization */}
            {isProcessing && (
              <div className="relative h-2 bg-[#0D0D0F]">
                <motion.div
                  className="absolute inset-y-0 left-0 bg-gradient-to-r from-[#39FF14]/60 to-[#39FF14]"
                  initial={{ width: "0%" }}
                  animate={{ width: state.stage === "analyzing" ? "35%" : state.stage === "hashing" ? "65%" : state.stage === "minting" ? "85%" : "100%" }}
                  transition={{ duration: 0.8, ease: "easeOut" }}
                />
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
