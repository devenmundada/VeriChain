"use client";

import React, { createContext, useContext, useReducer, useCallback, useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { analyzeDocument, buildNarrationPrompt, PdfPasswordError, type ForensicResult } from "../lib/forensicEngine";
import { generateHashes, type HashResult } from "../lib/hashEngine";
import { mintProof, type BlockchainProof, type LedgerEvent } from "../lib/blockchain";
import { initSDK, getAIState, subscribeAIState, generateWithLLM, type AIState } from "../lib/runanywhere";
import { saveRecord } from "../lib/forensics/registry";

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

  // Live analysis progress + PDF password prompt
  progressMessage: string | null;
  passwordPrompt: { fileName: string; incorrect: boolean } | null;
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
  | { type: "SET_ERROR"; error: string }
  | { type: "PROGRESS"; message: string | null }
  | { type: "PASSWORD_PROMPT"; prompt: AppState["passwordPrompt"] }
  | { type: "PREVIEW"; url: string | null }
  | { type: "AI_NARRATION"; text: string; tokensPerSecond: number | null; latencyMs: number | null };

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
  progressMessage: null,
  passwordPrompt: null,
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
      // a newer step means the earlier "pending" steps have finished
      return {
        ...state,
        ledgerEvents: [
          ...state.ledgerEvents.map((e) =>
            (e.status === "pending" || e.status === "broadcasting") && action.event.status !== "failed" ? { ...e, status: "confirmed" as const } : e
          ),
          action.event,
        ],
      };
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
      return { ...state, error: action.error, stage: "error", passwordPrompt: null, progressMessage: null };
    case "PROGRESS":
      return { ...state, progressMessage: action.message };
    case "PASSWORD_PROMPT":
      return { ...state, passwordPrompt: action.prompt };
    case "PREVIEW":
      return { ...state, filePreviewUrl: action.url };
    case "AI_NARRATION":
      return state.forensicResult
        ? {
            ...state,
            forensicResult: {
              ...state.forensicResult,
              aiAnalysis: action.text,
              aiTokensPerSecond: action.tokensPerSecond,
              aiLatencyMs: action.latencyMs,
            },
          }
        : state;
    default:
      return state;
  }
}

// === Context ===

interface AppContextType {
  state: AppState;
  aiState: AIState;
  startPipeline: (file: File) => Promise<void>;
  submitPassword: (password: string | null) => void;
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
  const [state, rawDispatch] = useReducer(reducer, initialState);
  const [aiState, setAiState] = useState<AIState>(getAIState());
  const passwordResolver = useRef<((pw: string | null) => void) | null>(null);
  // Each upload gets a run id; updates from an older run (e.g. a slow blockchain step) are ignored.
  const runRef = useRef(0);

  const submitPassword = useCallback((pw: string | null) => {
    const resolve = passwordResolver.current;
    passwordResolver.current = null;
    resolve?.(pw);
  }, []);

  // Initialize SDK and subscribe to AI state changes
  useEffect(() => {
    initSDK().catch(() => {}); // Fire-and-forget — SDK init is non-blocking
    const unsub = subscribeAIState(setAiState);
    return unsub;
  }, []);

  const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);

  const startPipeline = useCallback(async (file: File) => {
    const runId = ++runRef.current;
    const dispatch = (action: Action) => {
      if (runRef.current === runId) rawDispatch(action);
    };
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

    let forensicResult: ForensicResult;
    try {
      let password: string | undefined;
      for (;;) {
        try {
          forensicResult = await analyzeDocument(file, {
            password,
            onProgress: (message) => dispatch({ type: "PROGRESS", message }),
          });
          break;
        } catch (err) {
          if (!(err instanceof PdfPasswordError)) throw err;
          dispatch({ type: "PASSWORD_PROMPT", prompt: { fileName: file.name, incorrect: err.incorrect } });
          const pw = await new Promise<string | null>((resolve) => {
            passwordResolver.current = resolve;
          });
          dispatch({ type: "PASSWORD_PROMPT", prompt: null });
          if (pw === null) throw new Error("This PDF is password-protected. For e-Aadhaar the password is the first 4 letters of the name in CAPITALS followed by the birth year (e.g. RAHU1990).");
          password = pw;
        }
      }
      dispatch({ type: "PROGRESS", message: null });
      dispatch({ type: "FORENSIC_COMPLETE", result: forensicResult });
      if (!previewUrl && forensicResult.pageImageUrl) dispatch({ type: "PREVIEW", url: forensicResult.pageImageUrl });

      dispatch({
        type: "TIMELINE_EVENT",
        event: {
          type: "verified",
          label: "Tamper Map Analysis",
          timestamp: now(),
          actor: "On-Device Forensic Engine",
          detail: `${forensicResult.verdictTitle} — ${forensicResult.evidence.filter((e) => e.severity === "critical").length} critical, ${forensicResult.evidence.filter((e) => e.severity === "warning").length} warnings — ${(forensicResult.analysisMs / 1000).toFixed(1)}s`,
        },
      });

      // On-device LLM narrates the verdict in the background — only if the model is already loaded,
      // so a first-time model download never blocks the result.
      if (getAIState().llmStatus === "loaded") {
        const fr = forensicResult;
        let tps: number | null = null;
        let latency: number | null = null;
        generateWithLLM(
          buildNarrationPrompt(fr),
          { maxTokens: 70, temperature: 0, systemPrompt: "You help people verify documents. Use plain, simple words. Do not invent facts." },
          { onComplete: (_t, m) => { tps = m.tokensPerSecond; latency = m.latencyMs; } }
        )
          .then((text) => { if (text) dispatch({ type: "AI_NARRATION", text, tokensPerSecond: tps, latencyMs: latency }); })
          .catch(() => {});
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const friendly = /Invalid PDF|InvalidPDF|bad XRef|Invalid XRef|PDF header/i.test(raw)
        ? "This PDF is damaged or isn't a real PDF file. Try downloading it again from the issuer."
        : /decode|source image|InvalidStateError|EncodingError/i.test(raw)
        ? "This image couldn't be opened. Use a JPG or PNG, or take a new photo."
        : raw;
      dispatch({
        type: "SET_ERROR",
        error: `Analysis failed: ${friendly}`,
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
        forensicResult.authenticityScore,
        (event) => dispatch({ type: "LEDGER_EVENT", event })
      );

      dispatch({ type: "BLOCKCHAIN_COMPLETE", proof });

      // Keep a record on this device so /verify/<id> (and the record's QR) can show it.
      saveRecord({
        id: documentId,
        fileName: file.name,
        verdict: forensicResult.verdict,
        verdictTitle: forensicResult.verdictTitle,
        summary: forensicResult.summary,
        sha256: forensicResult.fingerprint?.sha256 ?? hashResult.sha256,
        merkleRoot: forensicResult.merkleRoot,
        changes: forensicResult.changes,
        createdAt: new Date().toISOString(),
        network: proof?.networkName,
        txHash: proof?.txHash,
      }).catch(() => {});

      if (proof) {
        dispatch({
          type: "TIMELINE_EVENT",
          event: {
            type: "verified",
            label: proof.explorerUrl ? "Blockchain Anchored" : "Local Proof Created",
            timestamp: now(),
            actor: proof.networkName,
            detail: proof.explorerUrl
              ? `Block #${proof.blockNumber.toLocaleString()} — TX: ${proof.txHash.slice(0, 16)}...`
              : `Proof hash ${proof.txHash.slice(0, 16)}... (not on chain — connect MetaMask to anchor)`,
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
  }, []);

  const reset = useCallback(() => {
    runRef.current++;
    passwordResolver.current?.(null);
    passwordResolver.current = null;
    if (state.filePreviewUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(state.filePreviewUrl);
    }
    rawDispatch({ type: "RESET" });
  }, [state.filePreviewUrl]);

  return (
    <AppContext.Provider value={{ state, aiState, startPipeline, submitPassword, reset }}>
      {children}
    </AppContext.Provider>
  );
}
