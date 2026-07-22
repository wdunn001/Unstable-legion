/**
 * `SpeechWorkerClient.warmup()` unit tests — the id-correlated
 * ready/progress/error protocol added so `ready` (in
 * `@unstable-legion/react`'s `useSpeechHost`/`useMoonshineTranscriber`)
 * can mean "model loaded" instead of "worker constructed" (see
 * `worker.ts`'s module doc). Driven against a FAKE `Worker` — no real
 * transformers.js/onnxruntime-web involved (browser-only, same scope note
 * as `moonshineEngine.test.ts`); this locks down `SpeechWorkerClient`'s
 * OWN bookkeeping (which `engine` kind gets posted, that `progress`
 * doesn't resolve early, that `warmup` and `transcribe` ids never
 * collide), not the engine itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechWorkerClient } from '../src/workerClient.ts';
import type { SpeechWorkerRequest, SpeechWorkerResponse } from '../src/worker.ts';

/** A minimal `Worker` double: `postMessage` just records what was sent
 * (simulating "main thread -> worker"); `reply` dispatches a `message`
 * event on this SAME object (simulating "worker -> main" arriving back on
 * the `Worker` handle the client listens on). */
class FakeWorker extends EventTarget {
  readonly posted: SpeechWorkerRequest[] = [];
  terminated = false;
  postMessage(msg: SpeechWorkerRequest): void {
    this.posted.push(msg);
  }
  reply(msg: SpeechWorkerResponse): void {
    this.dispatchEvent(new MessageEvent('message', { data: msg }));
  }
  terminate(): void {
    this.terminated = true;
  }
}

test('warmup: posts a warmup request carrying this client\'s engine kind', () => {
  const worker = new FakeWorker();
  const client = new SpeechWorkerClient(worker as unknown as Worker, { engine: 'moonshine' });
  void client.warmup();
  assert.equal(worker.posted.length, 1);
  assert.deepEqual(worker.posted[0], { type: 'warmup', id: 1, engine: 'moonshine' });
});

test('warmup: defaults to the whisper engine when none is configured', () => {
  const worker = new FakeWorker();
  const client = new SpeechWorkerClient(worker as unknown as Worker);
  void client.warmup();
  assert.equal(worker.posted[0]?.type, 'warmup');
  assert.equal((worker.posted[0] as { engine?: string }).engine, 'whisper');
});

test('warmup: resolves once the worker replies ready for the matching id', async () => {
  const worker = new FakeWorker();
  const client = new SpeechWorkerClient(worker as unknown as Worker);
  const p = client.warmup();
  worker.reply({ type: 'ready', id: 1, engine: 'whisper-base/wasm' });
  await assert.doesNotReject(p);
});

test('warmup: rejects on an error response for the matching id', async () => {
  const worker = new FakeWorker();
  const client = new SpeechWorkerClient(worker as unknown as Worker);
  const p = client.warmup();
  worker.reply({ type: 'error', id: 1, message: 'model fetch failed' });
  await assert.rejects(p, /model fetch failed/);
});

test('warmup: forwards progress messages without resolving, then resolves on ready', async () => {
  const worker = new FakeWorker();
  const client = new SpeechWorkerClient(worker as unknown as Worker);
  const progressEvents: Array<{ status?: string; progress?: number }> = [];
  let resolved = false;
  const p = client.warmup((info) => progressEvents.push(info)).then(() => {
    resolved = true;
  });

  worker.reply({ type: 'progress', id: 1, status: 'initiate', file: 'onnx/model.onnx' });
  worker.reply({ type: 'progress', id: 1, status: 'progress', file: 'onnx/model.onnx', progress: 42, loaded: 420, total: 1000 });
  await Promise.resolve();
  assert.equal(resolved, false, 'progress alone must not resolve warmup');
  assert.deepEqual(
    progressEvents.map((e) => e.status),
    ['initiate', 'progress'],
  );
  assert.equal(progressEvents[1]?.progress, 42);

  worker.reply({ type: 'ready', id: 1, engine: 'whisper-base/wasm' });
  await p;
  assert.equal(resolved, true);
});

test('warmup and transcribe use independent ids and do not collide', async () => {
  const worker = new FakeWorker();
  const client = new SpeechWorkerClient(worker as unknown as Worker);
  const warmupP = client.warmup();
  // A second in-flight request (any kind) increments nextId — assert the
  // warmup got id 1 and nothing else was posted behind its back yet.
  assert.equal(worker.posted.length, 1);
  assert.equal(worker.posted[0]?.id, 1);
  worker.reply({ type: 'ready', id: 1, engine: 'whisper-base/wasm' });
  await warmupP;
});

test('dispose: rejects an in-flight warmup', async () => {
  const worker = new FakeWorker();
  const client = new SpeechWorkerClient(worker as unknown as Worker);
  const p = client.warmup();
  client.dispose();
  await assert.rejects(p, /disposed/);
  assert.equal(worker.terminated, true);
});
