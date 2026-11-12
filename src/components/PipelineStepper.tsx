"use client";

import { motion } from "framer-motion";
import { Upload, Brain, Fingerprint, Link, Shield, CheckCircle2, Loader2 } from "lucide-react";
import { useApp } from "../lib/AppContext";

const steps = [
  { key: "uploading", icon: Upload, label: "Upload", desc: "Your file is being read" },
  { key: "analyzing", icon: Brain, label: "AI Analysis", desc: "Checking for tampering" },
  { key: "hashing", icon: Fingerprint, label: "Fingerprint", desc: "Creating unique ID" },
  { key: "minting", icon: Link, label: "Blockchain", desc: "Recording proof on-chain" },
  { key: "complete", icon: Shield, label: "Certified", desc: "Verification complete!" },
] as const;

const stageOrder = ["idle", "uploading", "analyzing", "hashing", "minting", "complete", "error"];

export default function PipelineStepper() {
  const { state } = useApp();
  const currentIndex = stageOrder.indexOf(state.stage);

  if (state.stage === "idle") return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="w-full"
    >
      <div className="glass-card p-5">
        <div className="flex items-center justify-between relative">
          {/* Connecting line */}
          <div className="absolute top-5 left-[10%] right-[10%] h-[2px] bg-[#1E1E22]" />
          <motion.div
            className="absolute top-5 left-[10%] h-[2px] bg-[#39FF14]"
            initial={{ width: "0%" }}
            animate={{
              width: `${Math.max(0, Math.min(100, ((currentIndex - 1) / (steps.length - 1)) * 80))}%`,
            }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            style={{ boxShadow: "0 0 12px rgba(57,255,20,0.4)" }}
          />

          {steps.map((step, i) => {
            const stepIndex = stageOrder.indexOf(step.key);
            const isActive = state.stage === step.key;
            const isDone = currentIndex > stepIndex;
            const isPending = currentIndex < stepIndex;
            const Icon = step.icon;

            return (
              <div key={step.key} className="flex flex-col items-center gap-2 relative z-10" style={{ width: "20%" }}>
                <motion.div
                  className={`w-10 h-10 rounded-full flex items-center justify-center border-2 transition-all duration-300 ${
                    isDone
                      ? "bg-[#39FF14]/15 border-[#39FF14]"
                      : isActive
                      ? "bg-[#FFB800]/15 border-[#FFB800]"
                      : "bg-[#0A0A0B] border-[#1E1E22]"
                  }`}
                  animate={isActive ? { scale: [1, 1.1, 1] } : {}}
                  transition={isActive ? { duration: 1.5, repeat: Infinity } : {}}
                >
                  {isDone ? (
                    <CheckCircle2 className="w-5 h-5 text-[#39FF14]" />
                  ) : isActive ? (
                    <Loader2 className="w-5 h-5 text-[#FFB800] animate-spin" />
                  ) : (
                    <Icon className={`w-5 h-5 ${isPending ? "text-zinc-600" : "text-zinc-400"}`} />
                  )}
                </motion.div>
                <div className="text-center">
                  <div className={`text-xs font-semibold ${isDone ? "text-[#39FF14]" : isActive ? "text-[#FFB800]" : "text-zinc-500"}`}>
                    {step.label}
                  </div>
                  <div className={`text-[10px] mt-0.5 ${isActive ? "text-zinc-400" : "text-zinc-600"}`}>
                    {isActive ? step.desc : isDone ? "Done" : ""}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Error state */}
        {state.stage === "error" && state.error && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mt-4 p-3 bg-[#FF3131]/10 border border-[#FF3131]/30 text-sm text-[#FF3131]"
          >
            {state.error}
          </motion.div>
        )}
      </div>
    </motion.div>
  );
}
