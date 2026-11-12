"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Fingerprint, Copy, Check } from "lucide-react";
import { useApp } from "../lib/AppContext";

export default function HashTerminal() {
  const { state } = useApp();
  const isHashing = state.stage === "hashing";
  const hashResult = state.hashResult;
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  // Reset copied state when hash changes
  useEffect(() => { setCopiedField(null); }, [hashResult]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, delay: 0.4 }}
      className="glass-card"
    >
      <div className="flex items-center justify-between p-4 border-b border-[#1E1E22]">
        <div className="flex items-center gap-2">
          <Fingerprint className="w-4 h-4 text-[#00B4D8]" />
          <span className="text-sm font-semibold text-zinc-300">Digital Fingerprint</span>
        </div>
        <span className={`text-[11px] ${hashResult ? "text-[#39FF14]" : "text-zinc-600"}`}>
          {hashResult ? "Locked" : "Pending"}
        </span>
      </div>

      <div className="p-4">
        {hashResult ? (
          <div className="space-y-4">
            {/* What is this - plain explanation */}
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              These are your document&#39;s unique digital fingerprints. Even the smallest change to the file would produce completely different values.
            </p>

            {/* SHA-256 */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-300">Content Hash (SHA-256)</span>
                <button
                  onClick={() => copyToClipboard(hashResult.sha256, "sha")}
                  className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  {copiedField === "sha" ? <Check className="w-3 h-3 text-[#39FF14]" /> : <Copy className="w-3 h-3" />}
                  {copiedField === "sha" ? "Copied!" : "Copy"}
                </button>
              </div>
              <div className="p-2.5 bg-[#050506] border border-[#1E1E22] font-mono text-[11px] text-[#39FF14] break-all leading-relaxed">
                0x{hashResult.sha256}
              </div>
              <p className="text-[10px] text-zinc-700">Exact byte-level content identifier — changes if even one pixel is modified</p>
            </div>

            {/* pHash */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-300">Visual Hash (pHash)</span>
                <button
                  onClick={() => copyToClipboard(hashResult.pHash, "phash")}
                  className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  {copiedField === "phash" ? <Check className="w-3 h-3 text-[#39FF14]" /> : <Copy className="w-3 h-3" />}
                  {copiedField === "phash" ? "Copied!" : "Copy"}
                </button>
              </div>
              <div className="p-2.5 bg-[#050506] border border-[#1E1E22] font-mono text-[11px] text-[#00B4D8] break-all leading-relaxed">
                {hashResult.pHash}
              </div>
              <p className="text-[10px] text-zinc-700">Visual similarity fingerprint — detects if the image content looks the same even after re-saving</p>
            </div>

            {/* File info */}
            <div className="flex items-center justify-between pt-2 mt-2 border-t border-[#1E1E22] text-[11px] text-zinc-600">
              <span>Size: {(hashResult.fileSize / 1024).toFixed(1)} KB</span>
              <span>{new Date(hashResult.timestamp).toLocaleTimeString()}</span>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center text-center gap-3 py-10">
            <Fingerprint className="w-10 h-10 text-zinc-800" />
            <div>
              <p className="text-sm text-zinc-500">
                {isHashing ? "Creating fingerprints..." : "Waiting for upload"}
              </p>
              <p className="text-[11px] text-zinc-700 mt-1">
                Unique identifiers will be generated for your document
              </p>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}
