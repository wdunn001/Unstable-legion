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
  deriveChatNotice,
  deriveLeaderboard,
  deriveOccupancy,
  deriveStandingView,
  deriveTopologySegments,
  nickLookup,
  shortPeerId,
} from '../src/viewmodels/meshViewModels.ts';

type Candidate = CommunalTopology['segments'][number]['candidates'][number];

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    peerId: 'peer-a',
    modelId: 'qwen3-8b-q4',
    layerStart: 2,
    layerEnd: 36,
    includeEmbeddings: false,
    includeOutput: true,
    ctxSize: 4096,
    wireDtype: 'f32',
    maxSessions: 4,
    activeSessions: 1,
    epoch: 1,
    headroom: 3,
    stabilityScore: 1,
    ...overrides,
  };
}

function topology(overrides: Partial<CommunalTopology> = {}): CommunalTopology {
  return {
    modelId: 'qwen3-8b-q4',
    totalLayers: 36,
    driverLayers: 2,
    segments: [],
    coveredLayers: [],
    gaps: [],
    outputCovered: true,
    seats: 0,
    coverageFraction: 1,
    ...overrides,
  };
}

const MODEL_LABEL = 'Qwen3-8B · Q4_K_M';

test('deriveCapacityView: full coverage is ready, no gap message, model-named status line (no seat count folded in)', () => {
  const topo = topology({ segments: [{ layerStart: 2, layerEnd: 36, candidates: [candidate()] }], seats: 3 });
  const view = deriveCapacityView(topo, MODEL_LABEL);
  assert.equal(view.ready, true);
  assert.equal(view.coveragePercent, 100);
  assert.equal(view.gapMessage, '');
  assert.equal(view.modelLabel, MODEL_LABEL);
  // Deliberately does NOT mention seats — that's the separate occupancy
  // meter's job (product feedback: don't blend the two signals).
  assert.equal(view.statusLine, 'Qwen3-8B · Q4_K_M ready');
});

test('deriveCapacityView: partial coverage produces the exact CTA framing from the brief, model-named; no occupancy while not ready', () => {
  const view = deriveCapacityView(
    topology({
      coverageFraction: 0.6,
      gaps: [{ layerStart: 14, layerEnd: 27 }],
    }),
    MODEL_LABEL,
  );
  assert.equal(view.ready, false);
  assert.equal(view.coveragePercent, 60);
  assert.equal(view.occupancy, undefined);
  assert.equal(
    view.gapMessage,
    'Qwen3-8B · Q4_K_M 60% assembled — layers 14–27 need a host. Contribute your GPU to unlock chat.',
  );
  assert.equal(view.statusLine, 'Assembling Qwen3-8B · Q4_K_M — 60% ready');
});

// ── Occupancy meter — room-wide spare CONSUMER capacity, deliberately a
// SEPARATE signal from coverage (see meshViewModels.ts's module doc). ──

test('deriveOccupancy: no communal layers at all (empty segments) -> undefined, nothing to report', () => {
  assert.equal(deriveOccupancy(topology({ segments: [] })), undefined);
});

test('deriveOccupancy: gaps present -> undefined (coverage meter owns the not-ready story)', () => {
  const topo = topology({
    gaps: [{ layerStart: 20, layerEnd: 36 }],
    segments: [{ layerStart: 2, layerEnd: 20, candidates: [candidate({ layerEnd: 20 })] }],
  });
  assert.equal(deriveOccupancy(topo), undefined);
});

test('deriveOccupancy: reports occupancy as a fraction, never a bare free count', () => {
  const topo = topology({ segments: [{ layerStart: 2, layerEnd: 36, candidates: [candidate({ maxSessions: 4, activeSessions: 1 })] }] });
  const occ = deriveOccupancy(topo)!;
  assert.equal(occ.total, 4);
  assert.equal(occ.active, 1);
  assert.equal(occ.free, 3);
  assert.equal(occ.atCapacity, false);
  assert.equal(occ.label, '3 of 4 chat slots open · 1 active now');
});

test('deriveOccupancy: singular "slot" wording for a single-seat bottleneck', () => {
  const topo = topology({ segments: [{ layerStart: 2, layerEnd: 36, candidates: [candidate({ maxSessions: 1, activeSessions: 0 })] }] });
  const occ = deriveOccupancy(topo)!;
  assert.equal(occ.label, '1 of 1 chat slot open · 0 active now');
});

test('deriveOccupancy: zero headroom is framed as a soft queue, never "full"/"blocked"', () => {
  const topo = topology({ segments: [{ layerStart: 2, layerEnd: 36, candidates: [candidate({ maxSessions: 2, activeSessions: 2 })] }] });
  const occ = deriveOccupancy(topo)!;
  assert.equal(occ.free, 0);
  assert.equal(occ.atCapacity, true);
  assert.doesNotMatch(occ.label.toLowerCase(), /\bfull\b|block/);
  assert.match(occ.label, /queue/i);
});

test('deriveOccupancy: multi-segment topology reports the BOTTLENECK segment, matching topology.seats exactly', () => {
  const topo = topology({
    seats: 2, // min(headroom) across segments below, computed the same way buildCommunalTopology does
    segments: [
      { layerStart: 2, layerEnd: 20, candidates: [candidate({ layerEnd: 20, maxSessions: 5, activeSessions: 3 })] }, // headroom 2 (bottleneck)
      { layerStart: 20, layerEnd: 36, candidates: [candidate({ layerStart: 20, layerEnd: 36, maxSessions: 4, activeSessions: 0 })] }, // headroom 4
    ],
  });
  const occ = deriveOccupancy(topo)!;
  assert.equal(occ.free, topo.seats);
  assert.equal(occ.total, 5);
  assert.equal(occ.active, 3);
});

test('deriveOccupancy: sums multiple candidates (warm spares) within the same segment', () => {
  const topo = topology({
    segments: [
      {
        layerStart: 2,
        layerEnd: 36,
        candidates: [candidate({ peerId: 'a', maxSessions: 2, activeSessions: 1 }), candidate({ peerId: 'b', maxSessions: 3, activeSessions: 0 })],
      },
    ],
  });
  const occ = deriveOccupancy(topo)!;
  assert.equal(occ.total, 5);
  assert.equal(occ.active, 1);
  assert.equal(occ.free, 4);
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

// ── deriveChatNotice — honest driver-side failure/reconnect copy ─────────

const READY_CAPACITY = deriveCapacityView(
  topology({ segments: [{ layerStart: 2, layerEnd: 36, candidates: [candidate()] }], seats: 3 }),
  MODEL_LABEL,
);
const GAP_CAPACITY = deriveCapacityView(
  topology({ coverageFraction: 0.6, gaps: [{ layerStart: 14, layerEnd: 27 }] }),
  MODEL_LABEL,
);

test('deriveChatNotice: nothing to say for idle/planning/running-clean/finished', () => {
  assert.equal(deriveChatNotice({ phase: 'idle' }, 0, READY_CAPACITY), undefined);
  assert.equal(deriveChatNotice({ phase: 'planning' }, 0, READY_CAPACITY), undefined);
  assert.equal(deriveChatNotice({ phase: 'running' }, 0, READY_CAPACITY), undefined);
  assert.equal(deriveChatNotice({ phase: 'finished' }, 0, READY_CAPACITY), undefined);
});

test('deriveChatNotice: no-feasible-route error → actionable "layers X–Y need a host", model-named', () => {
  const notice = deriveChatNotice(
    { phase: 'error', error: 'no feasible communal route — mesh coverage has a gap' },
    0,
    GAP_CAPACITY,
  )!;
  assert.equal(notice.kind, 'error');
  assert.match(notice.message, /Qwen3-8B · Q4_K_M/);
  assert.match(notice.message, /layers 14–27 need a host/);
});

test('deriveChatNotice: host-loss error → "Lost connection to a host …"', () => {
  const notice = deriveChatNotice({ phase: 'error', error: 'lost connection to host peer-a' }, 1, READY_CAPACITY)!;
  assert.equal(notice.kind, 'error');
  assert.match(notice.message, /Lost connection to a host/);
});

test('deriveChatNotice: generic error → "Something went wrong"', () => {
  const notice = deriveChatNotice({ phase: 'error', error: 'kaboom' }, 0, READY_CAPACITY)!;
  assert.match(notice.message, /Something went wrong: kaboom/);
});

test('deriveChatNotice: involuntary abort → framed as a stop, user abort → no notice', () => {
  const involuntary = deriveChatNotice({ phase: 'aborted', reason: 'host left the mesh' }, 2, READY_CAPACITY)!;
  assert.equal(involuntary.kind, 'error');
  assert.match(involuntary.message, /The chat stopped/);
  assert.equal(deriveChatNotice({ phase: 'aborted', reason: 'user stopped' }, 0, READY_CAPACITY), undefined);
});

test('deriveChatNotice: running after a replan → transient "reconnecting" notice', () => {
  const notice = deriveChatNotice({ phase: 'running' }, 1, READY_CAPACITY)!;
  assert.equal(notice.kind, 'retrying');
  assert.match(notice.message, /reconnecting/i);
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
