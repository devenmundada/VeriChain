"use client";

import React, { createContext, useContext, useReducer, useCallback, useEffect, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { analyzeDocument, type ForensicResult } from "../lib/forensicEngine";
import { generateHashes, type HashResult } from "../lib/hashEngine";
import { mintProof, type BlockchainProof, type LedgerEvent } from "../lib/blockchain";
import { initSDK, getAIState, subscribeAIState, type AIState } from "../lib/runanywhere";

// === Types ===

type PipelineStage =
  | "idle"
  | "uploading"
  | "analyzing"
  | "hashing"
  | "minting"
  | "complete"
  | "error";

interface TimelineEvent {
  type: "issued" | "verified" | "shared" | "updated" | "revoked";
  label: string;
  timestamp: string;
  actor: string;
  detail?: string;
}

export interface AppState {
  stage: PipelineStage;
  error: string | null;

  // File
  file: File | null;
  filePreviewUrl: string | null;
  documentId: string | null;

  // Forensic Analysis
  forensicResult: ForensicResult | null;

  // Hashes
  hashResult: HashResult | null;

  // Blockchain
  ledgerEvents: LedgerEvent[];
  blockchainProof: BlockchainProof | null;

  // Verification
  sealStatus: "ACTIVE" | "REVOKED" | "EXPIRED";
  verificationUrl: string | null;

  // Timeline
  timelineEvents: TimelineEvent[];
}

type Action =
  | { type: "RESET" }
  | { type: "FILE_UPLOADED"; file: File; previewUrl: string | null; documentId: string }
  | { type: "STAGE_CHANGE"; stage: PipelineStage }
  | { type: "FORENSIC_COMPLETE"; result: ForensicResult }
  | { type: "HASH_COMPLETE"; result: HashResult }
  | { type: "LEDGER_EVENT"; event: LedgerEvent }
  | { type: "BLOCKCHAIN_COMPLETE"; proof: BlockchainProof | null }
  | { type: "TIMELINE_EVENT"; event: TimelineEvent }
  | { type: "SET_ERROR"; error: string };

const initialState: AppState = {
  stage: "idle",
  error: null,
  file: null,
  filePreviewUrl: null,
  documentId: null,
  forensicResult: null,
  hashResult: null,
  ledgerEvents: [],
  blockchainProof: null,
  sealStatus: "ACTIVE",
  verificationUrl: null,
  timelineEvents: [],
};

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "RESET":
      return { ...initialState };
    case "FILE_UPLOADED":
      return {
        ...state,
        file: action.file,
        filePreviewUrl: action.previewUrl,
        documentId: action.documentId,
        stage: "uploading",
        error: null,
        ledgerEvents: [],
        blockchainProof: null,
        forensicResult: null,
        hashResult: null,
        timelineEvents: [],
        verificationUrl: null,
      };
    case "STAGE_CHANGE":
      return { ...state, stage: action.stage };
    case "FORENSIC_COMPLETE":
      return { ...state, forensicResult: action.result };
    case "HASH_COMPLETE":
      return { ...state, hashResult: action.result };
    case "LEDGER_EVENT":
      return { ...state, ledgerEvents: [...state.ledgerEvents, action.event] };
    case "BLOCKCHAIN_COMPLETE":
      return {
        ...state,
        blockchainProof: action.proof,
        sealStatus: action.proof ? "ACTIVE" : "EXPIRED",
        verificationUrl: action.proof
          ? `${typeof window !== "undefined" ? window.location.origin : ""}/verify/${state.documentId}`
          : null,
      };
    case "TIMELINE_EVENT":
      return {
        ...state,
        timelineEvents: [...state.timelineEvents, action.event],
      };
    case "SET_ERROR":
      return { ...state, error: action.error, stage: "error" };
    default:
      return state;
  }
}

// === Context ===

interface AppContextType {
  state: AppState;
  aiState: AIState;
  startPipeline: (file: File) => Promise<void>;
  reset: () => void;
}

const AppContext = createContext<AppContextType | null>(null);

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}

// === Provider ===

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [aiState, setAiState] = useState<AIState>(getAIState());

  // Initialize SDK and subscribe to AI state changes
  useEffect(() => {
    initSDK().catch(() => {}); // Fire-and-forget — SDK init is non-blocking
    const unsub = subscribeAIState(setAiState);
    return unsub;
  }, []);

  const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);

  const startPipeline = useCallback(async (file: File) => {
    const documentId = `VC-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}${String(new Date().getDate()).padStart(2, "0")}-${uuidv4().slice(0, 8).toUpperCase()}`;

    // Generate preview URL
    let previewUrl: string | null = null;
    if (file.type.startsWith("image/")) {
      previewUrl = URL.createObjectURL(file);
    }

    dispatch({ type: "FILE_UPLOADED", file, previewUrl, documentId });

    dispatch({
      type: "TIMELINE_EVENT",
      event: {
        type: "issued",
        label: "Document Uploaded",
        timestamp: now(),
        actor: "User",
        detail: `${file.name} (${(file.size / 1024).toFixed(1)} KB)`,
      },
    });

    // === Stage 1: Forensic Analysis ===
    dispatch({ type: "STAGE_CHANGE", stage: "analyzing" });

    try {
      const forensicResult = await analyzeDocument(file);
      dispatch({ type: "FORENSIC_COMPLETE", result: forensicResult });

      dispatch({
        type: "TIMELINE_EVENT",
        event: {
          type: "verified",
          label: "AI Forensic Analysis",
          timestamp: now(),
          actor: "On-Device AI (RunAnywhere)",
          detail: `Authenticity: ${forensicResult.authenticityScore}% — Risk: ${forensicResult.forgeryRisk}${forensicResult.aiTokensPerSecond ? ` — ${forensicResult.aiTokensPerSecond.toFixed(1)} tok/s` : ""}`,
        },
      });
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        error: `Forensic analysis failed: ${err instanceof Error ? err.message : "Unknown"}`,
      });
      return;
    }

    // === Stage 2: Cryptographic Hashing ===
    dispatch({ type: "STAGE_CHANGE", stage: "hashing" });

    let hashResult;
    try {
      hashResult = await generateHashes(file);
      dispatch({ type: "HASH_COMPLETE", result: hashResult });

      dispatch({
        type: "TIMELINE_EVENT",
        event: {
          type: "verified",
          label: "Fingerprint Generated",
          timestamp: now(),
          actor: "Hash Engine",
          detail: `SHA256: 0x${hashResult.sha256.slice(0, 12)}...`,
        },
      });
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        error: `Hashing failed: ${err instanceof Error ? err.message : "Unknown"}`,
      });
      return;
    }

    // === Stage 3: Blockchain Minting ===
    dispatch({ type: "STAGE_CHANGE", stage: "minting" });

    try {
      const proof = await mintProof(
        hashResult.sha256,
        hashResult.pHash,
        documentId,
        state.forensicResult?.authenticityScore ?? 0,
        (event) => dispatch({ type: "LEDGER_EVENT", event })
      );

      dispatch({ type: "BLOCKCHAIN_COMPLETE", proof });

      if (proof) {
        dispatch({
          type: "TIMELINE_EVENT",
          event: {
            type: "verified",
            label: "Blockchain Anchored",
            timestamp: now(),
            actor: proof.networkName,
            detail: `Block #${proof.blockNumber.toLocaleString()} — TX: ${proof.txHash.slice(0, 16)}...`,
          },
        });
      }
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        error: `Blockchain minting failed: ${err instanceof Error ? err.message : "Unknown"}`,
      });
      return;
    }

    // === Complete ===
    dispatch({ type: "STAGE_CHANGE", stage: "complete" });

    dispatch({
      type: "TIMELINE_EVENT",
      event: {
        type: "issued",
        label: "Verification Seal Issued",
        timestamp: now(),
        actor: "VeriChain Protocol",
        detail: `Document ID: ${documentId}`,
      },
    });
  }, [state.forensicResult?.authenticityScore]);

  const reset = useCallback(() => {
    if (state.filePreviewUrl) {
      URL.revokeObjectURL(state.filePreviewUrl);
    }
    dispatch({ type: "RESET" });
  }, [state.filePreviewUrl]);

  return (
    <AppContext.Provider value={{ state, aiState, startPipeline, reset }}>
      {children}
    </AppContext.Provider>
  );
}
