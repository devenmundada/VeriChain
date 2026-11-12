"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { User, Wallet, Copy, Check, ExternalLink } from "lucide-react";

function shortenAddr(addr: string) {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

export default function IssuerIdentity() {
  const [address, setAddress] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    async function detect() {
      try {
        if (typeof window !== "undefined" && (window as any).ethereum) {
          const accounts: string[] = await (window as any).ethereum.request({ method: "eth_accounts" });
          if (accounts.length > 0) setAddress(accounts[0]);
        }
      } catch {
        /* no wallet */
      }
    }
    detect();
  }, []);

  const handleConnect = async () => {
    try {
      if (typeof window !== "undefined" && (window as any).ethereum) {
        const accounts: string[] = await (window as any).ethereum.request({ method: "eth_requestAccounts" });
        if (accounts.length > 0) setAddress(accounts[0]);
      }
    } catch {
      /* user rejected */
    }
  };

  const handleCopy = () => {
    if (!address) return;
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, delay: 0.7 }}
      className="glass-card"
    >
      <div className="flex items-center justify-between p-4 border-b border-[#1E1E22]">
        <div className="flex items-center gap-2">
          <User className="w-4 h-4 text-[#6366F1]" />
          <span className="text-sm font-semibold text-zinc-300">Your Identity</span>
        </div>
      </div>

      <div className="p-4 min-h-[120px] flex flex-col items-center justify-center gap-3">
        {address ? (
          <>
            {/* avatar circle */}
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-[#6366F1] to-[#39FF14] flex items-center justify-center">
              <Wallet className="w-5 h-5 text-black" />
            </div>

            <div className="text-center">
              <p className="text-zinc-200 font-mono text-sm">{shortenAddr(address)}</p>
              <p className="text-[10px] text-zinc-600 mt-0.5">MetaMask Wallet</p>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 text-[10px] px-2 py-1 border border-[#1E1E22] text-zinc-500 hover:text-zinc-200 transition-colors"
              >
                {copied ? <Check className="w-3 h-3 text-[#39FF14]" /> : <Copy className="w-3 h-3" />}
                {copied ? "Copied" : "Copy"}
              </button>
              <a
                href={`https://www.oklink.com/amoy/address/${address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-[10px] px-2 py-1 border border-[#1E1E22] text-zinc-500 hover:text-zinc-200 transition-colors"
              >
                <ExternalLink className="w-3 h-3" />
                Explorer
              </a>
            </div>
          </>
        ) : (
          <>
            <div className="w-12 h-12 rounded-full border-2 border-dashed border-zinc-800 flex items-center justify-center">
              <Wallet className="w-5 h-5 text-zinc-700" />
            </div>
            <p className="text-xs text-zinc-500 text-center max-w-[180px]">
              Connect your wallet to sign proofs with your identity
            </p>
            <button
              onClick={handleConnect}
              className="text-[11px] px-4 py-1.5 border border-[#6366F1]/40 text-[#6366F1] hover:bg-[#6366F1]/10 transition-colors"
            >
              Connect Wallet
            </button>
            <p className="text-[10px] text-zinc-700">Optional — analysis works without a wallet</p>
          </>
        )}
      </div>
    </motion.div>
  );
}
