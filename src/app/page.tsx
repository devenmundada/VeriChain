"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Shield, Hexagon, WifiOff, Wifi } from "lucide-react";
import { useOnlineStatus } from "../lib/useOnlineStatus";
import HeroUpload from "../components/HeroUpload";
import PipelineStepper from "../components/PipelineStepper";
import VerdictCard from "../components/VerdictCard";
import AIForensicPanel from "../components/AIForensicPanel";
import HeatmapViewer from "../components/HeatmapViewer";
import HashTerminal from "../components/HashTerminal";
import BlockchainFeed from "../components/BlockchainFeed";
import VerificationSeal from "../components/VerificationSeal";
import TimelinePanel from "../components/TimelinePanel";
import NetworkDiagnostics from "../components/NetworkDiagnostics";
import IssuerIdentity from "../components/IssuerIdentity";
import OnDeviceAIPanel from "../components/OnDeviceAIPanel";
import AIAssistantPanel from "../components/AIAssistantPanel";
import VoicePipelinePanel from "../components/VoicePipelinePanel";
import PerformanceMetrics from "../components/PerformanceMetrics";
import { ToastProvider } from "../components/ToastProvider";
import { AppProvider, useApp } from "../lib/AppContext";

function DashboardContent() {
  const { state } = useApp();
  const isOnline = useOnlineStatus();
  const isIdle = state.stage === "idle";
  const hasForensic = !!state.forensicResult;
  const isComplete = state.stage === "complete";

  return (
    <div className="min-h-screen bg-[#0A0A0B] text-white">
      {/* Compact header */}
      <header className="border-b border-[#1E1E22] bg-[#0A0A0B]/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-5xl mx-auto px-6 h-12 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <motion.div
              className="relative"
              animate={{ rotate: [0, 360] }}
              transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
            >
              <Hexagon className="w-6 h-6 text-[#39FF14]" strokeWidth={1.5} />
              <Shield className="w-3 h-3 text-[#39FF14] absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" strokeWidth={2} />
            </motion.div>
            <span className="text-sm font-bold tracking-wider font-[family-name:var(--font-clash)]">
              VERICHAIN
            </span>
          </div>
          <div className="flex items-center gap-2">
            <AnimatePresence mode="wait">
              {!isOnline ? (
                <motion.div
                  key="offline"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[#FFB800]/10 border border-[#FFB800]/20"
                >
                  <WifiOff className="w-3 h-3 text-[#FFB800]" />
                  <span className="text-[9px] font-mono text-[#FFB800] font-bold">OFFLINE MODE</span>
                </motion.div>
              ) : (
                <motion.span
                  key="online"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="text-[10px] font-mono text-zinc-600 hidden sm:block"
                >
                  On-Device AI Verification • Zero Cloud • Powered by RunAnywhere
                </motion.span>
              )}
            </AnimatePresence>
          </div>
        </div>
      </header>

      {/* Offline banner */}
      <AnimatePresence>
        {!isOnline && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="bg-[#FFB800]/5 border-b border-[#FFB800]/10"
          >
            <div className="max-w-5xl mx-auto px-6 py-2 flex items-center justify-center gap-2">
              <WifiOff className="w-3.5 h-3.5 text-[#FFB800]" />
              <span className="text-[10px] font-mono text-[#FFB800]">
                You&apos;re offline — AI analysis, voice features, and document verification still work.
                Blockchain minting requires internet.
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        {/* ---- HERO UPLOAD ---- */}
        <HeroUpload />

        {/* ---- PIPELINE STEPPER ---- */}
        <PipelineStepper />

        {/* ---- VERDICT (only after forensic) ---- */}
        {hasForensic && <VerdictCard />}

        {/* ---- ANALYSIS DETAILS (only after forensic) ---- */}
        {hasForensic && (
          <section>
            <SectionLabel text="Analysis Details" />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <AIForensicPanel />
              <HeatmapViewer />
            </div>
          </section>
        )}

        {/* ---- DIGITAL FINGERPRINT & BLOCKCHAIN ---- */}
        {(state.hashResult || state.ledgerEvents.length > 0 || isComplete) && (
          <section>
            <SectionLabel text="Fingerprint & Blockchain" />
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <HashTerminal />
              <BlockchainFeed />
              <VerificationSeal />
            </div>
          </section>
        )}

        {/* ---- AI ASSISTANT (always visible) ---- */}
        <section>
          <SectionLabel text="AI Assistant — Ask About Your Document" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <AIAssistantPanel />
            <div className="space-y-4">
              <VoicePipelinePanel />
              <OnDeviceAIPanel />
            </div>
          </div>
        </section>

        {/* ---- ACTIVITY & NETWORK ---- */}
        {!isIdle && (
          <section>
            <SectionLabel text="Activity & Network" />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <TimelinePanel />
              <div className="space-y-4">
                <PerformanceMetrics />
                <NetworkDiagnostics />
              </div>
            </div>
          </section>
        )}

        {/* ---- ISSUER IDENTITY ---- */}
        {!isIdle && (
          <section>
            <SectionLabel text="Issuer & Identity" />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <IssuerIdentity />
            </div>
          </section>
        )}

        {/* Footer */}
        <footer className="pt-6 pb-4 border-t border-[#1E1E22] flex items-center justify-between text-[9px] font-mono text-zinc-700">
          <span>VERICHAIN v1.0 — On-Device AI + Blockchain Proof</span>
          <span>Powered by RunAnywhere SDK</span>
        </footer>
      </main>
    </div>
  );
}

function SectionLabel({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <div className="h-px flex-1 bg-gradient-to-r from-[#39FF14]/20 to-transparent" />
      <span className="text-[10px] font-mono text-zinc-500 tracking-[0.2em] uppercase">{text}</span>
      <div className="h-px flex-1 bg-gradient-to-l from-[#39FF14]/20 to-transparent" />
    </div>
  );
}

export default function Dashboard() {
  return (
    <ToastProvider>
      <AppProvider>
        <DashboardContent />
      </AppProvider>
    </ToastProvider>
  );
}
