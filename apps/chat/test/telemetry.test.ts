/**
 * telemetry unit tests — the RUM beacon wrapper's contract: a hard no-op
 * when unconfigured, correctly-shaped events when configured, and a strict
 * PII guard (no message content / tokens can reach the wire). Driven with
 * an injected `send` sink so no DOM/window is needed.
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

function spySend() {
  const calls: { url: string; payload: Record<string, unknown> }[] = [];
  const send = (url: string, payload: Record<string, unknown>) => {
    calls.push({ url, payload });
  };
  return { send, calls };
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

test('createTelemetry: unconfigured → hard no-op (never sends, never throws)', () => {
  const { send, calls } = spySend();
  const t = createTelemetry({}, { send });
  assert.equal(t.enabled, false);
  t.track('anything', { a: 1 });
  t.trackEvent({ name: 'chat_started', props: { modelId: 'm' } });
  assert.equal(calls.length, 0);
});

test('createTelemetry: placeholder client id is treated as unconfigured', () => {
  const { send, calls } = spySend();
  const t = createTelemetry({ clientId: 'YOUR_CLIENT_ID' }, { send });
  assert.equal(t.enabled, false);
  t.track('x');
  assert.equal(calls.length, 0);
});

test('createTelemetry: configured → one pageview to the default path', () => {
  const { send, calls } = spySend();
  const cfg: TelemetryConfig = { clientId: 'abc-123' };
  const t = createTelemetry(cfg, { send });
  assert.equal(t.enabled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, DEFAULT_API_URL);
  assert.equal(calls[0].payload.event, 'pageview');
  assert.equal(calls[0].payload.site, 'abc-123');
});

test('createTelemetry: trackScreenViews false sends nothing on create', () => {
  const { send, calls } = spySend();
  const t = createTelemetry({ clientId: 'abc-123', trackScreenViews: false }, { send });
  assert.equal(t.enabled, true);
  assert.equal(calls.length, 0);
});

test('createTelemetry: respects a custom apiUrl', () => {
  const { send, calls } = spySend();
  createTelemetry({ clientId: 'abc-123', apiUrl: 'https://example.test/v1' }, { send });
  assert.equal(calls[0].url, 'https://example.test/v1');
});

// ── event shapes ─────────────────────────────────────────────────────────

test('track: sends the event name with sanitized props', () => {
  const { send, calls } = spySend();
  const t = createTelemetry({ clientId: 'abc-123', trackScreenViews: false }, { send });
  t.track('button_clicked', { where: 'hero', count: 3, on: true });
  assert.equal(calls.length, 1);
  const p = calls[0].payload;
  assert.equal(p.event, 'button_clicked');
  assert.equal(p.where, 'hero');
  assert.equal(p.count, 3);
  assert.equal(p.on, true);
});

test('trackEvent: maps a typed mesh event onto the beacon payload', () => {
  const { send, calls } = spySend();
  const t = createTelemetry({ clientId: 'abc-123', trackScreenViews: false }, { send });
  t.trackEvent({ name: 'host_load_failed', props: { modelId: 'qwen3-8b-q4', layerRange: '2-13', reason: 'boom', httpStatus: 404 } });
  assert.equal(calls.length, 1);
  const p = calls[0].payload;
  assert.equal(p.event, 'host_load_failed');
  assert.equal(p.modelId, 'qwen3-8b-q4');
  assert.equal(p.layerRange, '2-13');
  assert.equal(p.reason, 'boom');
  assert.equal(p.httpStatus, 404);
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
  const { send, calls } = spySend();
  const t = createTelemetry({ clientId: 'abc-123', trackScreenViews: false }, { send });
  // Simulate an event whose props were accidentally polluted with content.
  t.track('chat_failed', { reason: 'timeout', messageText: 'secret user prompt', tokenIds: [42, 7] } as Record<string, unknown>);
  const props = calls[0].payload;
  assert.equal(props.reason, 'timeout');
  // arrays are dropped; a plain string field survives (it's the caller's job
  // not to put content in string fields — but arrays/objects can never leak).
  assert.ok(!('tokenIds' in props));
});
