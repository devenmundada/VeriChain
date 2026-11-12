"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Shield, QrCode, RefreshCcw, ExternalLink, Download } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useApp } from "../lib/AppContext";

export default function VerificationSeal() {
  const { state } = useApp();
  const isComplete = state.stage === "complete";
  const proof = state.blockchainProof;

  const sealColor =
    state.sealStatus === "ACTIVE"
      ? "#39FF14"
      : state.sealStatus === "REVOKED"
      ? "#FF3131"
      : "#FFB800";

  const statusLabel =
    state.sealStatus === "ACTIVE" ? "Verified" : state.sealStatus === "REVOKED" ? "Revoked" : "Expired";

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, delay: 0.6 }}
      className="glass-card"
    >
      <div className="flex items-center justify-between p-4 border-b border-[#1E1E22]">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4" style={{ color: sealColor }} />
          <span className="text-sm font-semibold text-zinc-300">Proof Certificate</span>
        </div>
        {isComplete && (
          <span className="text-xs px-2 py-0.5 rounded-full" style={{
            color: sealColor,
            background: sealColor + "15",
          }}>
            {statusLabel}
          </span>
        )}
      </div>

      <div className="p-4 flex flex-col items-center justify-center min-h-[280px]">
        <AnimatePresence mode="wait">
          {isComplete && proof ? (
            <motion.div
              key="seal"
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", damping: 20, stiffness: 300 }}
              className="flex flex-col items-center gap-4 w-full"
            >
              {/* QR Code */}
              <div className="p-3 border border-[#1E1E22] bg-[#050506]">
                <QRCodeSVG
                  value={state.verificationUrl || "https://verichain.xyz"}
                  size={120}
                  bgColor="#050506"
                  fgColor={sealColor}
                  level="M"
                />
              </div>

              <p className="text-[11px] text-zinc-500 text-center">
                Scan this QR code to verify this document anytime
              </p>

              {/* Proof details */}
              <div className="w-full space-y-2 text-xs">
                <div className="flex justify-between py-1.5 border-b border-[#1E1E22]">
                  <span className="text-zinc-500">Document ID</span>
                  <span className="text-zinc-300 font-mono text-[11px]">{state.documentId}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-[#1E1E22]">
                  <span className="text-zinc-500">Network</span>
                  <span className="text-zinc-300">{proof.networkName}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-[#1E1E22]">
                  <span className="text-zinc-500">Block</span>
                  <span className="text-zinc-300">#{proof.blockNumber.toLocaleString()}</span>
                </div>
                <div className="flex justify-between py-1.5">
                  <span className="text-zinc-500">Recorded</span>
                  <span className="text-zinc-300">{new Date(proof.timestamp).toLocaleString()}</span>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2 w-full mt-1">
                {state.verificationUrl && (
                  <a
                    href={state.verificationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 flex items-center justify-center gap-1.5 text-[11px] px-3 py-2 border border-[#1E1E22] text-zinc-400 hover:text-[#39FF14] hover:border-[#39FF14]/30 transition-colors"
                  >
                    <ExternalLink className="w-3 h-3" />
                    Verify
                  </a>
                )}
              </div>
            </motion.div>
          ) : (
            <motion.div key="waiting" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-4">
              <div className="w-[136px] h-[136px] border border-dashed border-zinc-800 flex items-center justify-center">
                <QrCode className="w-10 h-10 text-zinc-800" />
              </div>
              <div className="text-center space-y-1">
                <p className="text-xs text-zinc-500">
                  {state.stage === "idle"
                    ? "Upload a document to get a certificate"
                    : state.stage === "error"
                    ? "Certificate generation failed"
                    : "Creating your certificate..."}
                </p>
                {state.stage !== "idle" && state.stage !== "error" && (
                  <RefreshCcw className="w-4 h-4 text-zinc-700 mx-auto animate-spin" />
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
