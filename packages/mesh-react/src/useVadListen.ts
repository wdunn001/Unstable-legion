/**
 * useVadListen — hands-free "open mic": continuous Silero VAD
 * (`@ricky0123/vad-web`, onnxruntime-web under the hood) segments the
 * mic stream into utterances entirely client-side, and each utterance is
 * fed through the SAME ASR path push-to-talk already uses
 * (`useSpeechClient` — local host first, else a roster peer advertising
 * `asr.transcribe`). VAD itself is NOT a mesh capability: it decides
 * WHEN the user is speaking, nothing more, and advertises no cap/skill
 * of its own — it just produces utterance clips for the existing ASR
 * capability to transcribe, same as a `useMicCapture` clip does.
 *
 * Increment 3a of the voice-conversation layer: continuous listening +
 * drop-into-composer only. No wake word (3b) and no auto-send (3c) live
 * here — `onTranscript` just hands text to the caller.
 *
 * Asset resolution (the load-bearing gotcha, same shape as
 * `whisperEngine.ts`'s `wasmPaths` / kokoro's HF-vs-CDN mirror policy):
 * `MicVAD.new()` does NOT take a `workletURL`/`modelURL` pair — the
 * worklet bundle and Silero ONNX model are resolved as FIXED filenames
 * (`vad.worklet.bundle.min.js`, `silero_vad_legacy.onnx`) appended to a
 * single `baseAssetPath` directory, and the onnxruntime-web wasm binary
 * directory is a separate `onnxWASMBasePath`. Left unset, both default
 * to jsdelivr CDN URLs pinned to `@ricky0123/vad-web`'s own vendored
 * onnxruntime-web@1.14.0 (a private nested copy — NOT the newer
 * onnxruntime-web `@huggingface/transformers`/Whisper uses). Passing a
 * per-file `?url` import for the worklet and the model does NOT work
 * here: each would get its own bundler-hashed filename, but the library
 * always concatenates `baseAssetPath + 'vad.worklet.bundle.min.js'` /
 * `baseAssetPath + 'silero_vad_legacy.onnx'` internally — there is no
 * hook to override the filename per-asset, only the shared directory
 * prefix. So the host app (`apps/chat/vite.config.ts`) instead copies
 * the worklet + model + onnxruntime-web wasm binaries out of
 * `node_modules` into `public/vad/` at dev/build time and passes
 * `baseAssetPath: '/vad/'` + `onnxWASMBasePath: '/vad/'` in here — same
 * "self-host, don't depend on a CDN we don't control" policy the
 * Whisper/Kokoro model-source lists already follow.
 *
 * Serialization: the ASR worker/engine backing `useSpeechClient` is a
 * single instance and NOT re-entrant (same constraint `useTtsSpeaker`
 * documents for Kokoro). If utterances arrive back-to-back (fast
 * speaker, short pauses), `onSpeechEnd` fires again before the previous
 * transcribe resolves — `queueRef` chains each transcribe onto the
 * previous one's promise so they run strictly one at a time, in order,
 * never overlapping.
 *
 * Increment 3c (conversation mode + barge-in) extends this hook two ways,
 * both back-compatible additions — nothing above changes for 3a's plain
 * "listen and drop transcript" callers:
 *
 *   - `onSpeechStart` — vad-web's `onSpeechStart` fires the instant speech
 *     is detected, well before the utterance ends and gets transcribed.
 *     That's the ONLY signal fast enough for barge-in: a caller (the
 *     conversation-mode state machine in `ChatPane.tsx`) uses it to cut TTS
 *     playback the moment the user starts talking over it, without waiting
 *     for the utterance to finish.
 *
 *   - self-echo prevention (`echoCancellation`/`noiseSuppression`) —
 *     conversation mode plays the assistant's OWN reply out loud through
 *     this same device's speakers while the mic is still live, so without
 *     echo cancellation the mic re-hears the TTS audio and VAD mistakes it
 *     for the next user utterance. vad-web's own `additionalAudioConstraints`
 *     type explicitly EXCLUDES `echoCancellation`/`noiseSuppression` (along
 *     with `autoGainControl`/`channelCount`) from override — its internal
 *     `getUserMedia` call hardcodes both to `true` regardless of what's
 *     passed. To make them genuinely controllable, this hook acquires the
 *     `MediaStream` itself (with its OWN constraints) and hands it to
 *     `MicVAD.new({ stream })` instead of letting vad-web call
 *     `getUserMedia` internally — vad-web's `stream`-supplied path skips its
 *     own getUserMedia call entirely (see its `RealTimeVADOptionsWithStream`
 *     variant). One consequence: when a stream is supplied, vad-web's own
 *     `destroy()` does NOT stop its tracks (it only does that for a stream
 *     it created itself) — so this hook's cleanup stops the tracks itself,
 *     right after `vad.destroy()`, or the mic indicator would stay lit.
 */
import { useEffect, useRef, useState } from 'react';
import { encodeWav } from '@unstable-legion/speech';

import { useSpeechClient, type CallToolFn, type UseSpeechClientOptions } from './useSpeechClient.js';

/** VAD utterances come off `onSpeechEnd` as 16kHz mono Float32 PCM — see `@ricky0123/vad-web`'s docs. */
const VAD_SAMPLE_RATE = 16000;

export interface UseVadListenAssets {
  /** Directory (trailing slash) serving `vad.worklet.bundle.min.js` + `silero_vad_legacy.onnx`. Default: vad-web's own jsdelivr CDN. */
  baseAssetPath?: string;
  /** Directory (trailing slash) serving vad-web's vendored onnxruntime-web wasm binaries. Default: jsdelivr CDN pinned to onnxruntime-web@1.14.0. */
  onnxWASMBasePath?: string;
}

export interface UseVadListenOptions {
  /** Continuous listening is on/off. Toggling starts/stops the mic + VAD model. */
  enabled: boolean;
  /** `useMeshTools().callTool` — used when no local ASR host is available (same as `useSpeechClient`). */
  callTool: CallToolFn;
  /** `useSpeechHost().transcribeLocal`, when this peer hosts ASR itself. Omit = always route to a remote peer. */
  transcribeLocal?: UseSpeechClientOptions['transcribeLocal'];
  /** Called once per non-empty transcript, in utterance order. */
  onTranscript: (text: string) => void;
  /** Called the instant VAD detects the user has started speaking — BEFORE
   * the utterance ends or is transcribed. Optional/back-compatible; 3a
   * callers that only care about finished transcripts can omit it. The
   * barge-in hook: see module doc. */
  onSpeechStart?: () => void;
  /** Self-hosted asset locations — see module doc. Omit to use vad-web's CDN defaults. */
  assets?: UseVadListenAssets;
  /** Forwarded to `transcribe()`, same as the push-to-talk path. */
  language?: string;
  /** Mic constraints this hook requests via its OWN `getUserMedia` call —
   * see module doc's self-echo section for why these can't be set through
   * vad-web's own options. Default `true` for both (matches vad-web's own
   * hardcoded default), so omitting them changes nothing; conversation mode
   * passes both explicitly `true` since it's the caller that actually needs
   * the mic not to re-hear this same tab's TTS output. */
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
}

export interface UseVadListenHandle {
  /** True once the mic stream + VAD model are live and segmenting speech. */
  listening: boolean;
  /** Non-null if mic permission was denied, VAD init failed, or the last transcribe errored. */
  error: string | null;
}

export function useVadListen(opts: UseVadListenOptions): UseVadListenHandle {
  const {
    enabled,
    callTool,
    transcribeLocal,
    onTranscript,
    onSpeechStart,
    assets,
    language,
    echoCancellation = true,
    noiseSuppression = true,
  } = opts;
  const client = useSpeechClient({ callTool, transcribeLocal });
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs so the effect below (keyed only on `enabled` + asset paths) always
  // calls the LATEST client/callback without re-running VAD init on every
  // render (mirrors `useTtsSpeaker`'s pattern of not re-subscribing hooks
  // just because a callback prop's identity changed).
  const clientRef = useRef(client);
  clientRef.current = client;
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onSpeechStartRef = useRef(onSpeechStart);
  onSpeechStartRef.current = onSpeechStart;
  const languageRef = useRef(language);
  languageRef.current = language;
  const echoCancellationRef = useRef(echoCancellation);
  echoCancellationRef.current = echoCancellation;
  const noiseSuppressionRef = useRef(noiseSuppression);
  noiseSuppressionRef.current = noiseSuppression;

  // Chains each utterance's transcribe onto the previous one — see the
  // module doc's "Serialization" section. A no-op `.catch` keeps a failed
  // link from poisoning the chain for every utterance after it.
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let vad: { pause: () => void; destroy: () => void; start: () => void } | null = null;
    // Owned only when THIS hook acquired the stream itself (see module
    // doc's self-echo section) — stopped in cleanup since a caller-supplied
    // `stream` means vad-web's own `destroy()` won't stop its tracks.
    let ownedStream: MediaStream | null = null;

    void (async () => {
      try {
        console.debug('[legion-speech] vad: initializing MicVAD…');
        const { MicVAD } = await import('@ricky0123/vad-web');
        if (cancelled) return;

        // Acquired here (not left to vad-web's internal getUserMedia) so
        // echoCancellation/noiseSuppression are actually controllable — see
        // module doc's self-echo section for why vad-web's own
        // `additionalAudioConstraints` can't express this.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: echoCancellationRef.current,
            autoGainControl: true,
            noiseSuppression: noiseSuppressionRef.current,
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        ownedStream = stream;

        const instance = await MicVAD.new({
          stream,
          ...(assets?.baseAssetPath ? { baseAssetPath: assets.baseAssetPath } : {}),
          ...(assets?.onnxWASMBasePath ? { onnxWASMBasePath: assets.onnxWASMBasePath } : {}),
          onSpeechStart: () => {
            console.debug('[legion-speech] vad: speech-start');
            onSpeechStartRef.current?.();
          },
          onVADMisfire: () => {
            console.debug('[legion-speech] vad: misfire (segment too short, discarded)');
          },
          onSpeechEnd: (audio: Float32Array) => {
            console.debug(`[legion-speech] vad: speech-end (${audio.length} samples)`);
            // Chained, not fired-and-forgotten in parallel: see module doc.
            queueRef.current = queueRef.current
              .then(async () => {
                if (cancelled) return;
                const wav = encodeWav(audio, VAD_SAMPLE_RATE);
                const result = await clientRef.current.transcribe({ bytes: wav, mimeType: 'audio/wav' }, languageRef.current);
                if (cancelled) return;
                const text = result.text?.trim();
                if (!text) {
                  console.debug('[legion-speech] vad: empty transcript, dropped');
                  return;
                }
                console.debug(`[legion-speech] vad: transcript "${text.slice(0, 80)}"`);
                onTranscriptRef.current(text);
              })
              .catch((err) => {
                console.error('[legion-speech] vad: transcribe failed', err);
                if (!cancelled) setError(err instanceof Error ? err.message : String(err));
              });
          },
        });

        if (cancelled) {
          // `instance.destroy()` won't stop the tracks itself here (we
          // supplied the stream — see module doc), so stop them explicitly.
          instance.destroy();
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        vad = instance;
        instance.start();
        setListening(true);
        setError(null);
        console.debug('[legion-speech] vad: listening');
      } catch (err) {
        console.error('[legion-speech] vad: init failed (mic permission denied or model load failed)', err);
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setListening(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (vad) {
        console.debug('[legion-speech] vad: stopping, releasing mic');
        vad.pause();
        vad.destroy();
        vad = null;
      }
      // vad-web's own `destroy()` only stops tracks for a stream it created
      // itself — since this hook always supplies its own `stream` (see
      // module doc), it's always this hook's job to stop them.
      if (ownedStream) {
        ownedStream.getTracks().forEach((track) => track.stop());
        ownedStream = null;
      }
      setListening(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, assets?.baseAssetPath, assets?.onnxWASMBasePath]);

  return { listening, error };
}
