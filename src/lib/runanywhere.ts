"use client";

/**
 * RunAnywhere SDK — On-Device AI Initialization
 * Handles SDK setup, model registration, download, and loading for
 * completely private, offline-capable AI inference in the browser.
 */

import {
  RunAnywhere,
  ModelManager,
  ModelCategory,
  LLMFramework,
  EventBus,
  SDKEnvironment,
  AudioCapture,
  AudioPlayback,
  SpeechActivity,
  VoicePipeline,
  type CompactModelDef,
} from "@runanywhere/web";

import { LlamaCPP, TextGeneration, ToolCalling, ToolCallFormat, StructuredOutput, toToolValue, getStringArg, LlamaCppBridge, type ToolValue } from "@runanywhere/web-llamacpp";
import { ONNX, STT, TTS, VAD, SherpaONNXBridge } from "@runanywhere/web-onnx";

// ── Model Catalog ────────────────────────────────────────────────

const MODELS: CompactModelDef[] = [
  // LLM for forensic analysis reasoning
  {
    id: "lfm2-350m-q4_k_m",
    name: "LFM2 350M Q4_K_M",
    repo: "LiquidAI/LFM2-350M-GGUF",
    files: ["LFM2-350M-Q4_K_M.gguf"],
    framework: LLMFramework.LlamaCpp,
    modality: ModelCategory.Language,
    memoryRequirement: 250_000_000,
  },
  // STT: Whisper Tiny for voice commands
  {
    id: "sherpa-onnx-whisper-tiny.en",
    name: "Whisper Tiny English (ONNX)",
    url: "https://huggingface.co/runanywhere/sherpa-onnx-whisper-tiny.en/resolve/main/sherpa-onnx-whisper-tiny.en.tar.gz",
    framework: LLMFramework.ONNX,
    modality: ModelCategory.SpeechRecognition,
    memoryRequirement: 105_000_000,
    artifactType: "archive" as const,
  },
  // TTS: Piper for reading verdicts aloud
  {
    id: "vits-piper-en_US-lessac-medium",
    name: "Piper TTS US English (Lessac)",
    url: "https://huggingface.co/runanywhere/vits-piper-en_US-lessac-medium/resolve/main/vits-piper-en_US-lessac-medium.tar.gz",
    framework: LLMFramework.ONNX,
    modality: ModelCategory.SpeechSynthesis,
    memoryRequirement: 65_000_000,
    artifactType: "archive" as const,
  },
  // VAD: Silero for voice activity detection
  {
    id: "silero-vad-v5",
    name: "Silero VAD v5",
    url: "https://huggingface.co/runanywhere/silero-vad-v5/resolve/main/silero_vad.onnx",
    files: ["silero_vad.onnx"],
    framework: LLMFramework.ONNX,
    modality: ModelCategory.Audio,
    memoryRequirement: 5_000_000,
  },
];

// ── State ────────────────────────────────────────────────────────

export type SDKStatus = "idle" | "initializing" | "ready" | "error";
export type ModelStatus = "not-downloaded" | "downloading" | "downloaded" | "loading" | "loaded" | "error";

export interface AIState {
  sdkStatus: SDKStatus;
  sdkError: string | null;
  acceleration: string;
  llmStatus: ModelStatus;
  llmProgress: number;
  sttStatus: ModelStatus;
  sttProgress: number;
  ttsStatus: ModelStatus;
  ttsProgress: number;
  vadStatus: ModelStatus;
  vadProgress: number;
}

const initialAIState: AIState = {
  sdkStatus: "idle",
  sdkError: null,
  acceleration: "unknown",
  llmStatus: "not-downloaded",
  llmProgress: 0,
  sttStatus: "not-downloaded",
  sttProgress: 0,
  ttsStatus: "not-downloaded",
  ttsProgress: 0,
  vadStatus: "not-downloaded",
  vadProgress: 0,
};

type AIListener = (state: AIState) => void;
let _aiState: AIState = { ...initialAIState };
const _listeners: Set<AIListener> = new Set();

function updateAIState(partial: Partial<AIState>) {
  _aiState = { ..._aiState, ...partial };
  _listeners.forEach((fn) => fn(_aiState));
}

export function getAIState(): AIState {
  return _aiState;
}

export function subscribeAIState(fn: AIListener): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// ── Init ─────────────────────────────────────────────────────────

let _initPromise: Promise<void> | null = null;

export async function initSDK(): Promise<void> {
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      updateAIState({ sdkStatus: "initializing" });

      // 1. Initialize core SDK
      await RunAnywhere.initialize({
        environment: SDKEnvironment.Development,
        debug: false,
      });

      // 2. Register backends — set WASM URL overrides so Next.js can serve them
      //    from public/ instead of relying on import.meta.url resolution
      const bridge = LlamaCppBridge.shared;
      bridge.webgpuWasmUrl = "/wasm/llamacpp/racommons-llamacpp-webgpu.js";
      bridge.wasmUrl = "/wasm/llamacpp/racommons-llamacpp.js";

      const onnxBridge = SherpaONNXBridge.shared;
      onnxBridge.wasmUrl = "/wasm/sherpa/sherpa-onnx-glue.js";
      onnxBridge.helperBaseUrl = "/wasm/sherpa/";

      await LlamaCPP.register();
      updateAIState({ acceleration: LlamaCPP.accelerationMode ?? "cpu" });

      try {
        await ONNX.register();
      } catch {
        console.warn("ONNX backend registration failed — STT/TTS/VAD unavailable");
      }

      // 3. Register model catalog
      RunAnywhere.registerModels(MODELS);

      // 4. Set up event listeners
      EventBus.shared.on("model.downloadProgress", (evt) => {
        const progress = (evt.progress ?? 0) * 100;
        if (evt.modelId === "lfm2-350m-q4_k_m") {
          updateAIState({ llmStatus: "downloading", llmProgress: progress });
        } else if (evt.modelId === "sherpa-onnx-whisper-tiny.en") {
          updateAIState({ sttStatus: "downloading", sttProgress: progress });
        } else if (evt.modelId === "vits-piper-en_US-lessac-medium") {
          updateAIState({ ttsStatus: "downloading", ttsProgress: progress });
        } else if (evt.modelId === "silero-vad-v5") {
          updateAIState({ vadStatus: "downloading", vadProgress: progress });
        }
      });

      // Check if models are already downloaded
      const models = ModelManager.getModels();
      for (const m of models) {
        if (m.status === "downloaded" || m.status === "loaded") {
          if (m.id === "lfm2-350m-q4_k_m") updateAIState({ llmStatus: "downloaded", llmProgress: 100 });
          if (m.id === "sherpa-onnx-whisper-tiny.en") updateAIState({ sttStatus: "downloaded", sttProgress: 100 });
          if (m.id === "vits-piper-en_US-lessac-medium") updateAIState({ ttsStatus: "downloaded", ttsProgress: 100 });
          if (m.id === "silero-vad-v5") updateAIState({ vadStatus: "downloaded", vadProgress: 100 });
        }
      }

      updateAIState({ sdkStatus: "ready" });

      // Eagerly preload the LLM if already downloaded (eliminates first-query load delay)
      const modelsAfterInit = ModelManager.getModels();
      const llmModel = modelsAfterInit.find((m) => m.id === "lfm2-350m-q4_k_m");
      if (llmModel && (llmModel.status === "downloaded") && !ModelManager.getLoadedModel(ModelCategory.Language)) {
        updateAIState({ llmStatus: "loading" });
        ModelManager.loadModel("lfm2-350m-q4_k_m").then(() => {
          updateAIState({ llmStatus: "loaded" });
          _llmLoaded = true;
          // Warm up the LLM with a tiny generation to prime WASM JIT and memory
          TextGeneration.generateStream("Hi", { maxTokens: 1, temperature: 0.0 })
            .then(({ stream }) => { (async () => { for await (const _ of stream) { /* discard */ } })(); })
            .catch(() => {});
        }).catch(() => {});
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "SDK init failed";
      updateAIState({ sdkStatus: "error", sdkError: msg });
      throw err;
    }
  })();

  return _initPromise;
}

// ── Model Download & Load Helpers ────────────────────────────────

// Fast-path check to avoid redundant async work when LLM is already loaded
let _llmLoaded = false;

export async function ensureLLMReady(): Promise<void> {
  if (_llmLoaded) {
    const loaded = ModelManager.getLoadedModel(ModelCategory.Language);
    if (loaded?.id === "lfm2-350m-q4_k_m") return;
    _llmLoaded = false;
  }

  await initSDK();
  const models = ModelManager.getModels();
  const llm = models.find((m) => m.id === "lfm2-350m-q4_k_m");

  if (!llm || (llm.status !== "downloaded" && llm.status !== "loaded")) {
    updateAIState({ llmStatus: "downloading" });
    await ModelManager.downloadModel("lfm2-350m-q4_k_m");
    updateAIState({ llmStatus: "downloaded", llmProgress: 100 });
  }

  const loaded = ModelManager.getLoadedModel(ModelCategory.Language);
  if (!loaded || loaded.id !== "lfm2-350m-q4_k_m") {
    updateAIState({ llmStatus: "loading" });
    await ModelManager.loadModel("lfm2-350m-q4_k_m");
    updateAIState({ llmStatus: "loaded" });
  }
  _llmLoaded = true;
}

export async function ensureSTTReady(): Promise<void> {
  await initSDK();
  const models = ModelManager.getModels();
  const stt = models.find((m) => m.id === "sherpa-onnx-whisper-tiny.en");

  if (!stt || (stt.status !== "downloaded" && stt.status !== "loaded")) {
    updateAIState({ sttStatus: "downloading" });
    await ModelManager.downloadModel("sherpa-onnx-whisper-tiny.en");
    updateAIState({ sttStatus: "downloaded", sttProgress: 100 });
  }

  const loaded = ModelManager.getLoadedModel(ModelCategory.SpeechRecognition);
  if (!loaded || loaded.id !== "sherpa-onnx-whisper-tiny.en") {
    updateAIState({ sttStatus: "loading" });
    await ModelManager.loadModel("sherpa-onnx-whisper-tiny.en", { coexist: true });
    updateAIState({ sttStatus: "loaded" });
  }
}

export async function ensureTTSReady(): Promise<void> {
  await initSDK();
  const models = ModelManager.getModels();
  const tts = models.find((m) => m.id === "vits-piper-en_US-lessac-medium");

  if (!tts || (tts.status !== "downloaded" && tts.status !== "loaded")) {
    updateAIState({ ttsStatus: "downloading" });
    await ModelManager.downloadModel("vits-piper-en_US-lessac-medium");
    updateAIState({ ttsStatus: "downloaded", ttsProgress: 100 });
  }

  const loaded = ModelManager.getLoadedModel(ModelCategory.SpeechSynthesis);
  if (!loaded || loaded.id !== "vits-piper-en_US-lessac-medium") {
    updateAIState({ ttsStatus: "loading" });
    await ModelManager.loadModel("vits-piper-en_US-lessac-medium", { coexist: true });
    updateAIState({ ttsStatus: "loaded" });
  }
}

// ── LLM Inference ────────────────────────────────────────────────

export interface LLMStreamCallbacks {
  onToken?: (token: string, fullText: string) => void;
  onComplete?: (text: string, metrics: { tokensPerSecond: number; latencyMs: number; tokensUsed: number }) => void;
  onError?: (error: Error) => void;
}

export async function generateWithLLM(
  prompt: string,
  options?: { maxTokens?: number; temperature?: number; systemPrompt?: string },
  callbacks?: LLMStreamCallbacks
): Promise<string> {
  await ensureLLMReady();

  const fullPrompt = options?.systemPrompt
    ? `${options.systemPrompt}\nQ: ${prompt}\nA:`
    : prompt;

  try {
    const { stream, result: resultPromise } = await TextGeneration.generateStream(
      fullPrompt,
      {
        maxTokens: options?.maxTokens ?? 30,
        temperature: options?.temperature ?? 0.0,
        topP: 0.5,
      }
    );

    let fullText = "";
    let sentenceCount = 0;
    const maxSentences = 2; // Stop after 2 complete sentences for speed

    for await (const token of stream) {
      fullText += token;
      callbacks?.onToken?.(token, fullText);

      // Early stop: count sentence-ending punctuation in the accumulated text
      // This saves seconds at ~2 tok/s by not generating unnecessary tokens
      const trimmed = fullText.trim();
      if (trimmed.length > 10) {
        sentenceCount = (trimmed.match(/[.!?](?:\s|$)/g) || []).length;
        if (sentenceCount >= maxSentences) {
          break;
        }
      }
    }

    // Clean up: trim any trailing incomplete fragment after early stop
    const cleaned = fullText.trim().replace(/\s+\S*$/, (match) => {
      // Keep the match if it ends with sentence punctuation, otherwise trim it
      return /[.!?]$/.test(match.trim()) ? match : '';
    }).trim();

    const metrics = await resultPromise;
    callbacks?.onComplete?.(cleaned || fullText.trim(), {
      tokensPerSecond: metrics.tokensPerSecond,
      latencyMs: metrics.latencyMs,
      tokensUsed: metrics.tokensUsed,
    });

    return cleaned || fullText.trim();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    callbacks?.onError?.(error);
    throw error;
  }
}

// ── VAD (Voice Activity Detection) ───────────────────────────────

export async function ensureVADReady(): Promise<void> {
  await initSDK();
  const models = ModelManager.getModels();
  const vad = models.find((m) => m.id === "silero-vad-v5");

  if (!vad || (vad.status !== "downloaded" && vad.status !== "loaded")) {
    updateAIState({ vadStatus: "downloading" });
    await ModelManager.downloadModel("silero-vad-v5");
    updateAIState({ vadStatus: "downloaded", vadProgress: 100 });
  }

  const loaded = ModelManager.getLoadedModel(ModelCategory.Audio);
  if (!loaded || loaded.id !== "silero-vad-v5") {
    updateAIState({ vadStatus: "loading" });
    await ModelManager.loadModel("silero-vad-v5", { coexist: true });
    updateAIState({ vadStatus: "loaded" });
  }
}

// ── Voice Pipeline (STT → LLM → TTS) ────────────────────────────

export async function ensureVoicePipelineReady(): Promise<void> {
  await Promise.all([
    ensureVADReady(),
    ensureSTTReady(),
    ensureLLMReady(),
    ensureTTSReady(),
  ]);
}

// ── Tool Calling (Forensic Tools) ────────────────────────────────

let _toolsRegistered = false;

export function registerForensicTools(getForensicData: () => {
  authenticityScore?: number;
  forgeryRisk?: string;
  aiConfidence?: number;
  hotspotCount?: number;
  detectionCount?: number;
  entropy?: number;
  noiseLevel?: number;
  sha256?: string;
  pHash?: string;
  blockchainStatus?: string;
  verdict?: string;
  summary?: string;
  changes?: string;
}): void {
  if (_toolsRegistered) return;
  _toolsRegistered = true;

  ToolCalling.clearTools();

  ToolCalling.registerTool(
    {
      name: "get_forensic_report",
      description: "Gets the current document's tamper analysis: verdict, plain-language summary, what was changed, integrity score and risk",
      parameters: [],
      category: "Forensics",
    },
    async (): Promise<Record<string, ToolValue>> => {
      const data = getForensicData();
      return {
        authenticity_score: toToolValue(data.authenticityScore ?? 0),
        forgery_risk: toToolValue(data.forgeryRisk ?? "unknown"),
        ai_confidence: toToolValue(data.aiConfidence ?? 0),
        hotspot_count: toToolValue(data.hotspotCount ?? 0),
        detection_count: toToolValue(data.detectionCount ?? 0),
        entropy: toToolValue(data.entropy ?? 0),
        noise_level: toToolValue(data.noiseLevel ?? 0),
        verdict: toToolValue(data.verdict ?? "not analysed yet"),
        summary: toToolValue(data.summary ?? ""),
        what_changed: toToolValue(data.changes || "nothing found"),
      };
    }
  );

  ToolCalling.registerTool(
    {
      name: "get_hash_fingerprint",
      description: "Gets the cryptographic hash fingerprints (SHA-256, pHash) for the current document",
      parameters: [],
      category: "Cryptography",
    },
    async (): Promise<Record<string, ToolValue>> => {
      const data = getForensicData();
      return {
        sha256: toToolValue(data.sha256 ?? "not yet computed"),
        perceptual_hash: toToolValue(data.pHash ?? "not yet computed"),
      };
    }
  );

  ToolCalling.registerTool(
    {
      name: "get_blockchain_status",
      description: "Gets the blockchain proof status for the current document",
      parameters: [],
      category: "Blockchain",
    },
    async (): Promise<Record<string, ToolValue>> => {
      const data = getForensicData();
      return {
        status: toToolValue(data.blockchainStatus ?? "not yet minted"),
      };
    }
  );
}

export async function generateWithTools(
  prompt: string,
  options?: { maxTokens?: number; temperature?: number; systemPrompt?: string }
): Promise<{ text: string; toolCalls: { toolName: string }[] }> {
  await ensureLLMReady();

  const result = await ToolCalling.generateWithTools(prompt, {
    autoExecute: true,
    maxToolCalls: 2,
    temperature: options?.temperature ?? 0.0,
    maxTokens: options?.maxTokens ?? 30,
    systemPrompt: options?.systemPrompt,
    format: ToolCallFormat.Default,
  });

  return { text: result.text, toolCalls: result.toolCalls.map((tc) => ({ toolName: tc.toolName })) };
}

export function cleanupTools(): void {
  ToolCalling.clearTools();
  _toolsRegistered = false;
}

// ── Structured Output ────────────────────────────────────────────

export async function generateStructuredOutput<T>(
  prompt: string,
  jsonSchema: string,
  options?: { maxTokens?: number; temperature?: number }
): Promise<{ parsed: T | null; raw: string; isValid: boolean }> {
  await ensureLLMReady();

  const systemPrompt = StructuredOutput.getSystemPrompt(jsonSchema);
  const { stream, result: resultPromise } = await TextGeneration.generateStream(
    `${systemPrompt}\nQ: ${prompt}\nA:`,
    { maxTokens: options?.maxTokens ?? 60, temperature: options?.temperature ?? 0.0 }
  );

  let raw = "";
  for await (const token of stream) {
    raw += token;
  }
  await resultPromise;

  const validation = StructuredOutput.validate(raw, { jsonSchema });
  if (validation.isValid && validation.extractedJson) {
    try {
      return { parsed: JSON.parse(validation.extractedJson) as T, raw, isValid: true };
    } catch {
      return { parsed: null, raw, isValid: false };
    }
  }
  return { parsed: null, raw, isValid: false };
}

// ── TTS ──────────────────────────────────────────────────────────

let _playback: AudioPlayback | null = null;

export async function speakText(text: string): Promise<void> {
  try {
    await ensureTTSReady();
    const result = await TTS.synthesize(text, { speed: 1.2 });
    if (result.audioData && result.audioData.length > 0) {
      if (!_playback) _playback = new AudioPlayback({ sampleRate: TTS.sampleRate || 22050 });
      await _playback.play(result.audioData, TTS.sampleRate || 22050);
      return;
    }
  } catch {
    // Fall through to Web Speech API
  }
  // Fallback to Web Speech API
  const synth = window.speechSynthesis;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.0;
  synth.speak(utterance);
}

export function stopSpeaking(): void {
  _playback?.stop();
  window.speechSynthesis?.cancel();
}

// ── Re-exports ───────────────────────────────────────────────────

export {
  RunAnywhere,
  ModelManager,
  ModelCategory,
  EventBus,
  TextGeneration,
  LlamaCPP,
  ONNX,
  STT,
  TTS,
  VAD,
  SpeechActivity,
  VoicePipeline,
  AudioCapture,
  AudioPlayback,
  ToolCalling,
  ToolCallFormat,
  StructuredOutput,
  toToolValue,
  getStringArg,
};
