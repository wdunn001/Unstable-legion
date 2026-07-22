/**
 * moonshineWorker — thin project-local re-export of `@unstable-legion/speech`'s
 * `worker.ts` entry, same idiom as `speechWorker.ts`/`ttsWorker.ts`: Vite's
 * `new Worker(new URL('./workers/moonshineWorker.ts', import.meta.url), {type:'module'})`
 * static-analysis pattern needs its own entry file in project source so this
 * becomes ITS OWN lazy-loaded chunk, separate from `speechWorker.ts`'s.
 *
 * Functionally identical to `speechWorker.ts` — `worker.ts`'s per-request
 * `engine` field (see its module doc) is what actually picks Whisper vs.
 * Moonshine, keyed off each `SpeechWorkerClient`'s constructor `engine`
 * option. `useMoonshineTranscriber` is the caller that constructs THIS
 * worker and passes `{ engine: 'moonshine' }` to its client, so this file
 * exists purely so the two `Worker` instances (and their independent,
 * lazily-downloaded models) get separate bundler entry points instead of
 * fighting over one shared worker instance/lifecycle.
 */
import '@unstable-legion/speech/worker';
