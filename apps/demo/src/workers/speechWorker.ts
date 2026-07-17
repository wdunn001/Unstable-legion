/**
 * speechWorker — thin project-local re-export of `@unstable-legion/speech`'s
 * `worker.ts` entry.
 *
 * Same idiom as `stageWorker.ts` (re-exports `@unstable-legion/stage-runtime`
 * logic) and `llmWorker.ts` (hosts `@codecai/web-llm`): Vite's
 * `new Worker(new URL('./workers/speechWorker.ts', import.meta.url), {type:'module'})`
 * static-analysis pattern needs the entry file to live in project source,
 * not inside a workspace dependency's own package — so this file is
 * nothing but the trigger point; the real engine/decode/dispatch logic
 * (owning one transformers.js Whisper `SpeechEngine`, answering
 * `{type:'transcribe', ...}` messages) is single-sourced in
 * `packages/speech-engines/src/worker.ts`.
 */
import '@unstable-legion/speech/worker';
