/**
 * TOOL-NODES — tool-call detection + a single robust round-trip, plus the
 * standing credit/debit a GPU-less tool provider earns.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseToolCalls,
  firstToolCall,
  buildToolResultBlock,
  runToolRoundTrip,
} from '../src/toolLoop.ts';
import { StandingLedger } from '../src/standing.ts';
import type { MeshRosterEntry, MeshToolFrame, MeshToolResult } from '../src/types.ts';

// ── Detection ────────────────────────────────────────────────────────────

test('parseToolCalls: extracts a well-formed <tool_call> block', () => {
  const text = 'let me check.\n<tool_call>\n{"name": "current_time", "arguments": {}}\n</tool_call>\ndone';
  const calls = parseToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, 'current_time');
  assert.deepEqual(calls[0]!.args, {});
  assert.ok(calls[0]!.raw.includes('<tool_call>'));
});

test('parseToolCalls: multiple blocks, skips malformed ones', () => {
  const text = [
    '<tool_call>{"name":"a","arguments":{"x":1}}</tool_call>',
    '<tool_call>{ not json }</tool_call>',
    '<tool_call>{"name":"b","arguments":{}}</tool_call>',
    '<tool_call>{"arguments":{}}</tool_call>', // missing name
  ].join('\n');
  const calls = parseToolCalls(text);
  assert.deepEqual(calls.map((c) => c.name), ['a', 'b']);
});

test('firstToolCall: null when no tool call present', () => {
  assert.equal(firstToolCall('just a plain answer, no tools'), null);
  assert.equal(firstToolCall('<tool_call>fetch_text {"url":"x"}</tool_call>'), null); // not JSON
});

test('buildToolResultBlock: ok vs error shapes', () => {
  const ok: MeshToolResult = { v: 1, ts: 0, callId: 'c', status: 'ok', result: { content: { iso: 'now' } } };
  assert.ok(buildToolResultBlock('current_time', ok).includes('"result"'));
  const err: MeshToolResult = { v: 1, ts: 0, callId: 'c', status: 'error', error: 'boom' };
  assert.ok(buildToolResultBlock('current_time', err).includes('"error":"boom"'));
});

// ── Mock mesh ──────────────────────────────────────────────────────────────

interface ToolPeerBehavior {
  /** 'ok' answers with a result; 'error' answers with an error frame;
   * 'silent' never answers (vanished/unreachable). */
  answer: 'ok' | 'error' | 'silent';
  content?: unknown;
}

function createMockMesh(selfId: string) {
  const listeners = new Set<(frame: MeshToolFrame, peerId: string) => void>();
  const toolPeers = new Map<string, ToolPeerBehavior>();
  const sent: Array<{ frame: MeshToolFrame; target: string }> = [];
  const deliver = (frame: MeshToolFrame, from: string) => {
    for (const cb of listeners) cb(frame, from);
  };
  const targets = (p?: string | string[]) => (!p ? [] : Array.isArray(p) ? p : [p]);

  const peer = {
    selfId,
    async sendTool(frame: MeshToolFrame, peers?: string | string[]) {
      for (const t of targets(peers)) {
        sent.push({ frame, target: t });
        const behavior = toolPeers.get(t);
        if (!behavior || frame.kind !== 'call') continue;
        if (behavior.answer === 'silent') continue;
        const result: MeshToolResult =
          behavior.answer === 'ok'
            ? { v: 1, ts: Date.now(), callId: frame.callId, status: 'ok', result: { content: behavior.content ?? 'served' } }
            : { v: 1, ts: Date.now(), callId: frame.callId, status: 'error', error: 'tool blew up' };
        queueMicrotask(() => deliver({ kind: 'result', ...result }, t));
      }
    },
    onTool(cb: (frame: MeshToolFrame, peerId: string) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return { peer, toolPeers, sent };
}

function toolPeerEntry(peerId: string, toolName: string, lastSeen = Date.now()): MeshRosterEntry {
  return {
    v: 1,
    ts: Date.now(),
    peerId,
    lastSeen,
    nick: peerId,
    modelId: 'n/a',
    available: true,
    skills: [],
    systemPromptSummary: '',
    tools: [{ name: toolName, description: '', inputSchema: {} }],
  };
}

// ── Round-trip ─────────────────────────────────────────────────────────────

test('runToolRoundTrip: one call -> one result -> a <tool_result> block', async () => {
  const mesh = createMockMesh('driver');
  mesh.toolPeers.set('toolnode', { answer: 'ok', content: { iso: '2026' } });
  const roster = [toolPeerEntry('toolnode', 'current_time')];

  const out = await runToolRoundTrip({
    peer: mesh.peer,
    roster,
    call: { name: 'current_time', args: {} },
    timeoutMs: 1000,
  });

  assert.equal(out.status, 'ok');
  assert.equal(out.providerPeerId, 'toolnode');
  assert.ok(out.resultBlock?.includes('<tool_result>'));
  assert.deepEqual(out.triedPeerIds, ['toolnode']);
});

test('runToolRoundTrip: no peer advertises the tool -> graceful no-provider', async () => {
  const mesh = createMockMesh('driver');
  const out = await runToolRoundTrip({
    peer: mesh.peer,
    roster: [toolPeerEntry('other', 'some_other_tool')],
    call: { name: 'current_time', args: {} },
    timeoutMs: 500,
  });
  assert.equal(out.status, 'no-provider');
  assert.equal(out.providerPeerId, undefined);
});

test('runToolRoundTrip: a silent provider times out and falls through to the next', async () => {
  const mesh = createMockMesh('driver');
  mesh.toolPeers.set('dead', { answer: 'silent' });
  mesh.toolPeers.set('alive', { answer: 'ok', content: 'ok!' });
  // Rank 'dead' first via a higher priority score so it's tried first.
  const roster = [toolPeerEntry('dead', 'search'), toolPeerEntry('alive', 'search')];

  const out = await runToolRoundTrip({
    peer: mesh.peer,
    roster,
    call: { name: 'search', args: { q: 'x' } },
    timeoutMs: 120,
    priorityScore: (id) => (id === 'dead' ? 100 : 0),
  });

  assert.equal(out.status, 'ok');
  assert.equal(out.providerPeerId, 'alive');
  assert.deepEqual(out.triedPeerIds, ['dead', 'alive']);
});

test('runToolRoundTrip: all providers silent -> graceful timeout, no hang', async () => {
  const mesh = createMockMesh('driver');
  mesh.toolPeers.set('d1', { answer: 'silent' });
  const out = await runToolRoundTrip({
    peer: mesh.peer,
    roster: [toolPeerEntry('d1', 'search')],
    call: { name: 'search', args: {} },
    timeoutMs: 80,
  });
  assert.equal(out.status, 'timeout');
  assert.deepEqual(out.triedPeerIds, ['d1']);
});

// ── Economy ────────────────────────────────────────────────────────────────

test('runToolRoundTrip: a served call credits the provider and debits the consumer', async () => {
  const mesh = createMockMesh('driver');
  mesh.toolPeers.set('toolnode', { answer: 'ok' });
  const ledger = new StandingLedger();
  const now = 1_000_000;

  await runToolRoundTrip({
    peer: mesh.peer,
    roster: [toolPeerEntry('toolnode', 'current_time')],
    call: { name: 'current_time', args: {} },
    standingLedger: ledger,
    now: () => now,
  });

  // Provider earned standing; a GPU-less tool node now outranks an unseen peer.
  assert.ok(ledger.standingOf('toolnode', now) > 0);
  assert.ok(ledger.priorityScore('toolnode', now) > ledger.priorityScore('never-seen', now));
  // The consumer (driver) carries a debit.
  assert.ok(ledger.standingOf('driver', now) < 0);
});

test('runToolRoundTrip: a FAILED call credits the provider nothing but still debits the consumer', async () => {
  const mesh = createMockMesh('driver');
  mesh.toolPeers.set('toolnode', { answer: 'error' });
  const ledger = new StandingLedger();
  const now = 2_000_000;

  const out = await runToolRoundTrip({
    peer: mesh.peer,
    roster: [toolPeerEntry('toolnode', 'search')],
    call: { name: 'search', args: {} },
    standingLedger: ledger,
    now: () => now,
  });

  assert.equal(out.status, 'error');
  assert.ok(out.resultBlock?.includes('error'));
  assert.equal(ledger.standingOf('toolnode', now), 0, 'no credit for a failed tool call');
  assert.ok(ledger.hasHistory('toolnode'), 'but the provider is now "seen" (no newcomer re-farming)');
  assert.ok(ledger.standingOf('driver', now) < 0, 'consumer still debited for occupying the turn');
});

// ── Pure standing methods ────────────────────────────────────────────────

test('recordToolService: repeated served calls accumulate; priority is monotonic', () => {
  const ledger = new StandingLedger();
  const now = 5_000_000;
  const before = ledger.priorityScore('p', now);
  ledger.recordToolService({ providerPeerId: 'p', succeeded: true }, now);
  const after1 = ledger.standingOf('p', now);
  ledger.recordToolService({ providerPeerId: 'p', succeeded: true }, now);
  const after2 = ledger.standingOf('p', now);
  assert.ok(after2 > after1 && after1 > 0);
  assert.ok(ledger.priorityScore('p', now) > before);
});
