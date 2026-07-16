/**
 * OPTIONAL-STAGE0 (thin drivers) — pure-core tests.
 *
 * Covers the three mesh-core pieces the thin-driver feature adds:
 *   1. Topology built with `communalStart: 0` keeps isFirst `[0, X)` ads and
 *      `planThinDriverRoute` produces a NO-local-stage route.
 *   2. `communalHostClaim` with `firstLayer: 0` claims `[0, X)` WITH
 *      embeddings — the isFirst communal host — and coexists with ordinary
 *      body hosts in one room, both regimes converging under random churn.
 *   3. `runCommunalDriverSession({ thinDriver: true })` completes a session
 *      WITHOUT ever invoking local prefill/decode (no local stage-0 worker),
 *      shipping token-ids to the remote isFirst stage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCommunalTopology,
  planThinDriverRoute,
  thinDriverFirstStageCovered,
  communalAttachOrder,
  type CommunalHostStageAd,
} from '../src/communalTopology.ts';
import { communalHostClaim } from '../src/communalAssembly.ts';
import { runCommunalDriverSession, type CommunalRoute } from '../src/stageOrchestrator.ts';
import {
  decodeStageControl,
  encodeStageControl,
  makeStagePong,
  makeStageSessionAccept,
  makeStageToken,
} from '../src/stageControl.ts';
import { decodeStageFrameEnvelope } from '../src/stageFrameEnvelope.ts';
import type { MeshRosterEntry, MeshToolFrame } from '../src/types.ts';
import type { StagePlan } from '../src/stagePlanner.ts';

const MODEL = 'qwen3-0.6b-q8_0';
const TOTAL = 28;
const DRIVER = 2;

function makePeer(
  peerId: string,
  stages: { layerStart: number; layerEnd: number; includeOutput?: boolean; maxSessions?: number; activeSessions?: number }[],
  stabilityScore = 1000,
): MeshRosterEntry {
  return {
    v: 1,
    ts: Date.now(),
    peerId,
    lastSeen: Date.now(),
    nick: peerId,
    modelId: 'n/a',
    available: true,
    skills: [],
    systemPromptSummary: '',
    tools: [],
    stageHost: {
      maxStorageBufferBytes: 1_000_000_000,
      wasmHeapBudget: 1_000_000_000,
      stability: { keepalive: false, visible: false, uptimeMs: stabilityScore * 1000 },
      loadedStages: stages.map((s) => ({
        modelId: MODEL,
        layerStart: s.layerStart,
        layerEnd: s.layerEnd,
        includeEmbeddings: s.layerStart === 0, // isFirst iff owns layer 0
        includeOutput: s.includeOutput ?? s.layerEnd === TOTAL,
        ctxSize: 512,
        wireDtype: 'f32' as const,
        maxSessions: s.maxSessions ?? 4,
        activeSessions: s.activeSessions ?? 0,
        epoch: 1,
      })),
    },
  };
}

// ── 1. Topology + route planning ─────────────────────────────────────────

test('thin topology: communalStart=0 keeps the isFirst [0,X) ad that the default view drops', () => {
  const roster = [makePeer('whole', [{ layerStart: 0, layerEnd: TOTAL }])];

  // Default (capable) view drops layerStart<driverLayers ads -> a gap.
  const capable = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL, driverLayers: DRIVER });
  assert.ok(capable.gaps.length > 0, 'capable view should NOT see the [0,28) ad');

  // Thin view keeps it and is fully covered from layer 0.
  const thin = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL, driverLayers: DRIVER, communalStart: 0 });
  assert.equal(thin.gaps.length, 0);
  assert.equal(thin.segments[0]!.layerStart, 0);
  assert.ok(thinDriverFirstStageCovered(thin));
});

test('thin topology: gap-free coverage that lacks an isFirst host at layer 0 is NOT thin-routable', () => {
  // Body host covers [2,28) but nobody owns embeddings at layer 0.
  const roster = [makePeer('body', [{ layerStart: 2, layerEnd: TOTAL }])];
  const thin = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL, driverLayers: DRIVER, communalStart: 0 });
  assert.ok(thin.gaps.length > 0, '[0,2) prefix is uncovered');
  assert.equal(thinDriverFirstStageCovered(thin), false);
});

test('planThinDriverRoute: single whole-model isFirst host -> one remote stage, no local stage 0', () => {
  const roster = [makePeer('whole', [{ layerStart: 0, layerEnd: TOTAL }])];
  const thin = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL, driverLayers: DRIVER, communalStart: 0 });
  const plan = planThinDriverRoute(thin, { driverPeerId: 'thin-driver', nEmbd: 1024 });
  assert.ok(plan);
  assert.equal(plan!.stages.length, 1, 'no synthetic local stage 0 — the mesh hosts the first stage');
  const s0 = plan!.stages[0]!;
  assert.equal(s0.stageIndex, 1);
  assert.equal(s0.peerId, 'whole');
  assert.equal(s0.layerStart, 0);
  assert.equal(s0.isFirst, true);
  assert.equal(s0.isFinal, true);
});

test('planThinDriverRoute: returns null when not thin-routable or nEmbd missing', () => {
  const bodyOnly = buildCommunalTopology([makePeer('body', [{ layerStart: 2, layerEnd: TOTAL }])], {
    modelId: MODEL,
    totalLayers: TOTAL,
    driverLayers: DRIVER,
    communalStart: 0,
  });
  assert.equal(planThinDriverRoute(bodyOnly, { driverPeerId: 'd', nEmbd: 1024 }), null);

  const routable = buildCommunalTopology([makePeer('whole', [{ layerStart: 0, layerEnd: TOTAL }])], {
    modelId: MODEL,
    totalLayers: TOTAL,
    driverLayers: DRIVER,
    communalStart: 0,
  });
  assert.equal(planThinDriverRoute(routable, { driverPeerId: 'd' }), null, 'nEmbd required');
});

// ── 2. Assembly: isFirst claim + coexistence ─────────────────────────────

test('communalHostClaim firstLayer=0: empty mesh -> claims [0,total) WITH embeddings', () => {
  const d = communalHostClaim({
    roster: [],
    selfPeerId: 'self',
    modelId: MODEL,
    totalLayers: TOTAL,
    driverLayers: DRIVER,
    firstLayer: 0,
    selfCapacityLayers: 100,
  });
  assert.deepEqual(d.claim, { layerStart: 0, layerEnd: TOTAL, includeOutput: true, includeEmbeddings: true });
});

test('communalHostClaim firstLayer=0: fills only the [0,driverLayers) prefix when a body host already covers the rest', () => {
  const roster = [makePeer('body', [{ layerStart: 2, layerEnd: TOTAL }])];
  const d = communalHostClaim({
    roster,
    selfPeerId: 'self',
    modelId: MODEL,
    totalLayers: TOTAL,
    driverLayers: DRIVER,
    firstLayer: 0,
    selfCapacityLayers: 100,
  });
  assert.deepEqual(d.claim, { layerStart: 0, layerEnd: 2, includeOutput: false, includeEmbeddings: true });
});

test('communalHostClaim default firstLayer (capable) is unchanged — never claims layer 0', () => {
  const d = communalHostClaim({
    roster: [],
    selfPeerId: 'self',
    modelId: MODEL,
    totalLayers: TOTAL,
    driverLayers: DRIVER,
    selfCapacityLayers: 100,
  });
  assert.deepEqual(d.claim, { layerStart: 2, layerEnd: TOTAL, includeOutput: true });
});

// ── Coexistence convergence property test ────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimHost {
  peerId: string;
  mode: 'thin' | 'capable';
  capacityLayers: number;
  currentClaim: { layerStart: number; layerEnd: number; includeOutput: boolean } | null;
  stabilityScore: number;
}

function rosterFromHosts(hosts: readonly SimHost[]): MeshRosterEntry[] {
  return hosts
    .filter((h) => h.currentClaim !== null)
    .map((h) => makePeer(h.peerId, [{ layerStart: h.currentClaim!.layerStart, layerEnd: h.currentClaim!.layerEnd, includeOutput: h.currentClaim!.includeOutput }], h.stabilityScore));
}

function runRound(hosts: SimHost[], rand: () => number): void {
  const order = hosts.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  for (const idx of order) {
    const h = hosts[idx]!;
    const others = rosterFromHosts(hosts.filter((_, i) => i !== idx));
    const d = communalHostClaim({
      roster: others,
      selfPeerId: h.peerId,
      modelId: MODEL,
      totalLayers: TOTAL,
      driverLayers: DRIVER,
      firstLayer: h.mode === 'thin' ? 0 : DRIVER,
      selfCapacityLayers: h.capacityLayers,
      selfCurrentClaim: h.currentClaim,
      selfStabilityScore: h.stabilityScore,
    });
    if (d.yieldCurrent) h.currentClaim = null;
    else if (d.claim) h.currentClaim = d.claim;
  }
}

test('property: thin + capable hosts coexist in one room; BOTH regimes converge', () => {
  const SEEDS = 40;
  let checked = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rand = mulberry32(seed * 7919);
    const hosts: SimHost[] = [];
    let capableCap = 0;
    // 1-3 capable body hosts.
    const nCapable = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < nCapable; i++) {
      const cap = 10 + Math.floor(rand() * 19); // 10..28
      capableCap += cap;
      hosts.push({ peerId: `c${i}`, mode: 'capable', capacityLayers: cap, currentClaim: null, stabilityScore: Math.floor(rand() * 3600) });
    }
    // 1-2 thin-support hosts (contribute the isFirst prefix / whole model).
    const nThin = 1 + Math.floor(rand() * 2);
    for (let i = 0; i < nThin; i++) {
      const cap = 4 + Math.floor(rand() * 25); // 4..28
      hosts.push({ peerId: `t${i}`, mode: 'thin', capacityLayers: cap, currentClaim: null, stabilityScore: Math.floor(rand() * 3600) });
    }
    // Only assert on seeds where capable coverage is actually achievable.
    if (capableCap < TOTAL - DRIVER) continue;
    checked++;

    for (let r = 0; r < 40; r++) runRound(hosts, rand);
    const roster = rosterFromHosts(hosts);

    const capable = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL, driverLayers: DRIVER });
    assert.equal(capable.gaps.length, 0, `seed=${seed} capable regime did not converge: ${JSON.stringify(hosts)}`);

    const thin = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL, driverLayers: DRIVER, communalStart: 0 });
    assert.equal(thin.gaps.length, 0, `seed=${seed} thin regime has a gap: ${JSON.stringify(hosts)}`);
    assert.ok(thinDriverFirstStageCovered(thin), `seed=${seed} thin regime lacks an isFirst host at layer 0`);
  }
  assert.ok(checked >= 10, `expected a meaningful number of asserted seeds, got ${checked}`);
});

test('property: killing the isFirst host re-opens the thin prefix, then the mesh re-covers it', () => {
  const SEEDS = 20;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rand = mulberry32(seed * 104729);
    const hosts: SimHost[] = [
      { peerId: 'c0', mode: 'capable', capacityLayers: 28, currentClaim: null, stabilityScore: Math.floor(rand() * 3600) },
      { peerId: 't0', mode: 'thin', capacityLayers: 28, currentClaim: null, stabilityScore: Math.floor(rand() * 3600) },
      { peerId: 't1', mode: 'thin', capacityLayers: 28, currentClaim: null, stabilityScore: Math.floor(rand() * 3600) },
    ];
    for (let r = 0; r < 30; r++) runRound(hosts, rand);
    let thin = buildCommunalTopology(rosterFromHosts(hosts), { modelId: MODEL, totalLayers: TOTAL, driverLayers: DRIVER, communalStart: 0 });
    assert.ok(thinDriverFirstStageCovered(thin), `seed=${seed} did not converge before churn`);

    // Kill whichever thin host currently owns layer 0.
    const firstOwner = hosts.find((h) => h.currentClaim?.layerStart === 0);
    assert.ok(firstOwner, `seed=${seed} no layer-0 owner found`);
    const remaining = hosts.filter((h) => h !== firstOwner);
    for (let r = 0; r < 30; r++) runRound(remaining, rand);

    thin = buildCommunalTopology(rosterFromHosts(remaining), { modelId: MODEL, totalLayers: TOTAL, driverLayers: DRIVER, communalStart: 0 });
    assert.equal(thin.gaps.length, 0, `seed=${seed} thin regime did not re-converge after killing the isFirst host`);
    assert.ok(thinDriverFirstStageCovered(thin), `seed=${seed} no isFirst host after re-convergence`);
  }
});

// ── 3. Thin-driver SESSION path (thinDriver mode flag) ───────────────────

function thinRouteFor(peerId: string): CommunalRoute {
  const ad: CommunalHostStageAd = {
    peerId,
    modelId: MODEL,
    layerStart: 0,
    layerEnd: TOTAL,
    includeEmbeddings: true,
    includeOutput: true,
    ctxSize: 512,
    wireDtype: 'f32',
    maxSessions: 4,
    activeSessions: 0,
    epoch: 1,
    headroom: 4,
    stabilityScore: 1000,
  };
  const topo = buildCommunalTopology([makePeer(peerId, [{ layerStart: 0, layerEnd: TOTAL }])], {
    modelId: MODEL,
    totalLayers: TOTAL,
    driverLayers: DRIVER,
    communalStart: 0,
  });
  const plan = planThinDriverRoute(topo, { driverPeerId: 'thin-driver', nEmbd: 8 })!;
  const attachOrder = communalAttachOrder(topo, { driverPeerId: 'thin-driver' });
  // topology numbers the single segment as stageIndex 1; attach candidates = [ad].
  void ad;
  return { plan: plan as StagePlan, attachOrder };
}

function createThinMockMesh(selfId: string) {
  const toolListeners = new Set<(frame: MeshToolFrame, peerId: string) => void>();
  const hostId = 'isFirstHost';
  const framesWithTokens: Array<{ seq: number; tokenCount: number }> = [];
  let currentSessionId = '';
  let framesSeen = 0;

  function deliver(frame: MeshToolFrame, from: string): void {
    for (const cb of toolListeners) cb(frame, from);
  }
  const targets = (p?: string | string[]) => (!p ? [] : Array.isArray(p) ? p : [p]);

  const peer = {
    selfId,
    async sendTool(frame: MeshToolFrame, peers?: string | string[]) {
      for (const t of targets(peers)) {
        if (t !== hostId) continue;
        const d = decodeStageControl(frame);
        if (!d) continue;
        if (d.kind === 'stage.ping') {
          currentSessionId = d.sessionId;
          queueMicrotask(() => deliver(encodeStageControl(makeStagePong(d.sessionId, d.payload.sentAtMs, d.callId)), hostId));
        } else if (d.kind === 'stage.session.open') {
          currentSessionId = d.sessionId;
          const accept = makeStageSessionAccept(
            d.sessionId,
            { nEmbd: 8, isFirst: true, isFinal: true, activeSessions: 1, maxSessions: 4 },
            d.callId,
          );
          queueMicrotask(() => deliver(encodeStageControl(accept), hostId));
        }
      }
    },
    onTool(cb: (frame: MeshToolFrame, peerId: string) => void) {
      toolListeners.add(cb);
      return () => toolListeners.delete(cb);
    },
    async sendStageFrame(bytes: Uint8Array, peers?: string | string[]) {
      for (const t of targets(peers)) {
        if (t !== hostId) continue;
        const env = decodeStageFrameEnvelope(bytes);
        if (!env) continue;
        const seq = framesSeen++;
        // NOTE: a thin driver ships zero-activation frames; the isFirst host
        // embeds from the token sideband. We can't cheaply decode the codec
        // frame here, but we CAN confirm a non-empty payload arrived and
        // reply with a token, exercising the full attach/decode round trip.
        framesWithTokens.push({ seq, tokenCount: env.payload.byteLength });
        queueMicrotask(() => deliver(encodeStageControl(makeStageToken(currentSessionId, 5000 + seq, seq, false)), hostId));
      }
    },
    onStageFrame() {
      return () => undefined;
    },
  };
  return { peer, hostId, framesWithTokens };
}

test('runCommunalDriverSession thinDriver:true — completes WITHOUT local prefill/decode', async () => {
  const mesh = createThinMockMesh('thin-driver');
  let prefillCalled = 0;
  let decodeCalled = 0;

  const handle = runCommunalDriverSession({
    peer: mesh.peer,
    route: thinRouteFor(mesh.hostId),
    modelId: MODEL,
    prompt: 'hello thin world',
    maxDecodeTokens: 4,
    thinDriver: true,
    localHooks: {
      nEmbd: 8,
      async tokenize(text: string) {
        return text.split(/\s+/).filter(Boolean).map((_, i) => 10 + i);
      },
      async detokenize(tokens: readonly number[]) {
        return tokens.join(',');
      },
      async reset() {
        throw new Error('thin driver must NOT reset a local stage');
      },
      async prefill() {
        prefillCalled++;
        throw new Error('thin driver must NOT call local prefill');
      },
      async decode() {
        decodeCalled++;
        throw new Error('thin driver must NOT call local decode');
      },
    },
    replanRoute: () => null,
    timeouts: { pingMs: 200, loadMs: 200, bootstrapStepMs: 200, stepTimeoutFloorMs: 50 },
  });

  const result = await handle.result();
  assert.equal(result.aborted, false, `unexpected abort: ${result.abortReason}`);
  assert.equal(prefillCalled, 0, 'local prefill must never be called in thin mode');
  assert.equal(decodeCalled, 0, 'local decode must never be called in thin mode');
  // 3 prompt tokens + 4 generated.
  assert.equal(result.tokens.length, 7);
  // The isFirst host received the prefill frame + one frame per decode step.
  assert.ok(mesh.framesWithTokens.length >= 4, `expected >=4 sf frames, got ${mesh.framesWithTokens.length}`);
  assert.ok(mesh.framesWithTokens.every((f) => f.tokenCount > 0), 'every sf frame must carry a non-empty payload');
});
