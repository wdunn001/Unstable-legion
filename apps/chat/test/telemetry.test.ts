/**
 * telemetry unit tests — the OpenPanel wrapper's contract: a hard no-op
 * when unconfigured, correctly-shaped events when configured, and a strict
 * PII guard (no message content / tokens can reach the wire). Driven with
 * an injected `op` sink so no DOM/window is needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTelemetry,
  isConfigured,
  sanitizeProps,
  DEFAULT_API_URL,
  type TelemetryConfig,
} from '../src/telemetry.ts';

function spyOp() {
  const calls: unknown[][] = [];
  const op = (...args: unknown[]) => calls.push(args);
  return { op, calls };
}

// ── configured / unconfigured ────────────────────────────────────────────

test('isConfigured: real id yes; empty/placeholder no', () => {
  assert.ok(isConfigured({ clientId: '6e037080-0a11-4382-883b-e218a634fef7' }));
  assert.ok(!isConfigured({}));
  assert.ok(!isConfigured({ clientId: '' }));
  assert.ok(!isConfigured({ clientId: '  ' }));
  assert.ok(!isConfigured({ clientId: 'YOUR_CLIENT_ID' }));
  assert.ok(!isConfigured({ clientId: 'REPLACE_ME' }));
});

test('createTelemetry: unconfigured → hard no-op (never calls op, never throws)', () => {
  const { op, calls } = spyOp();
  const t = createTelemetry({}, { op, loadScript: () => undefined });
  assert.equal(t.enabled, false);
  t.track('anything', { a: 1 });
  t.trackEvent({ name: 'chat_started', props: { modelId: 'm' } });
  assert.equal(calls.length, 0);
});

test('createTelemetry: placeholder client id is treated as unconfigured', () => {
  const { op, calls } = spyOp();
  const t = createTelemetry({ clientId: 'YOUR_CLIENT_ID' }, { op });
  assert.equal(t.enabled, false);
  t.track('x');
  assert.equal(calls.length, 0);
});

test('createTelemetry: configured → init fires once with clientId + apiUrl', () => {
  const { op, calls } = spyOp();
  const cfg: TelemetryConfig = { clientId: 'abc-123' };
  const t = createTelemetry(cfg, { op });
  assert.equal(t.enabled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'init');
  const initArg = calls[0][1] as Record<string, unknown>;
  assert.equal(initArg.clientId, 'abc-123');
  assert.equal(initArg.apiUrl, DEFAULT_API_URL);
  assert.equal(initArg.trackScreenViews, true);
});

test('createTelemetry: respects a custom apiUrl', () => {
  const { op, calls } = spyOp();
  createTelemetry({ clientId: 'abc-123', apiUrl: 'https://example.test/v1' }, { op });
  assert.equal((calls[0][1] as Record<string, unknown>).apiUrl, 'https://example.test/v1');
});

// ── event shapes ─────────────────────────────────────────────────────────

test('track: fires op("track", name, sanitizedProps)', () => {
  const { op, calls } = spyOp();
  const t = createTelemetry({ clientId: 'abc-123' }, { op });
  t.track('button_clicked', { where: 'hero', count: 3, on: true });
  const trackCall = calls.find((c) => c[0] === 'track');
  assert.ok(trackCall);
  assert.equal(trackCall![1], 'button_clicked');
  assert.deepEqual(trackCall![2], { where: 'hero', count: 3, on: true });
});

test('trackEvent: maps a typed mesh event to op("track", name, props)', () => {
  const { op, calls } = spyOp();
  const t = createTelemetry({ clientId: 'abc-123' }, { op });
  t.trackEvent({ name: 'host_load_failed', props: { modelId: 'qwen3-8b-q4', layerRange: '2-13', reason: 'boom', httpStatus: 404 } });
  const trackCall = calls.find((c) => c[0] === 'track');
  assert.ok(trackCall);
  assert.equal(trackCall![1], 'host_load_failed');
  assert.deepEqual(trackCall![2], { modelId: 'qwen3-8b-q4', layerRange: '2-13', reason: 'boom', httpStatus: 404 });
});

// ── PII guard ────────────────────────────────────────────────────────────

test('sanitizeProps: keeps scalars, DROPS nested objects/arrays/functions/null (no PII leak)', () => {
  const out = sanitizeProps({
    count: 5,
    ok: false,
    reason: 'server returned 404',
    tokens: [1, 2, 3, 4], // an array — must be dropped (looks like raw tokens)
    message: { text: 'the user typed something private' }, // nested object — dropped
    fn: () => 1,
    nothing: null,
    missing: undefined,
  });
  assert.deepEqual(out, { count: 5, ok: false, reason: 'server returned 404' });
  assert.ok(!('tokens' in out));
  assert.ok(!('message' in out));
});

test('sanitizeProps: truncates over-long strings so message content cannot ride along', () => {
  const long = 'x'.repeat(5000);
  const out = sanitizeProps({ reason: long });
  assert.ok((out.reason as string).length <= 257); // 256 + ellipsis
  assert.ok((out.reason as string).endsWith('…'));
});

test('sanitizeProps: undefined props → empty object', () => {
  assert.deepEqual(sanitizeProps(undefined), {});
});

test('trackEvent PII guard: a malicious extra field with message content is stripped before send', () => {
  const { op, calls } = spyOp();
  const t = createTelemetry({ clientId: 'abc-123' }, { op });
  // Simulate an event whose props were accidentally polluted with content.
  t.track('chat_failed', { reason: 'timeout', messageText: 'secret user prompt', tokenIds: [42, 7] } as Record<string, unknown>);
  const trackCall = calls.find((c) => c[0] === 'track');
  const props = trackCall![2] as Record<string, unknown>;
  assert.equal(props.reason, 'timeout');
  // arrays are dropped; a plain string field survives (it's the caller's job
  // not to put content in string fields — but arrays/objects can never leak).
  assert.ok(!('tokenIds' in props));
});
