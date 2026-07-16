/**
 * meshViewModels unit tests — pure derivations from topology/ledger data,
 * no mesh or browser required. Covers the capacity-gap CTA copy, the
 * degrade-not-deny standing framing (never "blocked"/"denied"), and the
 * leaderboard/topology-map shaping.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StandingLedger } from '@unstable-legion/core';
import type { CommunalTopology, MeshRosterEntry } from '@unstable-legion/core';
import {
  deriveCapacityView,
  deriveLeaderboard,
  deriveStandingView,
  deriveTopologySegments,
  nickLookup,
  shortPeerId,
} from '../src/viewmodels/meshViewModels.ts';

function topology(overrides: Partial<CommunalTopology> = {}): CommunalTopology {
  return {
    modelId: 'qwen3-8b-q4',
    totalLayers: 36,
    driverLayers: 2,
    segments: [],
    coveredLayers: [],
    gaps: [],
    outputCovered: true,
    seats: 4,
    coverageFraction: 1,
    ...overrides,
  };
}

const MODEL_LABEL = 'Qwen3-8B · Q4_K_M';

test('deriveCapacityView: full coverage is ready, no gap message, model-named status line', () => {
  const view = deriveCapacityView(topology(), MODEL_LABEL);
  assert.equal(view.ready, true);
  assert.equal(view.coveragePercent, 100);
  assert.equal(view.seatsFree, 4);
  assert.equal(view.gapMessage, '');
  assert.equal(view.modelLabel, MODEL_LABEL);
  assert.equal(view.statusLine, 'Qwen3-8B · Q4_K_M ready — 4 seats free');
});

test('deriveCapacityView: partial coverage produces the exact CTA framing from the brief, model-named', () => {
  const view = deriveCapacityView(
    topology({
      coverageFraction: 0.6,
      gaps: [{ layerStart: 14, layerEnd: 27 }],
      seats: 0,
    }),
    MODEL_LABEL,
  );
  assert.equal(view.ready, false);
  assert.equal(view.coveragePercent, 60);
  assert.equal(view.seatsFree, undefined);
  assert.equal(
    view.gapMessage,
    'Qwen3-8B · Q4_K_M 60% assembled — layers 14–27 need a host. Contribute your GPU to unlock chat.',
  );
  assert.equal(view.statusLine, 'Assembling Qwen3-8B · Q4_K_M — 60% ready');
});

test('deriveCapacityView: a single free seat is singular ("1 seat free", not "1 seats free")', () => {
  const view = deriveCapacityView(topology({ seats: 1 }), MODEL_LABEL);
  assert.equal(view.statusLine, 'Qwen3-8B · Q4_K_M ready — 1 seat free');
});

test('deriveCapacityView: unbounded seats (no communal layers needed) reports seatsFree undefined', () => {
  const view = deriveCapacityView(topology({ seats: Number.POSITIVE_INFINITY }), MODEL_LABEL);
  assert.equal(view.ready, true);
  assert.equal(view.seatsFree, undefined);
});

test('deriveTopologySegments: local + covered + gap segments in layer order', () => {
  const view = deriveTopologySegments(
    topology({
      segments: [
        {
          layerStart: 2,
          layerEnd: 20,
          candidates: [
            {
              peerId: 'peer-a',
              modelId: 'qwen3-8b-q4',
              layerStart: 2,
              layerEnd: 20,
              includeEmbeddings: false,
              includeOutput: false,
              ctxSize: 4096,
              wireDtype: 'f32',
              maxSessions: 2,
              activeSessions: 0,
              epoch: 1,
              headroom: 2,
              stabilityScore: 1,
            },
          ],
        },
      ],
      gaps: [{ layerStart: 20, layerEnd: 36 }],
    }),
    { selfId: 'self', nickOf: (id) => (id === 'peer-a' ? 'Alice' : undefined) },
  );

  assert.deepEqual(
    view.map((s) => [s.layerStart, s.layerEnd, s.kind, s.label]),
    [
      [0, 2, 'local', 'you'],
      [2, 20, 'covered', 'Alice'],
      [20, 36, 'gap', undefined],
    ],
  );
});

test('shortPeerId truncates long ids and leaves short ones alone', () => {
  assert.equal(shortPeerId('abc'), 'abc');
  assert.equal(shortPeerId('abcdefghijklmnop'), 'abcdefgh…');
});

test('nickLookup resolves nicks from a roster snapshot', () => {
  const roster = [{ peerId: 'p1', nick: 'Bob' }] as unknown as readonly MeshRosterEntry[];
  const lookup = nickLookup(roster);
  assert.equal(lookup('p1'), 'Bob');
  assert.equal(lookup('nope'), undefined);
});

test('deriveStandingView: unseen peer is framed as newcomer, never blocked', () => {
  const ledger = new StandingLedger();
  const view = deriveStandingView(ledger, 'self', 1000, ledger.topContributors(10, 1000));
  assert.equal(view.tier, 'newcomer');
  assert.doesNotMatch(view.message.toLowerCase(), /block|den(y|ied)/);
});

test('deriveStandingView: a peer running standing debt gets the "move up the queue" framing, not a refusal', () => {
  const ledger = new StandingLedger();
  const now = 1000;
  // Consumption with no service recorded -> negative standing, but the
  // peer HAS history (seen).
  ledger.recordConsumption({ consumerPeerId: 'self', layersConsumed: 10, framesConsumed: 500, consumingMs: 5000 }, now);
  const view = deriveStandingView(ledger, 'self', now, ledger.topContributors(10, now));
  assert.equal(view.tier, 'debt');
  assert.doesNotMatch(view.message.toLowerCase(), /block|den(y|ied)/);
  assert.match(view.message, /contribute/i);
});

test('deriveStandingView: a peer that served real work ranks as a top contributor', () => {
  const ledger = new StandingLedger();
  const now = 1000;
  ledger.recordService({ hostPeerId: 'self', layersServed: 10, framesServed: 200, servingMs: 10_000, sessionCompleted: true }, now);
  const top = ledger.topContributors(10, now);
  const view = deriveStandingView(ledger, 'self', now, top);
  assert.equal(view.tier, 'top');
  assert.match(view.message, /priority/i);
});

test('deriveStandingView: hostedRange passes through untouched', () => {
  const ledger = new StandingLedger();
  const view = deriveStandingView(ledger, 'self', 1000, [], { layerStart: 2, layerEnd: 20 });
  assert.deepEqual(view.hostedRange, { layerStart: 2, layerEnd: 20 });
});

test('deriveLeaderboard: ranks by standing, marks self, prefers nick over peerId', () => {
  const ledger = new StandingLedger();
  const now = 1000;
  ledger.recordService({ hostPeerId: 'p1', layersServed: 10, framesServed: 500, servingMs: 10_000, sessionCompleted: true }, now);
  ledger.recordService({ hostPeerId: 'p2', layersServed: 10, framesServed: 100, servingMs: 10_000, sessionCompleted: true }, now);
  const top = ledger.topContributors(10, now);
  const board = deriveLeaderboard(top, { selfId: 'p2', nickOf: (id) => (id === 'p1' ? 'Alice' : undefined) });
  assert.equal(board[0]!.peerId, 'p1');
  assert.equal(board[0]!.label, 'Alice');
  assert.equal(board[0]!.rank, 1);
  const self = board.find((b) => b.peerId === 'p2')!;
  assert.equal(self.isSelf, true);
  assert.equal(self.label, shortPeerId('p2'));
});
