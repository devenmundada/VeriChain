"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { Mic, MicOff, Loader2, Volume2, Radio, ShieldCheck } from "lucide-react";
import {
  ensureVoicePipelineReady,
  AudioCapture,
  AudioPlayback,
  VAD,
  SpeechActivity,
  VoicePipeline,
} from "../lib/runanywhere";
import { useApp } from "../lib/AppContext";

type VoiceState = "idle" | "loading" | "listening" | "processing" | "speaking";

export default function VoicePipelinePanel() {
  const { state } = useApp();
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [transcript, setTranscript] = useState("");
  const [response, setResponse] = useState("");
  const [streamingResponse, setStreamingResponse] = useState("");
  const [audioLevel, setAudioLevel] = useState(0);
  const [turnsCount, setTurnsCount] = useState(0);

  const micRef = useRef<AudioCapture | null>(null);
  const pipelineRef = useRef<VoicePipeline | null>(null);
  const vadUnsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      micRef.current?.stop();
      vadUnsubRef.current?.();
    };
  }, []);

  const buildSystemPrompt = useCallback((): string => {
    if (state.forensicResult) {
      const fr = state.forensicResult;
      const ch = fr.changes.slice(0, 2).map((c) => `${c.before} was changed to ${c.after}`).join("; ");
      return `Voice assistant for document verification. Verdict: ${fr.verdictTitle}.${ch ? ` Changes: ${ch}.` : ""} Reply in 1 short sentence.`;
    }
    return "Voice AI. 1 sentence max.";
  }, [state.forensicResult]);

  const startListening = useCallback(async () => {
    setTranscript("");
    setResponse("");
    setStreamingResponse("");
    setVoiceState("loading");

    try {
      await ensureVoicePipelineReady();
    } catch {
      setVoiceState("idle");
      return;
    }

    setVoiceState("listening");

    const mic = new AudioCapture({ sampleRate: 16000 });
    micRef.current = mic;

    if (!pipelineRef.current) {
      pipelineRef.current = new VoicePipeline();
    }

    VAD.reset();

    vadUnsubRef.current = VAD.onSpeechActivity(async (activity) => {
      if (activity === SpeechActivity.Ended) {
        const segment = VAD.popSpeechSegment();
        if (!segment || segment.samples.length < 1600) return;

        mic.stop();
        vadUnsubRef.current?.();
        setVoiceState("processing");

        try {
          await pipelineRef.current!.processTurn(
            segment.samples,
            {
              maxTokens: 40,
              temperature: 0.0,
              systemPrompt: buildSystemPrompt(),
            },
            {
              onTranscription: (text) => setTranscript(text),
              onResponseToken: (_, acc) => setStreamingResponse(acc),
              onResponseComplete: (text) => {
                setResponse(text);
                setStreamingResponse("");
              },
              onSynthesisComplete: async (audio, sampleRate) => {
                setVoiceState("speaking");
                const player = new AudioPlayback({ sampleRate });
                await player.play(audio, sampleRate);
                player.dispose();
              },
              onStateChange: (pipelineState) => {
                if (pipelineState === "generatingResponse") setVoiceState("processing");
                if (pipelineState === "playingTTS") setVoiceState("speaking");
              },
            }
          );
        } catch (err) {
          console.error("Voice pipeline error:", err);
        }

        setTurnsCount((c) => c + 1);
        setVoiceState("idle");
        setAudioLevel(0);
      }
    });

    await mic.start(
      (chunk) => {
        VAD.processSamples(chunk);
      },
      (level) => {
        setAudioLevel(level);
      }
    );
  }, [buildSystemPrompt]);

  const stopListening = useCallback(() => {
    micRef.current?.stop();
    vadUnsubRef.current?.();
    pipelineRef.current?.cancel();
    setVoiceState("idle");
    setAudioLevel(0);
  }, []);

  const stateColors: Record<VoiceState, string> = {
    idle: "#1E1E22",
    loading: "#FFB800",
    listening: "#39FF14",
    processing: "#9B59B6",
    speaking: "#00BFFF",
  };

  const stateLabels: Record<VoiceState, string> = {
    idle: "TAP TO START",
    loading: "LOADING MODELS...",
    listening: "LISTENING — SPEAK NOW",
    processing: "PROCESSING...",
    speaking: "SPEAKING...",
  };

  return (
    <div className="glass-card p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-[#00BFFF]/15 border border-[#00BFFF]/30 flex items-center justify-center">
            <Radio className="w-3.5 h-3.5 text-[#00BFFF]" />
          </div>
          <div>
            <h3 className="text-[11px] font-mono font-bold text-zinc-300">VOICE PIPELINE</h3>
            <div className="text-[8px] font-mono text-zinc-600 flex items-center gap-1">
              <ShieldCheck className="w-2.5 h-2.5" />
              VAD → STT → LLM → TTS (all on-device)
            </div>
          </div>
        </div>
        {turnsCount > 0 && (
          <span className="text-[8px] font-mono text-zinc-600">{turnsCount} turn{turnsCount !== 1 ? "s" : ""}</span>
        )}
      </div>

      {/* Voice Orb */}
      <div className="flex flex-col items-center gap-3">
        <button
          onClick={voiceState === "idle" || voiceState === "loading" ? startListening : stopListening}
          disabled={voiceState === "loading" || voiceState === "processing" || voiceState === "speaking"}
          className="relative focus:outline-none"
        >
          <motion.div
            className="w-20 h-20 rounded-full flex items-center justify-center border-2 transition-colors"
            style={{
              backgroundColor: `${stateColors[voiceState]}15`,
              borderColor: `${stateColors[voiceState]}40`,
            }}
            animate={{
              scale: voiceState === "listening" ? [1, 1 + audioLevel * 0.3, 1] : 1,
            }}
            transition={{ duration: 0.15 }}
          >
            {voiceState === "loading" || voiceState === "processing" ? (
              <Loader2 className="w-8 h-8 animate-spin" style={{ color: stateColors[voiceState] }} />
            ) : voiceState === "listening" ? (
              <Mic className="w-8 h-8" style={{ color: stateColors[voiceState] }} />
            ) : voiceState === "speaking" ? (
              <Volume2 className="w-8 h-8" style={{ color: stateColors[voiceState] }} />
            ) : (
              <MicOff className="w-8 h-8 text-zinc-500" />
            )}
          </motion.div>

          {/* Ripple effect while listening */}
          {voiceState === "listening" && (
            <motion.div
              className="absolute inset-0 rounded-full border-2 border-[#39FF14]/30"
              animate={{ scale: [1, 1.4], opacity: [0.6, 0] }}
              transition={{ duration: 1.5, repeat: Infinity }}
            />
          )}
        </button>

        <span
          className="text-[9px] font-mono font-bold tracking-wider"
          style={{ color: stateColors[voiceState] }}
        >
          {stateLabels[voiceState]}
        </span>
      </div>

      {/* Transcript & Response */}
      <div className="mt-4 space-y-2">
        {transcript && (
          <div className="bg-[#0D0D0F] border border-[#39FF14]/10 rounded-lg p-2">
            <span className="text-[8px] font-mono text-[#39FF14] mb-1 block">YOU SAID:</span>
            <p className="text-[11px] font-mono text-zinc-300">{transcript}</p>
          </div>
        )}
        {(response || streamingResponse) && (
          <div className="bg-[#0D0D0F] border border-[#00BFFF]/10 rounded-lg p-2">
            <span className="text-[8px] font-mono text-[#00BFFF] mb-1 block">AI RESPONSE:</span>
            <p className="text-[11px] font-mono text-zinc-300">
              {response || streamingResponse}
              {streamingResponse && !response && (
                <span className="inline-block w-1.5 h-3 bg-[#00BFFF] ml-0.5 animate-pulse" />
              )}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
