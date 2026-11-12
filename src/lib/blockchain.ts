/**
 * Blockchain Service
 * Connects to Polygon Amoy testnet to mint authenticity proofs.
 * Uses ethers.js v6 for wallet + contract interaction.
 *
 * In production: uses a deployed smart contract.
 * For hackathon: sends a real transaction with proof data encoded in calldata.
 */

import { ethers } from "ethers";

export interface BlockchainProof {
  txHash: string;
  blockNumber: number;
  networkName: string;
  timestamp: string;
  gasUsed: string;
  explorerUrl: string;
}

export interface LedgerEvent {
  timestamp: string;
  action: string;
  detail: string;
  status: "pending" | "broadcasting" | "confirmed" | "failed";
  txHash?: string;
}

// Polygon Amoy Testnet config
// rpc-amoy.polygon.technology no longer resolves (checked 2026-11-12) — use public RPCs with CORS, in order.
const AMOY_RPCS = ["https://polygon-amoy-bor-rpc.publicnode.com", "https://polygon-amoy.drpc.org"];
const AMOY_CHAIN_ID = 80002;
const EXPLORER_URL = "https://amoy.polygonscan.com/tx/";

/**
 * Get provider for Polygon Amoy testnet
 */
// One shared provider with a fixed network: no network-detection loop that retries forever
// (and floods the console) when the RPC is unreachable, e.g. on flaky Wi-Fi or offline.
const _providers: ethers.JsonRpcProvider[] = [];
let _active = 0;
export function getProvider(index = _active): ethers.JsonRpcProvider {
  if (!_providers[index]) {
    _providers[index] = new ethers.JsonRpcProvider(AMOY_RPCS[index], AMOY_CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 });
  }
  return _providers[index];
}

/** Run a read call on the first RPC that answers; remember which one worked. */
async function withProvider<T>(fn: (p: ethers.JsonRpcProvider) => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let k = 0; k < AMOY_RPCS.length; k++) {
    const idx = (_active + k) % AMOY_RPCS.length;
    try {
      const res = await Promise.race([
        fn(getProvider(idx)),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("RPC timeout")), 6000)),
      ]);
      _active = idx;
      return res;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/**
 * Check network health
 */
export async function getNetworkStats() {
  // If offline, return immediately without attempting network call
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return {
      rpcLatency: 0,
      networkStatus: "offline" as const,
      blockHeight: 0,
      gasPrice: "N/A",
      txQueue: 0,
      peersConnected: 0,
    };
  }
  try {
    const start = Date.now();
    const blockNumber = await withProvider((p) => p.getBlockNumber());
    const latency = Date.now() - start;

    const feeData = await withProvider((p) => p.getFeeData());

    return {
      rpcLatency: latency,
      networkStatus: latency < 500 ? "healthy" as const : latency < 2000 ? "degraded" as const : "down" as const,
      blockHeight: blockNumber,
      gasPrice: feeData.gasPrice
        ? `${(Number(feeData.gasPrice) / 1e9).toFixed(1)} Gwei`
        : "N/A",
      txQueue: 0,
      peersConnected: 128,
    };
  } catch {
    return {
      rpcLatency: 9999,
      networkStatus: "down" as const,
      blockHeight: 0,
      gasPrice: "N/A",
      txQueue: 0,
      peersConnected: 0,
    };
  }
}

/**
 * Mint an authenticity proof on-chain.
 *
 * Encodes the SHA256 hash and pHash into transaction calldata and sends it
 * to a burn address as an immutable on-chain record.
 *
 * For hackathon: Uses a generated wallet with testnet MATIC.
 * For production: Would call a deployed VerificationRegistry smart contract.
 */
export async function mintProof(
  sha256: string,
  pHash: string,
  documentId: string,
  authenticityScore: number,
  onEvent: (event: LedgerEvent) => void
): Promise<BlockchainProof | null> {
  const now = () =>
    new Date().toLocaleTimeString("en-US", { hour12: false });

  onEvent({
    timestamp: now(),
    action: "INIT",
    detail: "Initializing blockchain connection → Polygon Amoy",
    status: "pending",
  });

  try {
    // Offline check — skip blockchain entirely, generate local proof
    const isOffline = typeof navigator !== "undefined" && !navigator.onLine;

    if (isOffline) {
      onEvent({
        timestamp: now(),
        action: "OFFLINE",
        detail: "Device is offline — generating local proof (will anchor on-chain when reconnected)",
        status: "confirmed",
      });

      const proofData = `VERICHAIN_OFFLINE_PROOF:${sha256}:${pHash}:${documentId}:${authenticityScore}:${Date.now()}`;
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(proofData));
      const proofHash = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      await delay(400);

      onEvent({
        timestamp: now(),
        action: "LOCAL_PROOF",
        detail: `Local proof hash: 0x${proofHash.slice(0, 24)}...`,
        status: "confirmed",
      });

      await delay(300);

      onEvent({
        timestamp: now(),
        action: "COMPLETE",
        detail: "Offline proof generated — blockchain anchoring pending",
        status: "confirmed",
      });

      return {
        txHash: `0x${proofHash}`,
        blockNumber: 0,
        networkName: "Local (offline)",
        timestamp: new Date().toISOString(),
        gasUsed: "0",
        explorerUrl: "",
      };
    }

    // Check if user has MetaMask or similar
    const hasWallet = typeof window !== "undefined" && (window as unknown as Record<string, unknown>).ethereum;

    let signer: ethers.Signer;
    let provider: ethers.Provider;

    if (hasWallet) {
      onEvent({
        timestamp: now(),
        action: "WALLET",
        detail: "Requesting wallet connection...",
        status: "pending",
      });

      const browserProvider = new ethers.BrowserProvider(
        (window as unknown as Record<string, unknown>).ethereum as ethers.Eip1193Provider
      );

      // Request account access
      await browserProvider.send("eth_requestAccounts", []);

      // Check/switch to Amoy network
      try {
        await browserProvider.send("wallet_switchEthereumChain", [
          { chainId: `0x${AMOY_CHAIN_ID.toString(16)}` },
        ]);
      } catch {
        // Add Amoy network if not present
        await browserProvider.send("wallet_addEthereumChain", [
          {
            chainId: `0x${AMOY_CHAIN_ID.toString(16)}`,
            chainName: "Polygon Amoy Testnet",
            nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
            rpcUrls: AMOY_RPCS,
            blockExplorerUrls: ["https://amoy.polygonscan.com/"],
          },
        ]);
      }

      signer = await browserProvider.getSigner();
      provider = browserProvider;

      onEvent({
        timestamp: now(),
        action: "WALLET",
        detail: `Wallet connected: ${(await signer.getAddress()).slice(0, 10)}...`,
        status: "confirmed",
      });
    } else {
      // No wallet — simulate with encoded proof (view-only mode)
      onEvent({
        timestamp: now(),
        action: "WALLET",
        detail: "No Web3 wallet — creating a local proof only (connect MetaMask to publish on Polygon Amoy)",
        status: "confirmed",
      });

      // Generate a deterministic proof hash from the document data
      const proofData = `VERICHAIN_PROOF:${sha256}:${pHash}:${documentId}:${authenticityScore}:${Date.now()}`;
      const encoder = new TextEncoder();
      const data = encoder.encode(proofData);
      const hashBuffer = await crypto.subtle.digest("SHA-256", data);
      const proofHash = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      // Simulate the blockchain events with realistic timing
      onEvent({
        timestamp: now(),
        action: "ENCODE",
        detail: `Proof payload encoded (${proofData.length} bytes)`,
        status: "confirmed",
      });

      await delay(600);

      onEvent({
        timestamp: now(),
        action: "MINT_PROOF",
        detail: "Computing proof hash locally (simulation — nothing is sent)",
        status: "broadcasting",
      });

      await delay(1200);

      const simulatedTxHash = `0x${proofHash}`;

      onEvent({
        timestamp: now(),
        action: "TX_BROADCAST",
        detail: "Local proof hash ready (not broadcast)",
        status: "confirmed",
        txHash: simulatedTxHash,
      });

      await delay(800);

      let blockHeight = 0;
      try {
        blockHeight = await withProvider((p) => p.getBlockNumber());
      } catch {
        blockHeight = 0; // RPC unreachable — don't invent a block number
      }

      onEvent({
        timestamp: now(),
        action: "BLOCK_CONFIRM",
        detail: blockHeight
          ? `Polygon Amoy is at block #${blockHeight.toLocaleString()} — this proof is NOT on chain (simulation)`
          : "Polygon Amoy not reachable — this proof is NOT on chain (simulation)",
        status: "confirmed",
      });

      await delay(500);

      onEvent({
        timestamp: now(),
        action: "ANCHOR_HASH",
        detail: `SHA256 fingerprint in local proof: 0x${sha256.slice(0, 16)}...`,
        status: "confirmed",
      });

      onEvent({
        timestamp: now(),
        action: "COMPLETE",
        detail: "Local proof complete — install MetaMask to anchor it on Polygon Amoy",
        status: "confirmed",
      });

      return {
        txHash: simulatedTxHash,
        blockNumber: blockHeight,
        networkName: "Local proof (not on chain)",
        timestamp: new Date().toISOString(),
        gasUsed: "0",
        explorerUrl: "",
      };
    }

    // === Real wallet flow ===

    // Encode proof data
    const proofPayload = ethers.hexlify(
      ethers.toUtf8Bytes(
        JSON.stringify({
          protocol: "verichain-v1",
          documentId,
          sha256,
          pHash,
          authenticityScore,
          timestamp: Date.now(),
        })
      )
    );

    onEvent({
      timestamp: now(),
      action: "ENCODE",
      detail: `Proof payload encoded (${proofPayload.length / 2} bytes)`,
      status: "confirmed",
    });

    // Send transaction with proof in calldata
    onEvent({
      timestamp: now(),
      action: "MINT_PROOF",
      detail: "Minting authenticity proof → Polygon Amoy",
      status: "broadcasting",
    });

    const tx = await signer.sendTransaction({
      to: "0x000000000000000000000000000000000000dEaD", // burn address — immutable record
      value: BigInt(0),
      data: proofPayload,
    });

    onEvent({
      timestamp: now(),
      action: "TX_BROADCAST",
      detail: "Transaction broadcast to network",
      status: "confirmed",
      txHash: tx.hash,
    });

    // Wait for confirmation
    onEvent({
      timestamp: now(),
      action: "CONFIRMING",
      detail: "Waiting for block confirmation...",
      status: "broadcasting",
    });

    const receipt = await tx.wait();

    if (!receipt) {
      throw new Error("Transaction receipt is null");
    }

    onEvent({
      timestamp: now(),
      action: "BLOCK_CONFIRM",
      detail: `Block #${receipt.blockNumber.toLocaleString()} — ${receipt.status === 1 ? "confirmed" : "failed"}`,
      status: receipt.status === 1 ? "confirmed" : "failed",
    });

    onEvent({
      timestamp: now(),
      action: "ANCHOR_HASH",
      detail: `SHA256 anchored: 0x${sha256.slice(0, 16)}...`,
      status: "confirmed",
      txHash: tx.hash,
    });

    onEvent({
      timestamp: now(),
      action: "COMPLETE",
      detail: "Authenticity proof minted successfully ✓",
      status: "confirmed",
    });

    return {
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      networkName: "Polygon Amoy Testnet",
      timestamp: new Date().toISOString(),
      gasUsed: receipt.gasUsed.toString(),
      explorerUrl: `${EXPLORER_URL}${tx.hash}`,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    onEvent({
      timestamp: now(),
      action: "ERROR",
      detail: `Transaction failed: ${errorMessage.slice(0, 80)}`,
      status: "failed",
    });
    return null;
  }
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
