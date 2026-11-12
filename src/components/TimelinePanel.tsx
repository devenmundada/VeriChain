"use client";

import { motion } from "framer-motion";
import { Clock, Upload, ScanSearch, Link2, CheckCircle2, XCircle } from "lucide-react";
import { useApp } from "../lib/AppContext";

const iconMap: Record<string, React.ReactNode> = {
  issued: <Upload className="w-3.5 h-3.5" />,
  verified: <CheckCircle2 className="w-3.5 h-3.5" />,
  shared: <Link2 className="w-3.5 h-3.5" />,
  updated: <ScanSearch className="w-3.5 h-3.5" />,
  revoked: <XCircle className="w-3.5 h-3.5" />,
};

function eventColor(type: string) {
  if (type === "revoked") return "#FF3131";
  if (type === "updated") return "#FFB800";
  if (type === "verified") return "#39FF14";
  if (type === "shared") return "#00B4D8";
  return "#6366F1";
}

function formatTimestamp(ts: string) {
  try {
    const d = new Date(ts.replace(" ", "T"));
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return ts;
  }
}

export default function TimelinePanel() {
  const { state } = useApp();
  const events = state.timelineEvents;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, delay: 0.3 }}
      className="glass-card"
    >
      <div className="flex items-center justify-between p-4 border-b border-[#1E1E22]">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-[#6366F1]" />
          <span className="text-sm font-semibold text-zinc-300">Activity Log</span>
        </div>
        {events.length > 0 && (
          <span className="text-[10px] text-zinc-600">{events.length} event{events.length !== 1 ? "s" : ""}</span>
        )}
      </div>

      <div className="p-4 min-h-[180px] max-h-[320px] overflow-y-auto custom-scroll">
        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-[160px] gap-2">
            <Clock className="w-8 h-8 text-zinc-800" />
            <p className="text-xs text-zinc-600">Events will appear here as analysis runs</p>
          </div>
        ) : (
          <div className="relative pl-5">
            {/* vertical line */}
            <div className="absolute left-[7px] top-1 bottom-1 w-px bg-[#1E1E22]" />

            <div className="space-y-4">
              {events.map((e, i) => {
                const color = eventColor(e.type);
                return (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className="relative flex items-start gap-3"
                  >
                    {/* dot */}
                    <div
                      className="absolute -left-5 top-0.5 w-[15px] h-[15px] rounded-full border-2 flex items-center justify-center"
                      style={{ borderColor: color, background: "#0A0A0B" }}
                    >
                      <div className="w-[5px] h-[5px] rounded-full" style={{ background: color }} />
                    </div>

                    {/* content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span style={{ color }} className="shrink-0">
                          {iconMap[e.type] || iconMap.issued}
                        </span>
                        <span className="text-xs text-zinc-300 truncate">{e.label}</span>
                      </div>
                      {e.detail && (
                        <p className="text-[10px] text-zinc-500 mt-0.5 truncate">{e.detail}</p>
                      )}
                      <span className="text-[10px] text-zinc-600 mt-0.5 block">{formatTimestamp(e.timestamp)} — {e.actor}</span>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}
