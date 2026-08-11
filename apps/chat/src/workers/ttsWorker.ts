/**
 * ttsWorker — thin project-local re-export of `@unstable-legion/speech`'s
 * `ttsWorker.ts` entry.
 *
 * Same idiom as `speechWorker.ts`: Vite's
 * `new Worker(new URL('./workers/ttsWorker.ts', import.meta.url), {type:'module'})`
 * static-analysis pattern needs the entry file to live in project source,
 * not inside a workspace dependency's own package — so this file is
 * nothing but the trigger point; the real engine/encode/dispatch logic
 * (owning one kokoro-js `TtsEngine`, answering `{type:'synthesize', ...}`
 * messages) is single-sourced in `packages/speech-engines/src/ttsWorker.ts`.
 * A SEPARATE worker from `speechWorker.ts` — see that file's/`useTtsHost`'s
 * doc comment for why TTS hosting has its own independent lifecycle.
 */
import '@unstable-legion/speech/tts-worker';
