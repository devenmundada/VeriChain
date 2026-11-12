"use client";

import { useParams } from "next/navigation";
import { motion } from "framer-motion";
import { Shield, Hexagon, ExternalLink, CheckCircle2, AlertCircle } from "lucide-react";
import Link from "next/link";

export default function VerifyPage() {
  const params = useParams<{ id: string }>();
  const documentId = params.id;

  return (
    <div className="min-h-screen bg-[#0A0A0B] text-white flex flex-col">
      {/* Header */}
      <header className="border-b border-[#1E1E22] bg-[#0A0A0B]/80 backdrop-blur-xl">
        <div className="max-w-3xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
            <div className="relative">
              <Hexagon className="w-7 h-7 text-[#39FF14]" strokeWidth={1.5} />
              <Shield className="w-3.5 h-3.5 text-[#39FF14] absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" strokeWidth={2} />
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-wider font-[family-name:var(--font-clash)]">VERICHAIN</h1>
              <p className="text-[9px] font-mono text-zinc-600 tracking-widest">VERIFICATION PORTAL</p>
            </div>
          </Link>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-6 py-12">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="w-full max-w-lg"
        >
          <div className="glass-card p-6 space-y-6">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="w-6 h-6 text-[#39FF14]" />
              <h2 className="text-lg font-mono font-bold tracking-wider">PROOF VERIFICATION</h2>
            </div>

            <div className="space-y-3 text-[11px] font-mono">
              <div className="flex justify-between border-b border-[#1E1E22] pb-2">
                <span className="text-zinc-500">Document ID</span>
                <span className="text-[#00D4FF]">{documentId}</span>
              </div>
              <div className="flex justify-between border-b border-[#1E1E22] pb-2">
                <span className="text-zinc-500">Network</span>
                <span className="text-zinc-300">Polygon Amoy Testnet</span>
              </div>
              <div className="flex justify-between border-b border-[#1E1E22] pb-2">
                <span className="text-zinc-500">Protocol</span>
                <span className="text-zinc-300">VeriChain v1.0</span>
              </div>
            </div>

            <div className="border border-[#FFB800]/30 bg-[#FFB800]/5 p-3 flex gap-2">
              <AlertCircle className="w-4 h-4 text-[#FFB800] shrink-0 mt-0.5" />
              <p className="text-[10px] font-mono text-[#FFB800]/80 leading-relaxed">
                This is a client-side proof. For full verification, open the dashboard
                on the device where the proof was generated, or query the transaction
                hash directly on{" "}
                <a
                  href="https://amoy.polygonscan.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-[#FFB800]"
                >
                  Polygonscan Amoy
                </a>
                .
              </p>
            </div>

            <div className="flex gap-3">
              <Link
                href="/"
                className="flex-1 flex items-center justify-center gap-2 text-[10px] font-mono px-3 py-2 border border-[#39FF14]/30 text-[#39FF14] hover:bg-[#39FF14]/10 transition-colors"
              >
                <ExternalLink className="w-3 h-3" />
                OPEN DASHBOARD
              </Link>
            </div>
          </div>
        </motion.div>
      </main>
    </div>
  );
}
