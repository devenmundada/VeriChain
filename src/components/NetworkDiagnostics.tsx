"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Wifi, WifiOff, Activity, Server, Zap } from "lucide-react";
import { getNetworkStats } from "../lib/blockchain";

interface NetStats {
  rpcLatency: number;
  networkStatus: "healthy" | "degraded" | "down" | "offline";
  blockHeight: number;
  gasPrice: string;
}

const statusMeta: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  healthy: { label: "Connected", color: "#39FF14", icon: <Wifi className="w-3.5 h-3.5" /> },
  degraded: { label: "Slow", color: "#FFB800", icon: <Activity className="w-3.5 h-3.5" /> },
  down: { label: "Unreachable", color: "#FF3131", icon: <WifiOff className="w-3.5 h-3.5" /> },
  offline: { label: "Offline", color: "#FFB800", icon: <WifiOff className="w-3.5 h-3.5" /> },
};

function latencyLabel(ms: number) {
  if (ms < 300) return "Fast";
  if (ms < 800) return "Normal";
  return "Slow";
}

export default function NetworkDiagnostics() {
  const [stats, setStats] = useState<NetStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function poll() {
      try {
        const s = await getNetworkStats();
        if (mounted) setStats(s);
      } catch {
        if (mounted) setStats(null);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    poll();
    const id = setInterval(poll, 30_000);
    return () => { mounted = false; clearInterval(id); };
  }, []);

  const meta = stats ? statusMeta[stats.networkStatus] : statusMeta.down;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, delay: 0.5 }}
      className="glass-card"
    >
      <div className="flex items-center justify-between p-4 border-b border-[#1E1E22]">
        <div className="flex items-center gap-2">
          <Server className="w-4 h-4 text-[#6366F1]" />
          <span className="text-sm font-semibold text-zinc-300">Blockchain Network</span>
        </div>
        <span className="flex items-center gap-1 text-[11px]" style={{ color: meta.color }}>
          {meta.icon}
          {loading ? "Checking..." : meta.label}
        </span>
      </div>

      <div className="p-4">
        {loading ? (
          <div className="flex items-center justify-center h-[100px]">
            <Activity className="w-5 h-5 text-zinc-700 animate-pulse" />
          </div>
        ) : !stats ? (
          <div className="text-center py-6">
            <WifiOff className="w-6 h-6 text-zinc-700 mx-auto mb-2" />
            <p className="text-xs text-zinc-600">Cannot reach blockchain network</p>
          </div>
        ) : stats.networkStatus === "offline" ? (
          <div className="text-center py-6 space-y-2">
            <WifiOff className="w-6 h-6 text-[#FFB800] mx-auto" />
            <p className="text-xs text-[#FFB800] font-mono font-bold">OFFLINE MODE</p>
            <p className="text-[10px] text-zinc-500 max-w-[200px] mx-auto">
              AI analysis &amp; verification work offline. Blockchain minting resumes when connected.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {/* latency */}
            <div className="bg-[#050506] border border-[#1E1E22] p-3 space-y-1">
              <p className="text-[10px] text-zinc-600 uppercase tracking-wider">Response Time</p>
              <p className="text-lg font-semibold text-zinc-200">{stats.rpcLatency}ms</p>
              <p className="text-[10px]" style={{ color: stats.rpcLatency < 300 ? "#39FF14" : stats.rpcLatency < 800 ? "#FFB800" : "#FF3131" }}>
                {latencyLabel(stats.rpcLatency)}
              </p>
            </div>

            {/* block height */}
            <div className="bg-[#050506] border border-[#1E1E22] p-3 space-y-1">
              <p className="text-[10px] text-zinc-600 uppercase tracking-wider">Latest Block</p>
              <p className="text-lg font-semibold text-zinc-200">#{stats.blockHeight.toLocaleString()}</p>
              <p className="text-[10px] text-zinc-600">Polygon Amoy</p>
            </div>

            {/* gas */}
            <div className="bg-[#050506] border border-[#1E1E22] p-3 space-y-1">
              <p className="text-[10px] text-zinc-600 uppercase tracking-wider">Gas Price</p>
              <p className="text-lg font-semibold text-zinc-200">{stats.gasPrice}</p>
              <p className="text-[10px] text-zinc-600">Transaction fee</p>
            </div>

            {/* status */}
            <div className="bg-[#050506] border border-[#1E1E22] p-3 space-y-1">
              <p className="text-[10px] text-zinc-600 uppercase tracking-wider">Network Health</p>
              <p className="text-lg font-semibold" style={{ color: meta.color }}>{meta.label}</p>
              <p className="text-[10px] text-zinc-600">Live status</p>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}
