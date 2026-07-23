/**
 * `TtsWorkerClient.warmup()` unit tests — mirrors
 * `workerClient.test.ts` exactly, reverse capability (Kokoro instead of
 * Whisper/Moonshine): the id-correlated ready/progress/error protocol so
 * `ready` (in `@unstable-legion/react`'s `useTtsHost`) means "model
 * loaded", not "worker constructed" (see `ttsWorker.ts`'s module doc).
 * Driven against a FAKE `Worker` — no real kokoro-js/transformers.js
 * involved (browser-only); this locks down `TtsWorkerClient`'s own
 * bookkeeping, not the engine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TtsWorkerClient } from '../src/ttsWorkerClient.ts';
import type { TtsWorkerRequest, TtsWorkerResponse } from '../src/ttsWorker.ts';

/** Mirrors `workerClient.test.ts`'s `FakeWorker` — kept as its own tiny
 * copy rather than a shared test util, same discipline this codebase's
 * own source uses (see `useMoonshineTranscriber.ts`'s base64 helper doc). */
class FakeWorker extends EventTarget {
  readonly posted: TtsWorkerRequest[] = [];
  terminated = false;
  postMessage(msg: TtsWorkerRequest): void {
    this.posted.push(msg);
  }
  reply(msg: TtsWorkerResponse): void {
    this.dispatchEvent(new MessageEvent('message', { data: msg }));
  }
  terminate(): void {
    this.terminated = true;
  }
}

test('warmup: posts a warmup request', () => {
  const worker = new FakeWorker();
  const client = new TtsWorkerClient(worker as unknown as Worker);
  void client.warmup();
  assert.deepEqual(worker.posted[0], { type: 'warmup', id: 1 });
});

test('warmup: resolves once the worker replies ready for the matching id', async () => {
  const worker = new FakeWorker();
  const client = new TtsWorkerClient(worker as unknown as Worker);
  const p = client.warmup();
  worker.reply({ type: 'ready', id: 1, engine: 'kokoro-82m/wasm' });
  await assert.doesNotReject(p);
});

test('warmup: rejects on an error response for the matching id', async () => {
  const worker = new FakeWorker();
  const client = new TtsWorkerClient(worker as unknown as Worker);
  const p = client.warmup();
  worker.reply({ type: 'error', id: 1, message: 'kokoro fetch failed' });
  await assert.rejects(p, /kokoro fetch failed/);
});

test('warmup: forwards progress messages without resolving, then resolves on ready', async () => {
  const worker = new FakeWorker();
  const client = new TtsWorkerClient(worker as unknown as Worker);
  const progressEvents: Array<{ status?: string; progress?: number }> = [];
  let resolved = false;
  const p = client.warmup((info) => progressEvents.push(info)).then(() => {
    resolved = true;
  });

  worker.reply({ type: 'progress', id: 1, status: 'download', file: 'onnx/model.onnx' });
  await Promise.resolve();
  assert.equal(resolved, false, 'progress alone must not resolve warmup');
  assert.equal(progressEvents.length, 1);
  assert.equal(progressEvents[0]?.status, 'download');

  worker.reply({ type: 'ready', id: 1, engine: 'kokoro-82m/wasm' });
  await p;
  assert.equal(resolved, true);
});

test('warmup and listVoices/synthesize use independent ids and do not collide', async () => {
  const worker = new FakeWorker();
  const client = new TtsWorkerClient(worker as unknown as Worker);
  const warmupP = client.warmup();
  const voicesP = client.listVoices();
  assert.equal(worker.posted[0]?.id, 1);
  assert.equal(worker.posted[1]?.id, 2);
  worker.reply({ type: 'ready', id: 1, engine: 'kokoro-82m/wasm' });
  worker.reply({ type: 'voices', id: 2, voices: ['af_heart'] });
  await warmupP;
  assert.deepEqual(await voicesP, ['af_heart']);
});

test('dispose: rejects an in-flight warmup', async () => {
  const worker = new FakeWorker();
  const client = new TtsWorkerClient(worker as unknown as Worker);
  const p = client.warmup();
  client.dispose();
  await assert.rejects(p, /disposed/);
  assert.equal(worker.terminated, true);
});
