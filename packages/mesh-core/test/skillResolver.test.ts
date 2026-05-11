/**
 * Skill resolver unit tests — DNS-style hierarchical routing.
 *
 * The resolver is async and depends on `peer.onTool` + `peer.sendTool`.
 * We mock those with a tiny in-memory peer that pretends a network
 * round-trip happened: any `sendTool({kind:'call', ...})` triggers a
 * synthesized `kind:'result'` after a microtask.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  routeBySkill,
  SkillCache,
  RESOLVER_HOPS_KEY,
} from '../src/skillResolver.ts';
import type {
  MeshChatMessage,
  MeshRosterEntry,
  MeshToolFrame,
  MeshToolResult,
} from '../src/types.ts';
import type { CodecMsgpackFrame } from '../src/wire.ts';
import type { WebRtcEnvelope } from '../src/webrtc-codec.ts';
import type { Peer } from '../src/peer.ts';
import type { Roster } from '../src/roster.ts';

// ── Mock peer + mock network ──────────────────────────────────────────────

interface MockExecution {
  peerId: string;
  toolName: string;
  args: Readonly<Record<string, unknown>>;
}

/**
 * Build a mock peer whose `sendTool` routes to a synthetic "remote"
 * handler keyed by `peerId`. Each handler returns a `MeshToolResult`
 * (or throws to simulate a peer-side error). The handler may itself
 * call back through the mesh (e.g. a delegator handler that recurses
 * into `routeBySkill`) — but for these unit tests we keep handlers
 * pure and let `routeBySkill` itself orchestrate hops by directly
 * sending to the right peerId.
 */
function makeMockPeer(
  handlers: Record<
    string,
    (toolName: string, args: Readonly<Record<string, unknown>>) => Promise<MeshToolResult>
  >,
): { peer: Peer; executions: MockExecution[] } {
  const executions: MockExecution[] = [];
  const toolListeners = new Set<(frame: MeshToolFrame, peerId: string) => void>();

  // Roster is unused by routeBySkill (which takes its roster snapshot
  // via ctx.roster, not via peer.roster). Stub it as an empty object
  // cast — avoids spawning Roster's prune-interval timer that would
  // otherwise prevent Node's test runner from exiting cleanly.
  const peer: Peer = {
    selfId: 'self',
    roster: {} as unknown as Roster,
    setCap: () => undefined,
    sendChat: async () => undefined,
    onChat: () => () => undefined,
    sendFrame: async () => undefined,
    onFrame: () => () => undefined,
    sendEnvelope: async () => undefined,
    onEnvelope: () => () => undefined,
    sendTool: async (frame, target) => {
      if (frame.kind !== 'call') return;
      const targetId =
        typeof target === 'string' ? target : Array.isArray(target) ? target[0]! : '';
      const handler = handlers[targetId];
      executions.push({ peerId: targetId, toolName: frame.toolName, args: frame.args });
      let result: MeshToolResult;
      if (handler) {
        try {
          result = await handler(frame.toolName, frame.args);
        } catch (err) {
          result = {
            v: 1 as const,
            ts: Date.now(),
            callId: frame.callId,
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          };
        }
      } else {
        result = {
          v: 1 as const,
          ts: Date.now(),
          callId: frame.callId,
          status: 'error',
          error: `mock: no handler for peer ${targetId}`,
        };
      }
      // Preserve the asker's callId so the tracker can settle.
      const settled: MeshToolResult = { ...result, callId: frame.callId };
      for (const cb of toolListeners) cb({ kind: 'result', ...settled }, targetId);
    },
    onTool: (cb) => {
      toolListeners.add(cb);
      return () => toolListeners.delete(cb);
    },
    leave: () => undefined,
  };
  // Suppress unused-import-type warnings.
  void {} as MeshChatMessage | CodecMsgpackFrame | WebRtcEnvelope | undefined;
  return { peer, executions };
}

function makeEntry(
  peerId: string,
  overrides: Partial<MeshRosterEntry> & {
    authoritative?: readonly string[];
    delegating?: readonly string[];
  } = {},
): MeshRosterEntry {
  const base: MeshRosterEntry = {
    peerId,
    lastSeen: Date.now(),
    v: 1 as const,
    ts: Date.now(),
    nick: peerId,
    modelId: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    available: true,
    skills: [],
    systemPromptSummary: '',
    tools: [],
    ...overrides,
  };
  if (overrides.authoritative)
    (base as { authoritative?: readonly string[] }).authoritative = overrides.authoritative;
  if (overrides.delegating)
    (base as { delegating?: readonly string[] }).delegating = overrides.delegating;
  return base;
}

// ── Tests ────────────────────────────────────────────────────────────────

test('routeBySkill: authoritative exact match calls the peer directly', async () => {
  const { peer, executions } = makeMockPeer({
    leaf: async () => ({
      v: 1 as const,
      ts: Date.now(),
      callId: '',
      status: 'ok',
      result: { content: { text: 'done by leaf' } },
    }),
  });
  const roster = [makeEntry('leaf', { authoritative: ['summarize'] })];
  const result = await routeBySkill({ peer, roster }, 'summarize', { user: 'hi' });
  assert.equal(result.status, 'ok');
  assert.equal((result.result as { content?: { text?: string } })?.content?.text, 'done by leaf');
  assert.deepEqual(executions, [{ peerId: 'leaf', toolName: 'engine_run', args: { user: 'hi' } }]);
});

test('routeBySkill: authoritative dotted-prefix match', async () => {
  const { peer, executions } = makeMockPeer({
    py: async () => ({
      v: 1 as const,
      ts: Date.now(),
      callId: '',
      status: 'ok',
      result: { content: { text: 'py-result' } },
    }),
  });
  const roster = [makeEntry('py', { authoritative: ['coding.python'] })];
  // Query is more specific than the advertised skill — should still match.
  const result = await routeBySkill(
    { peer, roster },
    'coding.python.optimize',
    { user: '...' },
  );
  assert.equal(result.status, 'ok');
  assert.equal(executions[0]?.peerId, 'py');
});

test('routeBySkill: delegates via route_skill when no authoritative match', async () => {
  const { peer, executions } = makeMockPeer({
    coord: async (toolName, args) => {
      // The "delegator" peer's route_skill handler. We don't actually
      // run a nested resolver here — we just verify the resolver
      // routes to the delegator with the right shape.
      assert.equal(toolName, 'route_skill');
      assert.equal(args.skill, 'coding.python.optimize');
      assert.equal(args[RESOLVER_HOPS_KEY], 1);
      return {
        v: 1 as const,
        ts: Date.now(),
        callId: '',
        status: 'ok',
        result: { content: { text: 'resolved-via-delegator' } },
      };
    },
  });
  const roster = [makeEntry('coord', { delegating: ['coding'] })];
  const result = await routeBySkill(
    { peer, roster },
    'coding.python.optimize',
    { user: '...' },
  );
  assert.equal(result.status, 'ok');
  assert.equal(executions[0]?.toolName, 'route_skill');
});

test('routeBySkill: returns error when nothing matches', async () => {
  const { peer } = makeMockPeer({});
  const roster = [makeEntry('x', { authoritative: ['other'] })];
  const result = await routeBySkill({ peer, roster }, 'unknown.skill', {});
  assert.equal(result.status, 'error');
  assert.ok(result.error?.includes('no authority'));
});

test('routeBySkill: hop limit bails cleanly', async () => {
  const { peer, executions } = makeMockPeer({});
  const roster = [makeEntry('coord', { delegating: ['x'] })];
  const result = await routeBySkill(
    { peer, roster },
    'x.deep.deeper',
    { [RESOLVER_HOPS_KEY]: 4 }, // already at max
    { maxDepth: 4 },
  );
  assert.equal(result.status, 'error');
  assert.ok(result.error?.includes('hop limit'));
  assert.equal(executions.length, 0); // no network call attempted
});

test('SkillCache: get returns null for missing or expired entries', () => {
  const cache = new SkillCache(100);
  assert.equal(cache.get('x'), null);
  cache.set('x', 'p1', 'authoritative');
  assert.deepEqual(cache.get('x'), { peerId: 'p1', resolvedVia: 'authoritative' });
});

test('SkillCache: invalidatePeer drops matching entries', () => {
  const cache = new SkillCache();
  cache.set('a', 'p1', 'authoritative');
  cache.set('b', 'p1', 'authoritative');
  cache.set('c', 'p2', 'authoritative');
  cache.invalidatePeer('p1');
  assert.equal(cache.get('a'), null);
  assert.equal(cache.get('b'), null);
  assert.notEqual(cache.get('c'), null);
});

test('routeBySkill: cache hit shortcuts authoritative resolution', async () => {
  let callCount = 0;
  const { peer, executions } = makeMockPeer({
    leaf: async () => {
      callCount += 1;
      return {
        v: 1 as const,
        ts: Date.now(),
        callId: '',
        status: 'ok',
        result: { content: { text: 'hit' } },
      };
    },
  });
  const roster = [makeEntry('leaf', { authoritative: ['x'] })];
  const cache = new SkillCache();
  const ctx = { peer, roster, cache };

  // First call: populates the cache.
  await routeBySkill(ctx, 'x', {});
  assert.equal(callCount, 1);
  assert.equal(executions.length, 1);

  // Second call: cache should short-circuit (still ends up calling
  // the peer, since the cache stores the peerId — but the routing
  // step is skipped). Total executions: 2 (one per call).
  await routeBySkill(ctx, 'x', {});
  assert.equal(callCount, 2);
  // Verify cache state.
  assert.deepEqual(cache.get('x'), { peerId: 'leaf', resolvedVia: 'authoritative' });
});

test('routeBySkill: strips resolver-internal args before forwarding to leaf', async () => {
  const { peer, executions } = makeMockPeer({
    leaf: async () => ({
      v: 1 as const,
      ts: Date.now(),
      callId: '',
      status: 'ok',
      result: { content: { text: 'ok' } },
    }),
  });
  const roster = [makeEntry('leaf', { authoritative: ['x'] })];
  await routeBySkill({ peer, roster }, 'x', {
    user: 'hello',
    [RESOLVER_HOPS_KEY]: 1,
    _originPeerId: 'origin',
  });
  // Leaf should receive `user` but NOT the resolver-internal keys.
  assert.deepEqual(executions[0]?.args, { user: 'hello' });
});
