"use client";

import { motion } from "framer-motion";
import { Brain, CheckCircle2, AlertTriangle, MinusCircle, Activity, IdCard, GraduationCap, ListChecks } from "lucide-react";
import { useApp } from "../lib/AppContext";

const STATUS = {
  pass: { icon: CheckCircle2, color: "#39FF14", label: "passed" },
  flag: { icon: AlertTriangle, color: "#FF3131", label: "flagged" },
  skip: { icon: MinusCircle, color: "#52525B", label: "not applicable" },
} as const;

function Row({ label, qr, printed }: { label: string; qr?: string; printed?: string }) {
  const both = qr && printed;
  const same = both && qr.toUpperCase().replace(/\s+/g, " ").trim() === printed.toUpperCase().replace(/\s+/g, " ").trim();
  const color = !both ? "#71717A" : same ? "#39FF14" : "#FF3131";
  return (
    <tr className="border-b border-[#1E1E22] last:border-0">
      <td className="py-1.5 pr-2 text-zinc-500">{label}</td>
      <td className="py-1.5 pr-2 text-zinc-300 font-mono">{qr ?? "—"}</td>
      <td className="py-1.5 pr-2 font-mono" style={{ color }}>{printed ?? "—"}</td>
    </tr>
  );
}

export default function AIForensicPanel() {
  const { state } = useApp();
  const isAnalyzing = state.stage === "analyzing";
  const fr = state.forensicResult;

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.2 }} className="glass-card">
      <div className="flex items-center justify-between p-4 border-b border-[#1E1E22]">
        <div className="flex items-center gap-2">
          <ListChecks className="w-4 h-4 text-[#39FF14]" />
          <span className="text-sm font-semibold text-zinc-300">Checks Run On-Device</span>
        </div>
        {isAnalyzing && (
          <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.5, repeat: Infinity }} className="flex items-center gap-1.5">
            <Activity className="w-3 h-3 text-[#FFB800]" />
            <span className="text-[11px] text-[#FFB800]">Scanning...</span>
          </motion.div>
        )}
      </div>

      {fr ? (
        <div className="p-5 space-y-5">
          {/* Checks */}
          <div className="grid grid-cols-1 gap-1">
            {fr.checks.map((c) => {
              const s = STATUS[c.status];
              const Icon = s.icon;
              return (
                <div key={c.id + c.label} className="flex items-center gap-2 text-[11px] py-1 border-b border-[#1E1E22]/60 last:border-0">
                  <Icon className="w-3.5 h-3.5 shrink-0" style={{ color: s.color }} />
                  <span className={c.status === "skip" ? "text-zinc-600" : "text-zinc-300"}>{c.label}</span>
                  <span className="ml-auto text-zinc-600 font-mono text-[10px] text-right truncate max-w-[55%]">{c.note ?? s.label}</span>
                </div>
              );
            })}
          </div>

          {/* Aadhaar QR vs printed */}
          {fr.aadhaar && (
            <div className="p-3 bg-[#0D0D0F] border border-[#1E1E22]">
              <div className="flex items-center gap-2 mb-2">
                <IdCard className="w-3.5 h-3.5 text-[#00B4D8]" />
                <span className="text-[10px] font-mono font-bold text-[#00B4D8] tracking-wider">AADHAAR — SIGNED QR vs PRINTED</span>
              </div>
              {fr.aadhaar.qr ? (
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-[9px] text-zinc-600 uppercase tracking-wider">
                      <th className="text-left font-normal pb-1">Field</th>
                      <th className="text-left font-normal pb-1">QR ({fr.aadhaar.qr.kind === "secure" ? "signed" : "unsigned"})</th>
                      <th className="text-left font-normal pb-1">Printed</th>
                    </tr>
                  </thead>
                  <tbody>
                    <Row label="Name" qr={fr.aadhaar.qr.name} printed={fr.aadhaar.printedName} />
                    <Row label="DOB" qr={fr.aadhaar.qr.dob ?? fr.aadhaar.qr.yob} printed={fr.aadhaar.printedDob ?? fr.aadhaar.printedYob} />
                    <Row label="Gender" qr={fr.aadhaar.qr.gender?.[0]} printed={fr.aadhaar.printedGender} />
                    <Row
                      label="Last 4"
                      qr={fr.aadhaar.qr.last4}
                      printed={fr.aadhaar.printedNumbers[0]?.slice(-4) ?? fr.aadhaar.maskedLast4[0]}
                    />
                  </tbody>
                </table>
              ) : (
                <p className="text-[11px] text-zinc-500">QR not readable — upload the e-Aadhaar PDF or a sharper photo.</p>
              )}
              {fr.aadhaar.numberValid !== undefined && (
                <p className="text-[11px] mt-2" style={{ color: fr.aadhaar.numberValid ? "#39FF14" : "#FF3131" }}>
                  Check digit (Verhoeff): {fr.aadhaar.numberValid ? "valid" : "INVALID"} — {fr.aadhaar.printedNumbers.join(", ")}
                </p>
              )}
            </div>
          )}

          {/* Marksheet */}
          {fr.marksheet?.checked && (
            <div className="p-3 bg-[#0D0D0F] border border-[#1E1E22]">
              <div className="flex items-center gap-2 mb-2">
                <GraduationCap className="w-3.5 h-3.5 text-[#9B59B6]" />
                <span className="text-[10px] font-mono font-bold text-[#9B59B6] tracking-wider">MARKSHEET ARITHMETIC</span>
                <span className="ml-auto text-[10px] font-mono" style={{ color: fr.marksheet.consistent ? "#39FF14" : "#FF3131" }}>
                  {fr.marksheet.consistent ? "CONSISTENT" : "DOESN'T ADD UP"}
                </span>
              </div>
              <div className="text-[11px] font-mono text-zinc-500 space-y-0.5 max-h-40 overflow-y-auto">
                {fr.marksheet.subjects.map((s, i) => (
                  <div key={i} className="flex justify-between gap-3">
                    <span className="truncate">{s.name}</span>
                    <span className="text-zinc-300">{s.values.join(" · ")}</span>
                  </div>
                ))}
                {fr.marksheet.totalRow && (
                  <div className="flex justify-between gap-3 pt-1 mt-1 border-t border-[#1E1E22] text-zinc-300">
                    <span>Total row</span>
                    <span>{fr.marksheet.totalRow.join(" · ")}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* On-device AI narration */}
          <div className="p-3 bg-[#0D0D0F] border border-[#9B59B6]/20">
            <div className="flex items-center gap-2 mb-2">
              <Brain className="w-3 h-3 text-[#9B59B6]" />
              <span className="text-[10px] font-mono font-bold text-[#9B59B6]">ON-DEVICE AI EXPLANATION</span>
              {fr.aiTokensPerSecond && (
                <span className="text-[8px] font-mono text-zinc-600 ml-auto">
                  {fr.aiTokensPerSecond.toFixed(1)} tok/s • {fr.aiLatencyMs}ms
                </span>
              )}
            </div>
            <p className="text-[11px] text-zinc-400 leading-relaxed font-mono">
              {fr.aiAnalysis ?? "Load the on-device model in the AI panel below to get a plain-language explanation. The verdict above comes from deterministic checks — the AI only explains it."}
            </p>
          </div>
        </div>
      ) : (
        <div className="p-8 flex flex-col items-center justify-center text-center gap-3 min-h-[200px]">
          <Brain className="w-10 h-10 text-zinc-800" />
          <p className="text-sm text-zinc-500">{isAnalyzing ? state.progressMessage ?? "Analyzing your document..." : "Upload a document to start"}</p>
        </div>
      )}
    </motion.div>
  );
}
