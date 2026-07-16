/**
 * meshResilience unit tests — the pure backoff/dedup/error-copy/telemetry
 * helpers the communal hooks use. No React rendering needed (that's the
 * point of keeping them pure); a mock clock/RNG drives them directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBackoffMs,
  extractHttpStatus,
  describeHostError,
  cleanReason,
  retryCountdownSec,
  claimKey,
  claimsEqual,
  emitTelemetry,
  type MeshTelemetryEvent,
} from '../src/meshResilience.ts';

// ── computeBackoffMs ─────────────────────────────────────────────────────

test('computeBackoffMs: no jitter (rand=0.5) yields the exact exponential schedule, capped', () => {
  const mid = () => 0.5; // (0.5*2-1)=0 → zero jitter
  const opts = { baseMs: 2000, capMs: 60_000, factor: 2, jitter: 0.25 };
  assert.equal(computeBackoffMs(0, opts, mid), 2000);
  assert.equal(computeBackoffMs(1, opts, mid), 4000);
  assert.equal(computeBackoffMs(2, opts, mid), 8000);
  assert.equal(computeBackoffMs(3, opts, mid), 16_000);
  assert.equal(computeBackoffMs(4, opts, mid), 32_000);
  // 64000 would exceed the cap → clamped to 60000
  assert.equal(computeBackoffMs(5, opts, mid), 60_000);
  assert.equal(computeBackoffMs(50, opts, mid), 60_000);
});

test('computeBackoffMs: jitter stays within ±jitter of the base schedule and never exceeds the cap', () => {
  const opts = { baseMs: 2000, capMs: 60_000, factor: 2, jitter: 0.25 };
  for (const r of [0, 0.25, 0.5, 0.75, 1]) {
    const v = computeBackoffMs(1, opts, () => r); // base = 4000
    assert.ok(v >= 3000 && v <= 5000, `attempt-1 jittered delay ${v} within [3000,5000]`);
  }
  // Even max jitter at the cap can't push past capMs.
  assert.ok(computeBackoffMs(10, opts, () => 1) <= 60_000);
});

test('computeBackoffMs: uses documented defaults when opts omitted', () => {
  assert.equal(computeBackoffMs(0, {}, () => 0.5), 2000);
  assert.equal(computeBackoffMs(1, {}, () => 0.5), 4000);
});

// ── extractHttpStatus ────────────────────────────────────────────────────

test('extractHttpStatus: pulls the status from real failure strings', () => {
  assert.equal(extractHttpStatus('failed to fetch shard https://x/full.gguf: 404'), 404);
  assert.equal(extractHttpStatus('server returned 503'), 503);
  assert.equal(extractHttpStatus('failed to fetch communal manifest https://x/m.json: 404 Not Found'), 404);
  // prefers the 4xx/5xx over an incidental other 3-digit number
  assert.equal(extractHttpStatus('stage worker 123 load exceeded, got 500'), 500);
});

test('extractHttpStatus: undefined when no HTTP status present', () => {
  assert.equal(extractHttpStatus('worker died silently or stalled'), undefined);
  assert.equal(extractHttpStatus('no numbers here'), undefined);
});

// ── describeHostError ────────────────────────────────────────────────────

test('describeHostError: retrying with a status + countdown', () => {
  const msg = describeHostError({ reason: 'x', layerStart: 2, layerEnd: 13, httpStatus: 404, retrying: true, nextAttemptInSec: 8 });
  assert.match(msg, /layers 2–13/);
  assert.match(msg, /server returned 404/);
  assert.match(msg, /retrying in 8s/);
});

test('describeHostError: falls back to the raw reason when there is no HTTP status', () => {
  const msg = describeHostError({ reason: 'worker crashed', layerStart: 2, layerEnd: 13, retrying: true, nextAttemptInSec: 4 });
  assert.match(msg, /worker crashed/);
  assert.match(msg, /retrying in 4s/);
});

test('describeHostError: non-retrying (given-up) phrasing signals persistent failure', () => {
  const msg = describeHostError({ reason: 'x', layerStart: 2, layerEnd: 13, httpStatus: 404, retrying: false });
  assert.match(msg, /keeps failing/);
  assert.match(msg, /still retrying periodically/);
});

test('cleanReason: takes the first line and strips a multi-line stack trace', () => {
  const raw =
    '[stage-host-2-28] legion_stage_open failed for qwen3\nError: legion_stage_open failed\n    at pt (http://x/y.js:1:14821)\n    at async Y (http://x/y.js:1:16155)';
  const cleaned = cleanReason(raw);
  assert.equal(cleaned, '[stage-host-2-28] legion_stage_open failed for qwen3');
  assert.ok(!cleaned.includes('\n'));
  assert.ok(!cleaned.includes(' at '));
});

test('cleanReason: caps very long single lines', () => {
  assert.ok(cleanReason('x'.repeat(500), 160).length <= 161);
});

test('describeHostError: a multi-line worker error is reduced to its first line', () => {
  const msg = describeHostError({
    reason: 'boom happened\nError: boom\n    at f (a.js:1:1)',
    layerStart: 2,
    layerEnd: 28,
    retrying: true,
    nextAttemptInSec: 2,
  });
  assert.ok(!msg.includes('\n at '));
  assert.match(msg, /boom happened/);
  assert.doesNotMatch(msg, /a\.js/);
});

// ── retryCountdownSec ────────────────────────────────────────────────────

test('retryCountdownSec: whole seconds until next attempt, clamped ≥ 0', () => {
  assert.equal(retryCountdownSec(10_000, 2_000), 8);
  assert.equal(retryCountdownSec(10_000, 10_000), 0);
  assert.equal(retryCountdownSec(10_000, 12_000), 0); // past → clamped
  assert.equal(retryCountdownSec(undefined, 0), undefined);
});

// ── claim dedup ──────────────────────────────────────────────────────────

test('claimKey / claimsEqual: stable, order-insensitive to includeOutput default', () => {
  assert.equal(claimKey({ layerStart: 2, layerEnd: 13 }), '2:13:0');
  assert.equal(claimKey({ layerStart: 2, layerEnd: 13, includeOutput: true }), '2:13:1');
  assert.equal(claimKey(null), 'none');
  assert.ok(claimsEqual({ layerStart: 2, layerEnd: 13 }, { layerStart: 2, layerEnd: 13, includeOutput: false }));
  assert.ok(!claimsEqual({ layerStart: 2, layerEnd: 13 }, { layerStart: 2, layerEnd: 14 }));
  assert.ok(!claimsEqual({ layerStart: 2, layerEnd: 13 }, null));
});

test('decision-change dedup: same input → same key (no repeated action), different input → new key', () => {
  // Mirrors the hook's `${reason}|${claimKey}|${yield}` dedup guard.
  const keyFor = (reason: string, claim: { layerStart: number; layerEnd: number } | null, yielded: boolean) =>
    `${reason}|${claimKey(claim)}|${yielded ? 'yield' : 'keep'}`;
  const a = keyFor('sole coverer — essential, keeping as-is', { layerStart: 2, layerEnd: 13 }, false);
  const b = keyFor('sole coverer — essential, keeping as-is', { layerStart: 2, layerEnd: 13 }, false);
  const c = keyFor('sole coverer — essential, keeping as-is', { layerStart: 2, layerEnd: 14 }, false);
  assert.equal(a, b); // identical decision → deduped (would NOT re-log)
  assert.notEqual(a, c); // range changed → new decision → would log
});

// ── telemetry event shapes + safe emit ───────────────────────────────────

test('emitTelemetry: forwards the event to the sink', () => {
  const seen: MeshTelemetryEvent[] = [];
  emitTelemetry((e) => seen.push(e), { name: 'host_load_failed', props: { modelId: 'm', layerRange: '2-13', reason: 'x', httpStatus: 404 } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, 'host_load_failed');
  assert.deepEqual(seen[0].props, { modelId: 'm', layerRange: '2-13', reason: 'x', httpStatus: 404 });
});

test('emitTelemetry: undefined sink is a no-op; a throwing sink never propagates', () => {
  assert.doesNotThrow(() => emitTelemetry(undefined, { name: 'chat_started', props: { modelId: 'm' } }));
  assert.doesNotThrow(() =>
    emitTelemetry(() => {
      throw new Error('analytics down');
    }, { name: 'chat_started', props: { modelId: 'm' } }),
  );
});
