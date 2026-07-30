"use client";

import { useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Upload, FileSearch, X, ImageIcon, RotateCcw } from "lucide-react";
import { useApp } from "../lib/AppContext";

export default function HeroUpload() {
  const { state, startPipeline, reset } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);

  const isIdle = state.stage === "idle";
  const isProcessing = !isIdle && state.stage !== "complete" && state.stage !== "error";

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

  // Demo sample — create a synthetic image for instant demo
  const handleDemo = async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    const ctx = canvas.getContext("2d")!;

    // Draw a fake certificate
    ctx.fillStyle = "#F5F0E8";
    ctx.fillRect(0, 0, 800, 600);

    // Border
    ctx.strokeStyle = "#C9A961";
    ctx.lineWidth = 4;
    ctx.strokeRect(20, 20, 760, 560);
    ctx.lineWidth = 1;
    ctx.strokeRect(30, 30, 740, 540);

    // Title
    ctx.fillStyle = "#1A1A2E";
    ctx.font = "bold 36px serif";
    ctx.textAlign = "center";
    ctx.fillText("Certificate of Authenticity", 400, 100);

    // Decorative line
    ctx.strokeStyle = "#C9A961";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(150, 120);
    ctx.lineTo(650, 120);
    ctx.stroke();

    // Body text
    ctx.font = "18px serif";
    ctx.fillStyle = "#333";
    ctx.fillText("This is to certify that the document bearer", 400, 200);
    ctx.font = "bold 28px serif";
    ctx.fillStyle = "#1A1A2E";
    ctx.fillText("VeriChain Demo Document", 400, 250);
    ctx.font = "16px serif";
    ctx.fillStyle = "#555";
    ctx.fillText("has been verified using AI forensic analysis", 400, 300);
    ctx.fillText("and blockchain cryptographic proof.", 400, 325);

    // Date
    ctx.font = "14px serif";
    ctx.fillStyle = "#777";
    ctx.fillText(`Issued: ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`, 400, 400);

    // Add some deliberate noise in one region (to trigger ELA)
    const noiseRegion = ctx.getImageData(500, 350, 120, 80);
    for (let i = 0; i < noiseRegion.data.length; i += 4) {
      noiseRegion.data[i] = Math.min(255, noiseRegion.data[i] + Math.random() * 40);
      noiseRegion.data[i + 1] = Math.min(255, noiseRegion.data[i + 1] + Math.random() * 30);
    }
    ctx.putImageData(noiseRegion, 500, 350);

    // Signature area
    ctx.font = "italic 20px serif";
    ctx.fillStyle = "#1A1A2E";
    ctx.fillText("Digital Signature", 400, 480);
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(280, 500);
    ctx.quadraticCurveTo(350, 470, 400, 500);
    ctx.quadraticCurveTo(450, 530, 520, 500);
    ctx.stroke();

    canvas.toBlob((blob) => {
      if (blob) {
        const file = new File([blob], "VeriChain-Demo-Certificate.jpg", { type: "image/jpeg" });
        handleFile(file);
      }
    }, "image/jpeg", 0.92);
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
                Verify any document in{" "}
                <span className="text-[#39FF14]">seconds</span>
              </motion.h2>
              <motion.p
                className="text-zinc-400 text-base md:text-lg max-w-xl mx-auto"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.2 }}
              >
                Upload an image or document. On-device AI scans for tampering, creates a
                unique fingerprint, and records proof on the blockchain — <span className="text-[#39FF14]">100% in your browser, zero cloud</span>.
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
                  accept="image/*,.pdf,.doc,.docx"
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
                    or click to browse — PNG, JPG, PDF, DOCX up to 50MB
                  </p>
                </div>
              </div>

              {/* Demo button */}
              <div className="px-6 pb-5 pt-2 text-center">
                <button
                  onClick={(e) => { e.stopPropagation(); handleDemo(); }}
                  className="text-sm text-zinc-500 hover:text-[#39FF14] transition-colors underline underline-offset-2 decoration-zinc-700 hover:decoration-[#39FF14]/40"
                >
                  or try a demo sample →
                </button>
              </div>
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
                On-device AI — files never leave your device
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
                    <span className="text-xs text-[#FFB800]">Processing...</span>
                  </div>
                )}
                {(state.stage === "complete" || state.stage === "error") && (
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

            {/* Progress visualization */}
            {isProcessing && state.filePreviewUrl && (
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
