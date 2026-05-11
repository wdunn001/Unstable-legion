/**
 * Routing helpers — unit tests.
 *
 * Pure-function tests against synthetic roster fixtures. Covers
 * flat-skill matching, dotted-prefix matching, tool lookup, model
 * family substring match, DNS-style delegating-zone discovery, and
 * pickBestPeer tiebreaks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findPeersBySkill,
  findPeersByTool,
  findPeersByModelFamily,
  findDelegatingPeers,
  pickBestPeer,
} from '../src/routing.ts';
import type { MeshRosterEntry } from '../src/types.ts';

// ── Fixture builder ───────────────────────────────────────────────────────

function peer(
  peerId: string,
  overrides: Partial<MeshRosterEntry> & {
    authoritative?: readonly string[];
    delegating?: readonly string[];
  } = {},
): MeshRosterEntry {
  const base: MeshRosterEntry = {
    peerId,
    lastSeen: 1000,
    v: 1 as const,
    ts: 1000,
    nick: peerId,
    modelId: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    available: true,
    skills: [],
    systemPromptSummary: '',
    tools: [],
    ...overrides,
  };
  // authoritative / delegating are Layer-4 extras — not in the
  // MeshRosterEntry type yet but routing.ts reads them via cast.
  if (overrides.authoritative)
    (base as { authoritative?: readonly string[] }).authoritative = overrides.authoritative;
  if (overrides.delegating)
    (base as { delegating?: readonly string[] }).delegating = overrides.delegating;
  return base;
}

// ── findPeersBySkill ──────────────────────────────────────────────────────

test('findPeersBySkill: exact match on skills[]', () => {
  const roster = [
    peer('p1', { skills: ['summarize', 'translate'] }),
    peer('p2', { skills: ['chat'] }),
    peer('p3', { skills: ['summarize'] }),
  ];
  const hits = findPeersBySkill(roster, 'summarize');
  assert.deepEqual(hits.map((p) => p.peerId), ['p1', 'p3']);
});

test('findPeersBySkill: filters available=false', () => {
  const roster = [
    peer('p1', { skills: ['x'] }),
    peer('p2', { skills: ['x'], available: false }),
  ];
  assert.deepEqual(findPeersBySkill(roster, 'x').map((p) => p.peerId), ['p1']);
  // availableOnly: false includes both
  assert.deepEqual(
    findPeersBySkill(roster, 'x', { availableOnly: false }).map((p) => p.peerId),
    ['p1', 'p2'],
  );
});

test('findPeersBySkill: excludePeerId drops the asker', () => {
  const roster = [peer('me', { skills: ['x'] }), peer('them', { skills: ['x'] })];
  assert.deepEqual(
    findPeersBySkill(roster, 'x', { excludePeerId: 'me' }).map((p) => p.peerId),
    ['them'],
  );
});

test('findPeersBySkill: authoritative[] field is honored alongside skills[]', () => {
  const roster = [
    peer('p1', { authoritative: ['coding.python'] }),
    peer('p2', { skills: ['coding.python'] }),
  ];
  // Both should hit.
  assert.deepEqual(
    findPeersBySkill(roster, 'coding.python').map((p) => p.peerId),
    ['p1', 'p2'],
  );
});

test('findPeersBySkill: dotted-prefix match when matchPrefixes is true', () => {
  const roster = [
    peer('exact', { skills: ['coding.python.optimize'] }),
    peer('broader', { skills: ['coding.python'] }),
    peer('broadest', { skills: ['coding'] }),
    peer('unrelated', { skills: ['cooking.python'] }), // shouldn't match — different root
  ];
  const exactOnly = findPeersBySkill(roster, 'coding.python.optimize');
  assert.deepEqual(exactOnly.map((p) => p.peerId), ['exact']);
  const withPrefix = findPeersBySkill(roster, 'coding.python.optimize', {
    matchPrefixes: true,
  });
  // Order = roster order (no sort applied); checks the SET of matches.
  assert.deepEqual(
    [...withPrefix.map((p) => p.peerId)].sort(),
    ['broader', 'broadest', 'exact'],
  );
});

test('findPeersBySkill: dotted prefix does NOT match partial labels (cooking.python vs coding.python.optimize)', () => {
  const roster = [peer('p', { skills: ['cooking'] })];
  // `cooking` is NOT a prefix of `coding.python.optimize` because the
  // separator after the prefix must be a literal dot.
  assert.equal(
    findPeersBySkill(roster, 'coding.python.optimize', { matchPrefixes: true }).length,
    0,
  );
});

// ── findPeersByTool ───────────────────────────────────────────────────────

test('findPeersByTool: matches by exact tool name', () => {
  const tool = (name: string) => ({
    name,
    description: 'x',
    inputSchema: { type: 'object', properties: {} } as Readonly<Record<string, unknown>>,
  });
  const roster = [
    peer('a', { tools: [tool('current_time'), tool('fetch_text')] }),
    peer('b', { tools: [tool('fetch_text')] }),
    peer('c', { tools: [tool('engine_run')] }),
  ];
  assert.deepEqual(
    findPeersByTool(roster, 'fetch_text').map((p) => p.peerId),
    ['a', 'b'],
  );
});

// ── findPeersByModelFamily ────────────────────────────────────────────────

test('findPeersByModelFamily: substring match on family tail', () => {
  const roster = [
    peer('q', { modelId: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC' }),
    peer('l', { modelId: 'Llama-3.2-1B-Instruct-q4f16_1-MLC' }),
    peer('s', { modelId: 'SmolLM2-360M-Instruct-q4f16_1-MLC' }),
  ];
  // family id can be `qwen/qwen2` — the tail (`qwen2`) is what we match.
  assert.deepEqual(findPeersByModelFamily(roster, 'qwen/qwen2').map((p) => p.peerId), ['q']);
  assert.deepEqual(findPeersByModelFamily(roster, 'llama-3').map((p) => p.peerId), ['l']);
  assert.deepEqual(findPeersByModelFamily(roster, 'smollm2').map((p) => p.peerId), ['s']);
});

// ── findDelegatingPeers ───────────────────────────────────────────────────

test('findDelegatingPeers: longest-prefix wins (DNS-style)', () => {
  const roster = [
    peer('root', { delegating: ['coding'] }),
    peer('lang', { delegating: ['language'] }),
    peer('py', { delegating: ['coding.python'] }),
  ];
  const hits = findDelegatingPeers(roster, 'coding.python.optimize');
  // `coding.python` (length 13) beats `coding` (length 6); `language` doesn't match.
  assert.deepEqual(hits.map((p) => p.peerId), ['py', 'root']);
});

test('findDelegatingPeers: exact-zone match also counts', () => {
  const roster = [peer('p', { delegating: ['coding.python'] })];
  // Querying the zone itself (e.g. for a fallback handler).
  assert.deepEqual(
    findDelegatingPeers(roster, 'coding.python').map((p) => p.peerId),
    ['p'],
  );
});

// ── pickBestPeer ──────────────────────────────────────────────────────────

test('pickBestPeer: default scoring prefers freshest lastSeen', () => {
  const c = [
    peer('old', { lastSeen: 1000 }),
    peer('fresh', { lastSeen: 9999 }),
    peer('mid', { lastSeen: 5000 }),
  ];
  assert.equal(pickBestPeer(c)?.peerId, 'fresh');
});

test('pickBestPeer: custom scoring overrides default', () => {
  const c = [
    peer('a', { lastSeen: 1 }),
    peer('b', { lastSeen: 9 }),
  ];
  // Reverse scoring: lower lastSeen wins.
  assert.equal(pickBestPeer(c, (p) => -p.lastSeen)?.peerId, 'a');
});

test('pickBestPeer: empty input returns null', () => {
  assert.equal(pickBestPeer([]), null);
});
