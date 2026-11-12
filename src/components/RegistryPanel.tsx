"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Landmark, BadgeCheck, ShieldX, Trash2, Stamp, GitBranch } from "lucide-react";
import { useApp } from "../lib/AppContext";
import { useToast } from "./ToastProvider";
import { clearRegistry, listOriginals, registerOriginal, type RegisteredOriginal } from "../lib/forensics/registry";

export default function RegistryPanel() {
  const { state } = useApp();
  const { toast } = useToast();
  const [originals, setOriginals] = useState<RegisteredOriginal[]>([]);
  const [issuer, setIssuer] = useState("Demo Institute Exam Cell");
  const [busy, setBusy] = useState(false);
  const fr = state.forensicResult;

  const refresh = useCallback(() => {
    listOriginals().then(setOriginals);
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh, fr]);

  const alreadyRegistered = !!fr?.fingerprint && originals.some((o) => o.sha256 === fr.fingerprint!.sha256);
  const match = fr?.registryMatch;
  const differs = !!match?.differs;

  const onRegister = async () => {
    if (!fr?.fingerprint || !state.file) return;
    setBusy(true);
    try {
      let thumb: string | null = null;
      if (fr.pageImageUrl) {
        const img = new Image();
        img.src = fr.pageImageUrl;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = 160;
        c.height = Math.round((img.height / img.width) * 160);
        c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
        thumb = c.toDataURL("image/jpeg", 0.7);
      }
      await registerOriginal({
        ...fr.fingerprint,
        id: state.documentId ?? crypto.randomUUID(),
        name: state.file.name,
        issuer: issuer.trim() || "Issuer",
        registeredAt: new Date().toISOString(),
        pageThumb: thumb,
      });
      toast("success", `Registered "${state.file.name}" as the original for ${issuer}`);
      refresh();
    } catch {
      toast("error", "Could not save to the on-device registry");
    } finally {
      setBusy(false);
    }
  };

  const onClear = async () => {
    await clearRegistry();
    toast("info", "Registry cleared");
    refresh();
  };

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.3 }} className="glass-card">
      <div className="flex items-center justify-between p-4 border-b border-[#1E1E22]">
        <div className="flex items-center gap-2">
          <Landmark className="w-4 h-4 text-[#FF00E5]" />
          <span className="text-sm font-semibold text-zinc-300">Issuer Registry</span>
        </div>
        <span className="text-[10px] font-mono text-zinc-600">{originals.length} original{originals.length !== 1 ? "s" : ""} on this device</span>
      </div>

      <div className="p-4 space-y-3">
        {match ? (
          <div className="p-3 border" style={{ borderColor: differs ? "#FF313150" : "#39FF1450", background: differs ? "rgba(255,49,49,0.06)" : "rgba(57,255,20,0.05)" }}>
            <div className="flex items-center gap-2 text-xs font-semibold" style={{ color: differs ? "#FF3131" : "#39FF14" }}>
              {differs ? <ShieldX className="w-4 h-4" /> : <BadgeCheck className="w-4 h-4" />}
              {differs ? "Differs from the registered original" : match.exact ? "Identical to the registered original" : "Same content as the registered original"}
            </div>
            <p className="text-[11px] text-zinc-500 mt-1">
              &quot;{match.original.name}&quot; · {match.original.issuer} · {new Date(match.original.registeredAt).toLocaleString()}
              {differs && ` · ${match.changedCells} grid cells${match.textChanges ? ` and ${match.textChanges} word(s)` : ""} changed`}
            </p>
          </div>
        ) : alreadyRegistered ? null : (
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            {originals.length
              ? "This file doesn't match any registered original, so the verdict relies on the no-original checks."
              : "No originals registered yet. As the issuer, register a genuine document — any later copy is then compared cell by cell, and the exact changed areas light up."}
          </p>
        )}

        {fr?.merkleRoot && (
          <div className="p-2 bg-[#0D0D0F] border border-[#1E1E22]">
            <div className="flex items-center gap-1.5 text-[9px] font-mono text-zinc-500 tracking-wider">
              <GitBranch className="w-3 h-3" /> SPATIAL MERKLE ROOT ({fr.fingerprint?.rows} row leaves × {fr.fingerprint?.cols} cells)
            </div>
            <div className="text-[10px] font-mono text-[#FF00E5] break-all mt-1">0x{fr.merkleRoot}</div>
            <div className="text-[9px] text-zinc-600 mt-1">The value an issuer anchors on Polygon or prints in a QR — a changed cell changes one leaf.</div>
          </div>
        )}

        {fr?.fingerprint && !alreadyRegistered && fr.verdict !== "EDITED" && (
          <div className="space-y-2">
            <input
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
              className="w-full bg-[#0D0D0F] border border-[#2A2A30] px-3 py-1.5 text-xs text-zinc-200 outline-none focus:border-[#FF00E5]/50"
              placeholder="Issuer name"
            />
            <button
              onClick={onRegister}
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs border border-[#FF00E5]/40 text-[#FF00E5] hover:bg-[#FF00E5]/10 transition-colors disabled:opacity-50"
            >
              <Stamp className="w-3.5 h-3.5" />
              Register this file as the original (issuer)
            </button>
          </div>
        )}
        {alreadyRegistered && <p className="text-[11px] text-[#39FF14]">This exact file is registered as an original.</p>}

        {originals.length > 0 && (
          <button onClick={onClear} className="flex items-center gap-1.5 text-[10px] text-zinc-600 hover:text-zinc-400">
            <Trash2 className="w-3 h-3" /> Clear registry
          </button>
        )}
        <p className="text-[9px] text-zinc-700">Demo: the registry lives in this browser (IndexedDB). Nothing is uploaded.</p>
      </div>
    </motion.div>
  );
}
