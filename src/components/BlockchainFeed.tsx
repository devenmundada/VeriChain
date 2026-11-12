"use client";

import { motion } from "framer-motion";
import { Link, CheckCircle2, Clock, Loader2, AlertCircle } from "lucide-react";
import { useApp } from "../lib/AppContext";

const statusConfig = {
  pending: { icon: Clock, color: "#6B7280", label: "Waiting" },
  broadcasting: { icon: Loader2, color: "#FFB800", label: "In Progress" },
  confirmed: { icon: CheckCircle2, color: "#39FF14", label: "Done" },
  failed: { icon: AlertCircle, color: "#FF3131", label: "Failed" },
};

export default function BlockchainFeed() {
  const { state } = useApp();
  const entries = state.ledgerEvents;
  const isMinting = state.stage === "minting";

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, delay: 0.5 }}
      className="glass-card"
    >
      <div className="flex items-center justify-between p-4 border-b border-[#1E1E22]">
        <div className="flex items-center gap-2">
          <Link className="w-4 h-4 text-[#9B59B6]" />
          <span className="text-sm font-semibold text-zinc-300">Blockchain Activity</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${isMinting ? "bg-[#FFB800] animate-pulse" : entries.length > 0 ? "bg-[#39FF14]" : "bg-zinc-600"}`} />
          <span className="text-[11px] text-zinc-500">
            {isMinting ? "Recording..." : entries.length > 0 ? "Recorded" : "Waiting"}
          </span>
        </div>
      </div>

      <div className="p-3 space-y-1.5 max-h-[300px] overflow-y-auto">
        {entries.length > 0 ? (
          entries.map((entry, i) => {
            const config = statusConfig[entry.status];
            const StatusIcon = config.icon;
            return (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3 }}
                className="flex items-start gap-3 p-2.5 bg-[#0D0D0F]/50 border border-[#1E1E22]/50 rounded-sm"
              >
                <StatusIcon
                  className={`w-4 h-4 shrink-0 mt-0.5 ${entry.status === "broadcasting" ? "animate-spin" : ""}`}
                  style={{ color: config.color }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-zinc-300">{entry.detail}</span>
                    <span className="text-[10px] shrink-0" style={{ color: config.color }}>
                      {config.label}
                    </span>
                  </div>
                  {entry.txHash && (
                    <div className="text-[10px] text-zinc-600 mt-1 font-mono truncate">
                      TX: {entry.txHash.slice(0, 24)}...
                    </div>
                  )}
                </div>
              </motion.div>
            );
          })
        ) : (
          <div className="flex flex-col items-center justify-center py-10 gap-2">
            <Link className="w-8 h-8 text-zinc-800" />
            <p className="text-xs text-zinc-600 text-center">
              {isMinting ? "Connecting to blockchain..." : "Your proof will be recorded here"}
            </p>
            <p className="text-[10px] text-zinc-700 text-center max-w-[200px]">
              Each step of the recording process will appear as it happens
            </p>
          </div>
        )}
      </div>

      <div className="px-4 py-2.5 border-t border-[#1E1E22] flex items-center justify-between">
        <span className="text-[10px] text-zinc-600">Polygon Amoy Testnet</span>
        <span className="text-[10px] text-zinc-600">
          {state.blockchainProof ? `Gas used: ${state.blockchainProof.gasUsed}` : "—"}
        </span>
      </div>
    </motion.div>
  );
}
