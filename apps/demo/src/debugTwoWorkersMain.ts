/**
 * Casefile decisive test 1: two stage workers, one page, DEMO PRODUCTION
 * BUILD. See debug-two-workers.html for why this page exists.
 *
 * Constructs two DedicatedWorkers from the SAME `workers/stageWorker.ts`
 * entry point the real app uses (identical `new Worker(new URL(...), {
 * type: 'module' })` call site as StagePipelinePanel.tsx, so Vite bundles
 * it exactly the same way), and loads the SAME monolith descriptor
 * (full.gguf, layers [0,28) — this demo's stageModelSource.ts: every
 * stage, local or remote, loads the same full gguf) into both,
 * concurrently. No mesh, no Trystero, no React — isolates the wasm
 * worker + streamToMemfs path from everything else pipeline-split
 * touches.
 */
import { StageWorkerClient, STAGE_MODEL_ID, STAGE_TOTAL_LAYERS, STAGE_CTX_SIZE, stageShardUrls } from '@unstable-legion/react';

declare global {
  interface Window {
    __debugTwoWorkers?: {
      worker1: { phase: string; error?: string };
      worker2: { phase: string; error?: string };
      done: boolean;
    };
  }
}

const logEl = document.querySelector<HTMLPreElement>('#log')!;
function log(line: string): void {
  console.log(line);
  logEl.textContent += `${line}\n`;
}

const state: NonNullable<Window['__debugTwoWorkers']> = {
  worker1: { phase: 'pending' },
  worker2: { phase: 'pending' },
  done: false,
};
window.__debugTwoWorkers = state;

function makeStageWorker(): Worker {
  return new Worker(new URL('./workers/stageWorker.ts', import.meta.url), { type: 'module' });
}

async function loadOne(label: 'worker1' | 'worker2'): Promise<void> {
  state[label].phase = 'starting';
  const client = new StageWorkerClient(makeStageWorker(), label, log);
  try {
    await client.load({
      modelId: STAGE_MODEL_ID,
      layerStart: 0,
      layerEnd: STAGE_TOTAL_LAYERS,
      totalLayers: STAGE_TOTAL_LAYERS,
      shardUrls: stageShardUrls(),
      ctxSize: STAGE_CTX_SIZE,
    });
    state[label].phase = 'ready';
    log(`[${label}] READY isFirst=${client.isFirst} isFinal=${client.isFinal} nEmbd=${client.nEmbd}`);
  } catch (err) {
    state[label].phase = 'error';
    state[label].error = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    log(`[${label}] ERROR: ${state[label].error}`);
  }
}

async function run(): Promise<void> {
  // SEQUENTIAL, not concurrent — mirrors the real pipeline-split order
  // (useStagePipeline's start() `await`s the local stage-0 worker's
  // `.load()` to completion BEFORE runDriverStageSession ever sends
  // `stage.load` to a remote host, so the two full.gguf fetches never
  // overlap in the real app). A first pass ran these with Promise.all
  // and got a DIFFERENT failure (an explicit early "network error" on
  // one worker, not the casefile's silent ~320MB death) — that's the
  // demo's `vite preview` static server choking on two SIMULTANEOUS
  // 610MB fetches, a real but distinct bug from the one under
  // investigation. This sequential version is the actual decisive test.
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode') ?? 'sequential';
  log(`[debug] starting stage-worker loads… mode=${mode}`);
  if (mode === 'concurrent') {
    await Promise.all([loadOne('worker1'), loadOne('worker2')]);
  } else {
    await loadOne('worker1');
    await loadOne('worker2');
  }
  state.done = true;
  log(`[debug] DONE worker1=${state.worker1.phase} worker2=${state.worker2.phase}`);
}

void run();
