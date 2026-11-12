"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { motion } from "framer-motion";
import { Shield, Hexagon, ExternalLink, AlertCircle, ShieldX, ShieldAlert, ShieldCheck, BadgeCheck, ArrowRight } from "lucide-react";
import Link from "next/link";
import { getRecord, type AnalysisRecord } from "../../../lib/forensics/registry";

const STYLE: Record<string, { color: string; icon: typeof ShieldCheck }> = {
  EDITED: { color: "#FF3131", icon: ShieldX },
  SUSPICIOUS: { color: "#FFB800", icon: ShieldAlert },
  NO_SIGNS: { color: "#39FF14", icon: ShieldCheck },
  MATCHES_ORIGINAL: { color: "#39FF14", icon: BadgeCheck },
  INCONCLUSIVE: { color: "#00B4D8", icon: ShieldAlert },
};

export default function VerifyPage() {
  const params = useParams<{ id: string }>();
  const documentId = params.id;
  const [record, setRecord] = useState<AnalysisRecord | null | undefined>(undefined);

  useEffect(() => {
    getRecord(documentId).then(setRecord);
  }, [documentId]);

  const st = record ? STYLE[record.verdict] ?? STYLE.INCONCLUSIVE : null;
  const Icon = st?.icon ?? Shield;

  return (
    <div className="min-h-screen bg-[#0A0A0B] text-white flex flex-col">
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

      <main className="flex-1 flex items-center justify-center px-4 sm:px-6 py-12">
        <motion.div initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }} className="w-full max-w-lg">
          <div className="glass-card p-6 space-y-6" style={st ? { borderColor: st.color + "40" } : undefined}>
            <div className="flex items-center gap-3">
              <Icon className="w-6 h-6" style={{ color: st?.color ?? "#71717A" }} />
              <h2 className="text-lg font-mono font-bold tracking-wider" style={{ color: st?.color }}>
                {record === undefined ? "LOADING…" : record ? record.verdictTitle : "RECORD NOT ON THIS DEVICE"}
              </h2>
            </div>

            {record && <p className="text-sm text-zinc-300 leading-relaxed">{record.summary}</p>}

            {record && record.changes.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {record.changes.slice(0, 6).map((c, i) => (
                  <span key={i} className="flex items-center gap-2 px-2.5 py-1 bg-[#0D0D0F] border border-[#FF3131]/30 font-mono text-xs">
                    <span className="text-zinc-400 line-through">{c.before || "∅"}</span>
                    <ArrowRight className="w-3 h-3 text-[#FF3131]" />
                    <span className="text-[#FF3131] font-bold">{c.after || "∅"}</span>
                  </span>
                ))}
              </div>
            )}

            <div className="space-y-3 text-[11px] font-mono">
              <div className="flex justify-between gap-4 border-b border-[#1E1E22] pb-2">
                <span className="text-zinc-500">Document ID</span>
                <span className="text-[#00D4FF] break-all text-right">{documentId}</span>
              </div>
              {record && (
                <>
                  <div className="flex justify-between gap-4 border-b border-[#1E1E22] pb-2">
                    <span className="text-zinc-500">File</span>
                    <span className="text-zinc-300 text-right break-all">{record.fileName}</span>
                  </div>
                  <div className="flex justify-between gap-4 border-b border-[#1E1E22] pb-2">
                    <span className="text-zinc-500">Analysed</span>
                    <span className="text-zinc-300">{new Date(record.createdAt).toLocaleString()}</span>
                  </div>
                  {record.sha256 && (
                    <div className="flex justify-between gap-4 border-b border-[#1E1E22] pb-2">
                      <span className="text-zinc-500 shrink-0">SHA-256</span>
                      <span className="text-zinc-300 break-all text-right">0x{record.sha256}</span>
                    </div>
                  )}
                  {record.merkleRoot && (
                    <div className="flex justify-between gap-4 border-b border-[#1E1E22] pb-2">
                      <span className="text-zinc-500 shrink-0">Spatial Merkle root</span>
                      <span className="text-[#FF00E5] break-all text-right">0x{record.merkleRoot}</span>
                    </div>
                  )}
                  <div className="flex justify-between gap-4 border-b border-[#1E1E22] pb-2">
                    <span className="text-zinc-500">Proof</span>
                    <span className="text-zinc-300 text-right">{record.network ?? "—"}</span>
                  </div>
                </>
              )}
            </div>

            <div className="border border-[#FFB800]/30 bg-[#FFB800]/5 p-3 flex gap-2">
              <AlertCircle className="w-4 h-4 text-[#FFB800] shrink-0 mt-0.5" />
              <p className="text-[10px] font-mono text-[#FFB800]/80 leading-relaxed">
                {record
                  ? "This record was created on this device — nothing was uploaded. To check a copy someone sends you, upload it on the dashboard: the SHA-256 must match exactly."
                  : "Analysis records are stored only in the browser that ran the check (privacy-first, no server). Open this link on that device, or upload the file again on the dashboard."}
              </p>
            </div>

            <Link
              href="/"
              className="flex items-center justify-center gap-2 text-[10px] font-mono px-3 py-2 border border-[#39FF14]/30 text-[#39FF14] hover:bg-[#39FF14]/10 transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
              OPEN DASHBOARD
            </Link>
          </div>
        </motion.div>
      </main>
    </div>
  );
}
