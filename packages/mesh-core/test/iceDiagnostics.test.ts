/**
 * iceDiagnostics summary unit tests — the bucket math is pure given an
 * injected `now`. Regression focus: a connection closed via pc.close()
 * dispatches NO iceconnectionstatechange, so its ICE-state history freezes
 * at 'checking'; it must still read as failed (not "connecting") via the
 * live connectionState or the staleness window. That frozen-checking leak
 * was the persistent bogus "N joining…" count.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyIceRecord,
  summarizeIceConnections,
  ICE_STALE_MS,
  ICE_NEW_GRACE_MS,
  type IceConnectionRecord,
} from '../src/iceDiagnostics.ts';

const NOW = 1_000_000;

function rec(overrides: Partial<IceConnectionRecord> & { connectionState?: string | 'GCd' }): IceConnectionRecord {
  const { connectionState, ...rest } = overrides;
  const base: IceConnectionRecord = {
    createdAt: NOW - 1000,
    lastActivityAt: NOW - 1000,
    states: [],
    errors: [],
    ...rest,
  };
  if (connectionState === 'GCd') base.pcRef = { deref: () => undefined };
  else if (connectionState !== undefined) base.pcRef = { deref: () => ({ connectionState }) };
  return base;
}

test('classifyIceRecord: live connectionState connected -> connected', () => {
  assert.equal(classifyIceRecord(rec({ connectionState: 'connected', states: [{ state: 'checking', at: NOW }] }), NOW), 'connected');
});

test('classifyIceRecord: pc.close() froze ICE at checking but connectionState is closed -> failed, NOT connecting', () => {
  const r = rec({ connectionState: 'closed', lastActivityAt: NOW - 500, states: [{ state: 'checking', at: NOW - 500 }] });
  assert.equal(classifyIceRecord(r, NOW), 'failed');
});

test('classifyIceRecord: the pc was garbage-collected -> failed (no live attempt)', () => {
  assert.equal(classifyIceRecord(rec({ connectionState: 'GCd', states: [{ state: 'checking', at: NOW }] }), NOW), 'failed');
});

test('classifyIceRecord: fresh non-terminal attempt with no live handle -> connecting', () => {
  const r = rec({ lastActivityAt: NOW - 2000, states: [{ state: 'checking', at: NOW - 2000 }] });
  assert.equal(classifyIceRecord(r, NOW), 'connecting');
});

test('classifyIceRecord: non-terminal attempt stuck past the staleness window -> failed', () => {
  const r = rec({ lastActivityAt: NOW - (ICE_STALE_MS + 1), states: [{ state: 'checking', at: NOW - (ICE_STALE_MS + 1) }] });
  assert.equal(classifyIceRecord(r, NOW), 'failed');
});

test('classifyIceRecord: terminal ICE state (failed) with no pcRef -> failed', () => {
  assert.equal(classifyIceRecord(rec({ states: [{ state: 'failed', at: NOW }] }), NOW), 'failed');
});

test('summarizeIceConnections: 20 closed-but-frozen ghosts + 1 live attempt -> connecting is 1, not 21', () => {
  const ghosts = Array.from({ length: 20 }, () =>
    rec({ connectionState: 'closed', lastActivityAt: NOW - 5000, states: [{ state: 'checking', at: NOW - 5000 }] }),
  );
  const live = rec({ lastActivityAt: NOW - 1000, states: [{ state: 'checking', at: NOW - 1000 }] });
  const s = summarizeIceConnections([...ghosts, live], NOW);
  assert.equal(s.total, 21);
  assert.equal(s.connecting, 1, 'only the genuinely in-flight attempt counts as joining');
  assert.equal(s.failed, 20);
});

// ── new-grace: an offer stuck at ICE 'new' is a ghost, not a join ───────

test('classifyIceRecord: ICE never left "new" past the grace -> failed (dead offer, no SDP answer)', () => {
  const r = rec({ createdAt: NOW - (ICE_NEW_GRACE_MS + 1), lastActivityAt: NOW - (ICE_NEW_GRACE_MS + 1), states: [{ state: 'new', at: NOW - (ICE_NEW_GRACE_MS + 1) }] });
  assert.equal(classifyIceRecord(r, NOW), 'failed');
});

test('classifyIceRecord: brand-new "new" attempt within grace -> connecting', () => {
  const r = rec({ createdAt: NOW - 1000, lastActivityAt: NOW - 1000, states: [{ state: 'new', at: NOW - 1000 }] });
  assert.equal(classifyIceRecord(r, NOW), 'connecting');
});

test('classifyIceRecord: a recent "checking" attempt is a real join -> connecting', () => {
  const r = rec({ createdAt: NOW - 20_000, lastActivityAt: NOW - 1000, states: [{ state: 'new', at: NOW - 20_000 }, { state: 'checking', at: NOW - 1000 }] });
  assert.equal(classifyIceRecord(r, NOW), 'connecting');
});

test('summarizeIceConnections: 20 ghost offers stuck at "new" past grace + 1 real peer -> connecting 0, connected 1', () => {
  const ghosts = Array.from({ length: 20 }, () =>
    rec({ createdAt: NOW - 10_000, lastActivityAt: NOW - 10_000, states: [{ state: 'new', at: NOW - 10_000 }] }),
  );
  const real = rec({ connectionState: 'connected', states: [{ state: 'connected', at: NOW - 2000 }] });
  const s = summarizeIceConnections([...ghosts, real], NOW);
  assert.equal(s.connecting, 0, 'ghost offers at "new" are not joining');
  assert.equal(s.connected, 1);
  assert.equal(s.failed, 20);
});
