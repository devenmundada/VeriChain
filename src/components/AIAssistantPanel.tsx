"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Mic,
  MicOff,
  Send,
  Bot,
  User,
  Volume2,
  VolumeX,
  Loader2,
  Sparkles,
  Zap,
  ShieldCheck,
} from "lucide-react";
import { useApp } from "../lib/AppContext";
import type { ForensicResult } from "../lib/forensicEngine";
import {
  generateWithLLM,
  speakText,
  stopSpeaking,
  ensureSTTReady,
  ensureVADReady,
  registerForensicTools,
  generateWithTools,
  cleanupTools,
  AudioCapture,
  STT,
  VAD,
  SpeechActivity,
  type LLMStreamCallbacks,
} from "../lib/runanywhere";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  metrics?: { tokensPerSecond: number; latencyMs: number };
}

// ── Instant Response Cache ──────────────────────────────────────
// Pre-written answers for common questions → 0ms latency, no LLM call needed.
// Returns null if no cached answer, meaning LLM should handle it.
function getInstantResponse(query: string, forensicResult: ForensicResult | null, hashResult: { sha256: string; pHash: string } | null, blockchainProof: { networkName: string; blockNumber: number } | null): string | null {
  const q = query.toLowerCase().trim();

  // General knowledge questions — always cached
  if (q.includes("what is on-device ai") || q.includes("on device ai") || q.includes("what's on-device")) {
    return "On-device AI runs machine learning models directly in your browser using WebAssembly — no data is sent to any server. This means 100% privacy, zero cloud costs, and it works offline.";
  }
  if (q.includes("what can you analyze") || q.includes("what do you do") || q.includes("what can you do")) {
    return "I check Aadhaar cards, marksheets and certificates for edits — without the original. I look for older versions hidden inside PDFs, text covered by white boxes, pasted digits, QR data that doesn't match the printed text, and totals that don't add up. Everything runs in your browser.";
  }
  if (q.includes("how does verification work") || q.includes("how do you verify") || q.includes("how does it work")) {
    return "With no original to compare, VeriChain uses four references: the document against itself (grain, background, digit shapes), older versions hidden inside the file, signed data printed on it (the Aadhaar QR), and its own rules (check digit, marks adding up). All checks write onto one grid, which becomes the Tamper Map.";
  }
  if (q.includes("how does hashing work") || q.includes("what is hashing") || q.includes("what is sha")) {
    return "SHA-256 creates a unique 256-bit fingerprint of your document. Any change — even a single pixel — produces a completely different hash, making tampering instantly detectable.";
  }
  if (q.includes("what is blockchain") || q.includes("how does blockchain")) {
    return "An issuer anchors the document's spatial Merkle root on Polygon. Anyone can then check a copy against it, cell by cell, without trusting our server.";
  }
  if (q.includes("is it private") || q.includes("privacy") || q.includes("is my data safe")) {
    return "100% private. All AI models run in your browser via WebAssembly. Your documents never leave your device — zero network calls, zero cloud storage.";
  }

  // Dynamic answers based on the Tamper Map result
  if (forensicResult) {
    const fr = forensicResult;
    const crit = fr.evidence.filter((e) => e.severity === "critical");
    const warn = fr.evidence.filter((e) => e.severity === "warning");
    const changes = fr.changes.map((c) => `${c.field ? c.field + ": " : ""}${c.before} → ${c.after}`).join(", ");
    if (q.includes("is this") && (q.includes("authentic") || q.includes("real") || q.includes("genuine") || q.includes("fake") || q.includes("forged"))) {
      if (fr.verdict === "NO_SIGNS") return `${fr.verdictTitle}. ${fr.summary}`;
      return `${fr.verdictTitle}. ${fr.summary}${changes ? ` Changed: ${changes}.` : ""}`;
    }
    if (q.includes("risk") || q.includes("danger") || q.includes("threat")) {
      if (!crit.length && !warn.length) return `Risk: ${fr.forgeryRisk}. No check found an edit.`;
      return `Risk: ${fr.forgeryRisk}. ${crit.length} critical, ${warn.length} warning(s): ${[...crit, ...warn].slice(0, 4).map((e) => e.title).join("; ")}.`;
    }
    if (q.includes("hotspot") || q.includes("suspicious") || q.includes("anomal") || q.includes("where") || q.includes("changed") || q.includes("what was")) {
      if (!fr.hotspots.length && !changes) return "No area of the document was flagged.";
      return `${fr.hotspots.length} area(s) flagged on the Tamper Map.${changes ? ` What changed: ${changes}.` : ""} Red boxes mark deterministic findings or places where independent checks agree.`;
    }
    if (q.includes("summar") || q.includes("finding") || q.includes("result") || q.includes("report")) {
      return `${fr.verdictTitle}. ${fr.summary} (${fr.checks.filter((c) => c.status !== "skip").length} checks ran on-device in ${(fr.analysisMs / 1000).toFixed(1)}s.)`;
    }
    if (q.includes("accuracy") || q.includes("score") || q.includes("confidence")) {
      return `Integrity score ${fr.authenticityScore}/100 (${fr.verdictTitle}). The verdict comes from deterministic checks — hidden versions, covered text, QR/check-digit and arithmetic — plus pixel checks that only count when two of them agree.`;
    }
  }

  if (hashResult) {
    if (q.includes("hash") || q.includes("fingerprint")) {
      return `SHA-256: ${hashResult.sha256.slice(0, 24)}... | Perceptual hash: ${hashResult.pHash.slice(0, 24)}... These fingerprints uniquely identify your document.`;
    }
  }

  if (blockchainProof) {
    if (q.includes("blockchain") || q.includes("proof") || q.includes("mint")) {
      return `Blockchain proof recorded on ${blockchainProof.networkName}, block #${blockchainProof.blockNumber}. This creates a permanent, verifiable record of the document's authenticity.`;
    }
  }

  // No cache hit — fall through to LLM
  return null;
}

export default function AIAssistantPanel() {
  const { state, aiState } = useApp();
  const stateRef = useRef(state);
  stateRef.current = state;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [vadActive, setVadActive] = useState(false);
  const [useToolCalling, setUseToolCalling] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const audioCaptureRef = useRef<AudioCapture | null>(null);
  const vadUnsubRef = useRef<(() => void) | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  // Add welcome message on first render
  useEffect(() => {
    setMessages([
      {
        id: "welcome",
        role: "system",
        content:
          "On-Device AI Assistant ready. Ask me about document authenticity, forensic findings, or verification results. All processing happens locally in your browser — zero cloud calls.",
        timestamp: Date.now(),
      },
    ]);

    // Register forensic tools for tool calling
    // read through a ref — the state captured at mount would never change
    registerForensicTools(() => {
      const st = stateRef.current;
      return {
        authenticityScore: st.forensicResult?.authenticityScore,
        forgeryRisk: st.forensicResult?.forgeryRisk,
        aiConfidence: st.forensicResult?.aiConfidence,
        hotspotCount: st.forensicResult?.hotspots.length,
        detectionCount: st.forensicResult?.detections.length,
        entropy: st.forensicResult?.pixelStats.entropy,
        noiseLevel: st.forensicResult?.pixelStats.noiseLevel,
        sha256: st.hashResult?.sha256,
        pHash: st.hashResult?.pHash,
        blockchainStatus: st.blockchainProof ? (st.blockchainProof.explorerUrl ? "anchored on Polygon Amoy" : "local proof only") : "pending",
        verdict: st.forensicResult?.verdictTitle,
        summary: st.forensicResult?.summary,
        changes: st.forensicResult?.changes.map((c) => `${c.before} -> ${c.after}`).join(", "),
      };
    });

    return () => {
      cleanupTools();
      vadUnsubRef.current?.();
      audioCaptureRef.current?.stop();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Build context from current forensic state (ultra-minimal to reduce input tokens and latency)
  const buildContext = useCallback((): string => {
    if (state.forensicResult) {
      const fr = state.forensicResult;
      const ch = fr.changes.slice(0, 3).map((c) => `${c.before} was changed to ${c.after}`).join("; ");
      return `You help people verify documents. Verdict for this ${fr.docType === "unknown" ? "document" : fr.docType}: ${fr.verdictTitle}.${ch ? ` Changes found: ${ch}.` : ""} Answer in 1-2 short, plain sentences. Do not invent facts.`;
    }
    return "Doc verification AI. 1 sentence max.";
  }, [state]);

  // Send a message to the on-device LLM
  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || isGenerating) return;

      const userMsg: Message = {
        id: `user-${Date.now()}`,
        role: "user",
        content: text.trim(),
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, userMsg]);
      setInput("");

      // ── Check instant cache first (0ms latency) ──
      const cachedResponse = getInstantResponse(
        text,
        state.forensicResult,
        state.hashResult,
        state.blockchainProof
      );
      if (cachedResponse) {
        // Simulate brief typing delay for natural feel, then show answer instantly
        setIsGenerating(true);
        setStreamingText("");
        await new Promise(r => setTimeout(r, 150));
        const assistantMsg: Message = {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: cachedResponse,
          timestamp: Date.now(),
          // instant answer from the analysis result — no LLM ran, so no speed metrics to show
        };
        setMessages((prev) => [...prev, assistantMsg]);
        setIsGenerating(false);

        if (autoSpeak && cachedResponse.length > 0) {
          speakText(cachedResponse);
          setIsSpeaking(true);
          setTimeout(() => setIsSpeaking(false), cachedResponse.length * 60);
        }
        return;
      }

      // ── No cache hit — use on-device LLM ──
      setIsGenerating(true);
      setStreamingText("");

      try {
        const systemPrompt = buildContext();
        let finalText = "";

        // If tool calling mode is on AND we have forensic data, use tool-augmented generation (single call, not two)
        if (useToolCalling && state.forensicResult) {
          try {
            const toolResult = await generateWithTools(text, {
              systemPrompt: "Forensic AI. Call get_forensic_report with no arguments, then answer in 1 sentence.",
              // short on purpose: the LLM runs on the main thread, long tool loops freeze the page
              maxTokens: 48,
              temperature: 0.0,
            });
            finalText = toolResult.text;
            // A tiny model sometimes leaves a half-written tool call in its text. Never show raw markup:
            // answer from the tool's own data instead.
            if (/<tool_call>|"tool"\s*:/.test(finalText) || !finalText.trim()) {
              const fr = state.forensicResult;
              const tried = /get_forensic_report/.test(finalText) || toolResult.toolCalls.some((tc) => tc.toolName === "get_forensic_report");
              finalText = fr
                ? `${tried ? "get_forensic_report → " : ""}${fr.verdictTitle}. ${fr.summary}`
                : "No document has been analysed yet.";
            }
            const assistantMsg: Message = {
              id: `assistant-${Date.now()}`,
              role: "assistant",
              content: finalText,
              timestamp: Date.now(),
            };
            setMessages((prev) => [...prev, assistantMsg]);
            setIsGenerating(false);

            if (toolResult.toolCalls.length > 0) {
              setMessages((prev) => [
                ...prev,
                {
                  id: `tool-${Date.now()}`,
                  role: "system",
                  content: `Tool calls: ${toolResult.toolCalls.map((tc) => tc.toolName).join(", ")}`,
                  timestamp: Date.now(),
                },
              ]);
            }

            if (autoSpeak && finalText.length > 0) {
              speakText(finalText);
              setIsSpeaking(true);
              setTimeout(() => setIsSpeaking(false), finalText.length * 60);
            }
            return;
          } catch (err) {
            // Fall through to regular generation (the answer still uses the analysis result as context)
            console.warn("[VeriChain] tool-calling generation failed, using plain generation:", err);
          }
        }

        const callbacks: LLMStreamCallbacks = {
          onToken: (_token, fullText) => {
            setStreamingText(fullText);
          },
          onComplete: (text, metrics) => {
            finalText = text;
            const assistantMsg: Message = {
              id: `assistant-${Date.now()}`,
              role: "assistant",
              content: text,
              timestamp: Date.now(),
              metrics,
            };
            setMessages((prev) => [...prev, assistantMsg]);
            setStreamingText("");
            setIsGenerating(false);

            if (autoSpeak && text.length > 0) {
              speakText(text);
              setIsSpeaking(true);
              setTimeout(() => setIsSpeaking(false), text.length * 60);
            }
          },
          onError: (error) => {
            const errorMsg: Message = {
              id: `error-${Date.now()}`,
              role: "system",
              content: `AI Error: ${error.message}. The LLM model may still be downloading.`,
              timestamp: Date.now(),
            };
            setMessages((prev) => [...prev, errorMsg]);
            setStreamingText("");
            setIsGenerating(false);
          },
        };

        await generateWithLLM(text, { systemPrompt, maxTokens: 50, temperature: 0.0 }, callbacks);

        // If callbacks didn't fire (no streaming), use the return value
        if (!finalText) {
          // generateWithLLM returns the text directly too
        }
      } catch {
        if (!isGenerating) return; // Already handled by callback
        setIsGenerating(false);
        setStreamingText("");
        setMessages((prev) => [
          ...prev,
          {
            id: `error-${Date.now()}`,
            role: "system",
            content: "Failed to generate response. Please ensure the LLM model is downloaded.",
            timestamp: Date.now(),
          },
        ]);
      }
    },
    [isGenerating, buildContext, autoSpeak]
  );

  // Voice input via RunAnywhere STT + VAD for smart detection
  const toggleListening = useCallback(async () => {
    if (isListening) {
      // Stop recording
      const capture = audioCaptureRef.current;
      vadUnsubRef.current?.();
      vadUnsubRef.current = null;

      if (capture) {
        capture.stop();
        const audioBuffer = capture.getAudioBuffer();

        if (audioBuffer.length > 0) {
          try {
            await ensureSTTReady();
            const result = await STT.transcribe(audioBuffer);
            if (result.text.trim()) {
              setInput(result.text.trim());
              sendMessage(result.text.trim());
            }
          } catch (err) {
            console.warn("STT transcription failed:", err);
            setMessages((prev) => [
              ...prev,
              {
                id: `stt-error-${Date.now()}`,
                role: "system",
                content: "Voice transcription failed. The STT model may still be downloading.",
                timestamp: Date.now(),
              },
            ]);
          }
        }
        audioCaptureRef.current = null;
      }
      setIsListening(false);
      setVadActive(false);
      setMicLevel(0);
      return;
    }

    // Start recording with VAD
    try {
      await ensureVADReady();
      VAD.reset();

      const capture = new AudioCapture({ sampleRate: 16000, chunkSize: 1600 });
      audioCaptureRef.current = capture;

      // Subscribe to VAD speech events
      vadUnsubRef.current = VAD.onSpeechActivity((activity) => {
        if (activity === SpeechActivity.Started || activity === SpeechActivity.Ongoing) {
          setVadActive(true);
        } else if (activity === SpeechActivity.Ended) {
          setVadActive(false);
          // Auto-stop on speech end for hands-free experience
          const segment = VAD.popSpeechSegment();
          if (segment && segment.samples.length > 1600) {
            // We have a valid speech segment — transcribe it
            capture.stop();
            vadUnsubRef.current?.();
            setIsListening(false);
            setMicLevel(0);

            (async () => {
              try {
                await ensureSTTReady();
                const result = await STT.transcribe(segment.samples);
                if (result.text.trim()) {
                  sendMessage(result.text.trim());
                }
              } catch (err) {
                console.warn("VAD+STT transcription failed:", err);
              }
            })();
          }
        }
      });

      await capture.start(
        (chunk) => {
          // Feed audio chunks to VAD for activity detection
          VAD.processSamples(chunk);
        },
        (level) => setMicLevel(level)
      );
      setIsListening(true);
    } catch (err) {
      console.warn("Microphone/VAD access failed:", err);
      // Fallback: try without VAD
      try {
        const capture = new AudioCapture({ sampleRate: 16000, chunkSize: 1600 });
        audioCaptureRef.current = capture;
        await capture.start(undefined, (level) => setMicLevel(level));
        setIsListening(true);
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            id: `mic-error-${Date.now()}`,
            role: "system",
            content: "Microphone access denied. Please allow microphone permissions.",
            timestamp: Date.now(),
          },
        ]);
      }
    }
  }, [isListening, sendMessage]);

  // Toggle TTS playback
  const toggleSpeaking = useCallback(() => {
    if (isSpeaking) {
      stopSpeaking();
      setIsSpeaking(false);
    } else {
      // Speak the last assistant message
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      if (lastAssistant) {
        speakText(lastAssistant.content);
        setIsSpeaking(true);
        setTimeout(() => setIsSpeaking(false), lastAssistant.content.length * 60);
      }
    }
  }, [isSpeaking, messages]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  // Suggested questions
  const suggestions = state.forensicResult
    ? [
        "Is this document authentic?",
        "Explain the risk factors",
        "What are the hotspots?",
        "Summarize the findings",
      ]
    : ["What can you analyze?", "How does verification work?", "What is on-device AI?"];

  return (
    <div className="glass-card flex flex-col h-[400px]">
      {/* Header */}
      <div className="p-3 border-b border-[#1E1E22] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-[#9B59B6]/15 border border-[#9B59B6]/30 flex items-center justify-center">
            <Bot className="w-3.5 h-3.5 text-[#9B59B6]" />
          </div>
          <div>
            <h3 className="text-[11px] font-mono font-bold text-zinc-300">AI ASSISTANT</h3>
            <div className="text-[8px] font-mono text-zinc-600 flex items-center gap-1">
              <ShieldCheck className="w-2.5 h-2.5" />
              100% on-device via RunAnywhere
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Tool calling toggle */}
          <button
            onClick={() => setUseToolCalling(!useToolCalling)}
            className={`text-[8px] font-mono px-1.5 py-0.5 rounded transition-colors ${
              useToolCalling ? "bg-[#00BFFF]/10 text-[#00BFFF] border border-[#00BFFF]/30" : "bg-zinc-800 text-zinc-600 border border-transparent"
            }`}
            title={useToolCalling ? "Tool calling ON" : "Tool calling OFF"}
          >
            🔧 TOOLS
          </button>
          {/* Auto-speak toggle */}
          <button
            onClick={() => setAutoSpeak(!autoSpeak)}
            className={`p-1 rounded transition-colors ${
              autoSpeak ? "bg-[#39FF14]/10 text-[#39FF14]" : "text-zinc-600 hover:text-zinc-400"
            }`}
            title={autoSpeak ? "Auto-speak ON" : "Auto-speak OFF"}
          >
            {autoSpeak ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
          </button>
          {/* Speaking toggle */}
          {isSpeaking && (
            <button
              onClick={toggleSpeaking}
              className="p-1 rounded bg-[#FF3131]/10 text-[#FF3131]"
              title="Stop speaking"
            >
              <VolumeX className="w-3.5 h-3.5" />
            </button>
          )}
          {/* LLM status badge */}
          <span
            className={`text-[8px] font-mono px-1.5 py-0.5 rounded ${
              aiState.llmStatus === "loaded"
                ? "bg-[#39FF14]/10 text-[#39FF14]"
                : aiState.llmStatus === "downloading" || aiState.llmStatus === "loading"
                ? "bg-[#FFB800]/10 text-[#FFB800]"
                : "bg-zinc-800 text-zinc-500"
            }`}
          >
            {aiState.llmStatus === "loaded" ? "LLM ACTIVE" : aiState.llmStatus.toUpperCase()}
          </span>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-thin">
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* Streaming indicator */}
        {isGenerating && streamingText && (
          <div className="flex gap-2">
            <div className="w-5 h-5 rounded-full bg-[#9B59B6]/15 flex items-center justify-center shrink-0 mt-0.5">
              <Bot className="w-3 h-3 text-[#9B59B6]" />
            </div>
            <div className="bg-[#0D0D0F] border border-[#1E1E22] rounded-lg rounded-tl-none p-2 max-w-[85%]">
              <p className="text-[11px] font-mono text-zinc-300 leading-relaxed whitespace-pre-wrap">
                {streamingText}
                <span className="inline-block w-1.5 h-3 bg-[#9B59B6] ml-0.5 animate-pulse" />
              </p>
            </div>
          </div>
        )}

        {isGenerating && !streamingText && (
          <div className="flex gap-2 items-center">
            <div className="w-5 h-5 rounded-full bg-[#9B59B6]/15 flex items-center justify-center shrink-0">
              <Loader2 className="w-3 h-3 text-[#9B59B6] animate-spin" />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono text-zinc-500">Generating on-device</span>
              <motion.div className="flex gap-0.5">
                {[0, 1, 2].map((i) => (
                  <motion.div
                    key={i}
                    className="w-1 h-1 rounded-full bg-[#9B59B6]"
                    animate={{ opacity: [0.3, 1, 0.3] }}
                    transition={{ duration: 0.8, delay: i * 0.2, repeat: Infinity }}
                  />
                ))}
              </motion.div>
            </div>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Suggestions */}
      {messages.length <= 1 && !isGenerating && (
        <div className="px-3 pb-2 flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s}
              onClick={() => sendMessage(s)}
              className="text-[9px] font-mono px-2 py-1 rounded-full border border-[#1E1E22] text-zinc-500 hover:text-[#9B59B6] hover:border-[#9B59B6]/30 transition-colors"
            >
              <Sparkles className="w-2.5 h-2.5 inline mr-1" />
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="p-3 border-t border-[#1E1E22] shrink-0">
        <div className="flex items-center gap-2">
          {/* Mic button with level indicator */}
          <button
            onClick={toggleListening}
            className={`relative p-2 rounded-lg border transition-all ${
              isListening
                ? vadActive
                  ? "bg-[#39FF14]/10 border-[#39FF14]/30 text-[#39FF14]"
                  : "bg-[#FF3131]/10 border-[#FF3131]/30 text-[#FF3131]"
                : "border-[#1E1E22] text-zinc-500 hover:text-zinc-300 hover:border-zinc-700"
            }`}
            title={isListening ? (vadActive ? "Speaking detected..." : "Listening (waiting for speech)...") : "Voice input (VAD-powered)"}
          >
            {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            {isListening && (
              <motion.div
                className="absolute inset-0 rounded-lg border-2 border-[#FF3131]"
                animate={{ scale: [1, 1 + micLevel * 0.3] }}
                transition={{ duration: 0.1 }}
              />
            )}
          </button>

          {/* Text input */}
          <div className="flex-1 relative">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isListening ? (vadActive ? "Speech detected..." : "Listening for speech (VAD)...") : "Ask about the document..."}
              className="w-full bg-[#0D0D0F] border border-[#1E1E22] rounded-lg px-3 py-2 text-[11px] font-mono text-zinc-300 placeholder:text-zinc-700 focus:outline-none focus:border-[#9B59B6]/50"
              disabled={isGenerating || isListening}
            />
            {isListening && (
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-0.5">
                {[0, 1, 2].map((i) => (
                  <motion.div
                    key={i}
                    className="w-0.5 bg-[#FF3131] rounded-full"
                    animate={{ height: [4, 4 + micLevel * 12, 4] }}
                    transition={{ duration: 0.3, delay: i * 0.1, repeat: Infinity }}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Send button */}
          <button
            onClick={() => sendMessage(input)}
            disabled={!input.trim() || isGenerating}
            className={`p-2 rounded-lg border transition-all ${
              input.trim() && !isGenerating
                ? "bg-[#9B59B6]/10 border-[#9B59B6]/30 text-[#9B59B6] hover:bg-[#9B59B6]/20"
                : "border-[#1E1E22] text-zinc-700"
            }`}
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  return (
    <motion.div
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={`flex gap-2 ${isUser ? "flex-row-reverse" : ""}`}
    >
      {/* Avatar */}
      <div
        className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
          isUser
            ? "bg-[#39FF14]/15 border border-[#39FF14]/30"
            : isSystem
            ? "bg-[#FFB800]/15 border border-[#FFB800]/30"
            : "bg-[#9B59B6]/15 border border-[#9B59B6]/30"
        }`}
      >
        {isUser ? (
          <User className="w-3 h-3 text-[#39FF14]" />
        ) : isSystem ? (
          <Zap className="w-3 h-3 text-[#FFB800]" />
        ) : (
          <Bot className="w-3 h-3 text-[#9B59B6]" />
        )}
      </div>

      {/* Content */}
      <div
        className={`max-w-[85%] rounded-lg p-2 ${
          isUser
            ? "bg-[#39FF14]/5 border border-[#39FF14]/10 rounded-tr-none"
            : isSystem
            ? "bg-[#FFB800]/5 border border-[#FFB800]/10 rounded-tl-none"
            : "bg-[#0D0D0F] border border-[#1E1E22] rounded-tl-none"
        }`}
      >
        <p className="text-[11px] font-mono text-zinc-300 leading-relaxed whitespace-pre-wrap">
          {message.content}
        </p>
        {message.metrics && (
          <div className="mt-1.5 pt-1.5 border-t border-[#1E1E22] flex items-center gap-3">
            <span className="text-[8px] font-mono text-[#9B59B6]">
              <Zap className="w-2.5 h-2.5 inline mr-0.5" />
              {message.metrics.tokensPerSecond.toFixed(1)} tok/s
            </span>
            <span className="text-[8px] font-mono text-zinc-600">
              {message.metrics.latencyMs.toFixed(0)}ms latency
            </span>
          </div>
        )}
      </div>
    </motion.div>
  );
}
