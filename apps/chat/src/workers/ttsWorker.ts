/**
 * ttsWorker — thin project-local re-export of `@unstable-legion/speech`'s
 * `ttsWorker.ts` entry.
 *
 * Same idiom as `speechWorker.ts` (re-exports `@unstable-legion/speech`'s
 * `worker.ts`): Vite's
 * `new Worker(new URL('./workers/ttsWorker.ts', import.meta.url), {type:'module'})`
 * static-analysis pattern needs the entry file to live in project source,
 * not inside a workspace dependency's own package — so this file is
 * nothing but the trigger point; the real engine/synthesize/dispatch
 * logic (owning one kokoro-js `TtsEngine`, answering
 * `{type:'synthesize', ...}` / `{type:'listVoices', ...}` messages) is
 * single-sourced in `packages/speech-engines/src/ttsWorker.ts`.
 */
import '@unstable-legion/speech/ttsWorker';
