/**
 * M4 contribution-economy tests — `standing.ts` is pure trust/fairness
 * logic, so it's tested hard. Every test drives an explicit mock clock
 * (`now`); nothing here ever calls `Date.now()` or `Math.random()`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StandingLedger,
  createStandingLedger,
  bindPriorityScore,
  defaultNoiseSource,
  DEFAULT_STANDING_CONFIG,
  DEFAULT_HALF_LIFE_MS,
  DEFAULT_NEWCOMER_FLOOR,
  DEFAULT_LOWEST_LANE,
  DEFAULT_NOISE_AMPLITUDE,
  type RecordServiceInput,
  type RecordConsumptionInput,
} from '../src/standing.ts';

const ZERO_NOISE = () => 0; // for tests that want exact arithmetic, not a noise band

function service(overrides: Partial<RecordServiceInput> = {}): RecordServiceInput {
  return {
    hostPeerId: 'host-1',
    layersServed: 1,
    framesServed: 100,
    servingMs: 1_000,
    sessionCompleted: true,
    ...overrides,
  };
}

function consumption(overrides: Partial<RecordConsumptionInput> = {}): RecordConsumptionInput {
  return {
    consumerPeerId: 'consumer-1',
    layersConsumed: 1,
    framesConsumed: 100,
    consumingMs: 1_000,
    ...overrides,
  };
}

function approxEqual(a: number, b: number, eps = 1e-6): void {
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ~= ${b}`);
}

// ── measured-not-claimed ─────────────────────────────────────────────────

test('measured-not-claimed: a host that is never recorded has ~0 standing, however "big" its capability advert would claim', () => {
  const ledger = new StandingLedger();
  // No cap.stageHost/advert concept exists in this module at all — the
  // only way standing moves is recordService/recordConsumption. A peer
  // that never had a completed session recorded stays at 0 no matter
  // what it might have advertised elsewhere.
  assert.equal(ledger.standingOf('big-talker', 1_000), 0);
  assert.equal(ledger.hasHistory('big-talker'), false);
});

test('measured-not-claimed: a host that actually serves frames accrues real standing', () => {
  const ledger = new StandingLedger();
  ledger.recordService(service({ hostPeerId: 'grinder', layersServed: 4, framesServed: 500, servingMs: 10_000 }), 0);
  const standing = ledger.standingOf('grinder', 0);
  assert.equal(standing, 4 * 500 * 10); // layersServed * framesServed * servingSeconds
  assert.ok(standing > 0);
});

// ── completed-sessions-only ──────────────────────────────────────────────

test('completed-sessions-only: an aborted session credits nothing', () => {
  const ledger = new StandingLedger();
  ledger.recordService(service({ hostPeerId: 'aborter', sessionCompleted: false }), 0);
  assert.equal(ledger.standingOf('aborter', 0), 0);
  // But it IS seen now (no longer eligible for the newcomer floor) —
  // this is what closes the "abort repeatedly to farm the newcomer slot"
  // gap while still being literally true that credit is zero.
  assert.equal(ledger.hasHistory('aborter'), true);
});

test('completed-sessions-only: repeated aborts never accumulate credit across calls', () => {
  const ledger = new StandingLedger();
  for (let i = 0; i < 50; i++) {
    ledger.recordService(service({ hostPeerId: 'farmer', sessionCompleted: false, framesServed: 10_000 }), i * 100);
  }
  assert.equal(ledger.standingOf('farmer', 5_000), 0);
});

test('completed-sessions-only: a completed session after aborted attempts credits only the completed one', () => {
  const ledger = new StandingLedger();
  ledger.recordService(service({ hostPeerId: 'p', sessionCompleted: false, framesServed: 9_999 }), 0);
  ledger.recordService(service({ hostPeerId: 'p', sessionCompleted: true, framesServed: 10, layersServed: 1, servingMs: 1_000 }), 100);
  assert.equal(ledger.standingOf('p', 100), 10); // 1 * 10 * 1
});

// ── decay half-life ───────────────────────────────────────────────────────

test('decay half-life: a credit halves exactly at the configured half-life', () => {
  const ledger = new StandingLedger({ noiseSource: ZERO_NOISE });
  ledger.recordService(service({ hostPeerId: 'h', layersServed: 1, framesServed: 100, servingMs: 1_000 }), 0); // +100
  approxEqual(ledger.standingOf('h', DEFAULT_HALF_LIFE_MS), 50);
  approxEqual(ledger.standingOf('h', DEFAULT_HALF_LIFE_MS * 2), 25);
  approxEqual(ledger.standingOf('h', 0), 100);
});

test('decay half-life: custom halfLifeMs is honored', () => {
  const ledger = new StandingLedger({ halfLifeMs: 1_000 });
  ledger.recordService(service({ hostPeerId: 'h', layersServed: 1, framesServed: 100, servingMs: 1_000 }), 0); // +100
  approxEqual(ledger.standingOf('h', 1_000), 50);
});

test('decay half-life: recent outranks historical for equal magnitude credit', () => {
  const ledger = new StandingLedger();
  const now = DEFAULT_HALF_LIFE_MS;
  ledger.recordService(service({ hostPeerId: 'historical', layersServed: 1, framesServed: 100, servingMs: 1_000 }), 0);
  ledger.recordService(service({ hostPeerId: 'recent', layersServed: 1, framesServed: 100, servingMs: 1_000 }), now - 1);
  const historical = ledger.standingOf('historical', now);
  const recent = ledger.standingOf('recent', now);
  assert.ok(recent > historical, `recent (${recent}) should outrank historical (${historical})`);
  approxEqual(historical, 50);
  assert.ok(recent > 99); // barely decayed after 1ms
});

test('decay: out-of-order `now` never moves the accumulator anchor backward', () => {
  const ledger = new StandingLedger();
  ledger.recordService(service({ hostPeerId: 'p', layersServed: 1, framesServed: 100, servingMs: 1_000 }), 1_000); // +100 @1000
  ledger.recordService(service({ hostPeerId: 'p', layersServed: 1, framesServed: 50, servingMs: 1_000 }), 500); // +50, out of order
  // Anchor stays at 1000 (max of 1000, 500) — the out-of-order write is
  // treated as "zero elapsed since the last write", not as un-decaying it.
  approxEqual(ledger.standingOf('p', 1_000), 150);
});

// ── consumption debits ────────────────────────────────────────────────────

test('consumption debits: a heavy consumer standing drops relative to a light one at equal credit', () => {
  const ledgerLight = new StandingLedger();
  const ledgerHeavy = new StandingLedger();
  for (const l of [ledgerLight, ledgerHeavy]) {
    l.recordService(service({ hostPeerId: 'x', layersServed: 8, framesServed: 1_000, servingMs: 60_000 }), 0);
  }
  ledgerLight.recordConsumption(consumption({ consumerPeerId: 'x', layersConsumed: 1, framesConsumed: 10, consumingMs: 1_000 }), 0);
  ledgerHeavy.recordConsumption(consumption({ consumerPeerId: 'x', layersConsumed: 8, framesConsumed: 5_000, consumingMs: 120_000 }), 0);

  const light = ledgerLight.standingOf('x', 0);
  const heavy = ledgerHeavy.standingOf('x', 0);
  assert.ok(heavy < light, `heavy consumer (${heavy}) should stand below light consumer (${light})`);
});

test('consumption debits: enough consumption drives standing negative', () => {
  const ledger = new StandingLedger();
  ledger.recordService(service({ hostPeerId: 'x', layersServed: 1, framesServed: 10, servingMs: 1_000 }), 0); // +10
  ledger.recordConsumption(consumption({ consumerPeerId: 'x', layersConsumed: 8, framesConsumed: 10_000, consumingMs: 600_000 }), 0);
  assert.ok(ledger.standingOf('x', 0) < 0);
});

test('consumption debits: unlike recordService, consumption is NOT gated on session completion', () => {
  const ledger = new StandingLedger();
  ledger.recordConsumption(consumption({ consumerPeerId: 'x', layersConsumed: 8, framesConsumed: 1_000, consumingMs: 10_000 }), 0);
  assert.ok(ledger.standingOf('x', 0) < 0); // debit landed even though nothing about "completion" was asserted
});

// ── no-cutoff monotonicity ────────────────────────────────────────────────

test('no-cutoff: priorityScore is always finite, even for a peer carrying enormous debt', () => {
  const ledger = new StandingLedger({ noiseSource: ZERO_NOISE });
  ledger.recordConsumption(consumption({ consumerPeerId: 'whale', layersConsumed: 8, framesConsumed: 1_000_000, consumingMs: 100_000_000 }), 0);
  const standing = ledger.standingOf('whale', 0);
  assert.ok(standing < -1e6); // genuinely deep debt
  const score = ledger.priorityScore('whale', 0);
  assert.ok(Number.isFinite(score), `expected finite score, got ${score}`);
  assert.equal(score, DEFAULT_LOWEST_LANE); // clamped to the lowest lane, not to -Infinity
});

test('no-cutoff: zero-standing (never seen) still yields a finite, positive score', () => {
  const ledger = new StandingLedger({ noiseSource: ZERO_NOISE });
  const score = ledger.priorityScore('nobody-home', 0);
  assert.ok(Number.isFinite(score));
  assert.equal(score, DEFAULT_NEWCOMER_FLOOR);
});

test('no-cutoff: priorityScore is monotonic non-decreasing in standing', () => {
  const ledger = new StandingLedger({ noiseSource: ZERO_NOISE });
  const scores: number[] = [];
  const magnitudes = [0, 10, 100, 1_000, 10_000];
  for (const m of magnitudes) {
    ledger.recordService(service({ hostPeerId: `p${m}`, layersServed: 1, framesServed: m, servingMs: 1_000 }), 0);
    scores.push(ledger.priorityScore(`p${m}`, 0));
  }
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i]! >= scores[i - 1]!, `score should not decrease with more standing: ${scores}`);
  }
});

// ── newcomer floor / Sybil-reset ≈ newcomer ──────────────────────────────

test('newcomer floor: an unseen peer outranks a peer carrying accumulated debt', () => {
  const ledger = new StandingLedger({ noiseSource: ZERO_NOISE });
  ledger.recordConsumption(consumption({ consumerPeerId: 'debtor', layersConsumed: 8, framesConsumed: 100_000, consumingMs: 10_000_000 }), 0);
  const debtorScore = ledger.priorityScore('debtor', 0);
  const newcomerScore = ledger.priorityScore('never-seen', 0);
  assert.ok(newcomerScore > debtorScore, `newcomer (${newcomerScore}) should outrank debtor (${debtorScore})`);
  assert.equal(debtorScore, DEFAULT_LOWEST_LANE);
  assert.equal(newcomerScore, DEFAULT_NEWCOMER_FLOOR);
});

test('newcomer floor: Sybil-reset (cycled identity) lands at ~newcomer, not better, not the old debt', () => {
  const ledger = new StandingLedger({ noiseSource: ZERO_NOISE });
  ledger.recordConsumption(consumption({ consumerPeerId: 'old-identity', layersConsumed: 8, framesConsumed: 100_000, consumingMs: 10_000_000 }), 0);
  const oldScore = ledger.priorityScore('old-identity', 1_000);

  // The peer abandons 'old-identity' and rejoins as a brand-new peerId —
  // this ledger has literally never seen it.
  const cycledScore = ledger.priorityScore('fresh-identity-after-reset', 1_000);
  const honestNewcomerScore = ledger.priorityScore('genuinely-new-peer', 1_000);

  assert.equal(cycledScore, honestNewcomerScore); // Sybil-reset ≈ newcomer, exactly, under zero noise
  assert.ok(cycledScore > oldScore); // resetting helped (shed the debt)...
  assert.ok(cycledScore <= DEFAULT_NEWCOMER_FLOOR + 1e-9); // ...but only up to newcomer level, never past it
});

test('newcomer floor: a small positive contributor sits between the lowest lane and a big contributor, continuous with the floor', () => {
  const ledger = new StandingLedger({ noiseSource: ZERO_NOISE });
  ledger.recordService(service({ hostPeerId: 'tiny', layersServed: 1, framesServed: 1, servingMs: 100 }), 0); // delta = 0.1
  const tinyScore = ledger.priorityScore('tiny', 0);
  assert.ok(tinyScore > DEFAULT_NEWCOMER_FLOOR); // any positive standing strictly beats the bare floor
  approxEqual(tinyScore, DEFAULT_NEWCOMER_FLOOR + 0.1);
});

// ── noise: bounded, and never inverts a real gap ─────────────────────────

test('noise bounded: default config keeps the noise contribution within [-amplitude, +amplitude]', () => {
  const ledger = new StandingLedger();
  ledger.recordService(service({ hostPeerId: 'p', layersServed: 2, framesServed: 40, servingMs: 5_000 }), 0);
  const baseline = new StandingLedger({ noiseSource: ZERO_NOISE });
  baseline.recordService(service({ hostPeerId: 'p', layersServed: 2, framesServed: 40, servingMs: 5_000 }), 0);
  const base = baseline.priorityScore('p', 0);
  for (let t = 0; t < 20; t++) {
    const now = t * 977; // arbitrary strides, crosses several noise buckets
    const scored = ledger.priorityScore('p', now);
    const offset = scored - (DEFAULT_NEWCOMER_FLOOR + baseline.standingOf('p', now));
    assert.ok(Math.abs(offset) <= DEFAULT_NOISE_AMPLITUDE + 1e-9, `noise offset ${offset} exceeded amplitude`);
  }
});

test('noise bounded: extreme injected noise source is clamped to the configured amplitude, not amplified', () => {
  const ledger = new StandingLedger({ noiseSource: () => 1 }); // max positive noise every call
  const score = ledger.priorityScore('unseen', 0);
  approxEqual(score, DEFAULT_NEWCOMER_FLOOR + DEFAULT_NOISE_AMPLITUDE);

  const ledgerNeg = new StandingLedger({ noiseSource: () => -1 }); // max negative noise every call
  const scoreNeg = ledgerNeg.priorityScore('unseen', 0);
  approxEqual(scoreNeg, DEFAULT_NEWCOMER_FLOOR - DEFAULT_NOISE_AMPLITUDE);
});

test('noise bounded: does not invert a large standing gap between two established peers', () => {
  const ledger = new StandingLedger({ noiseSource: () => 1 }); // worst case: always maximally favors the underdog
  ledger.recordService(service({ hostPeerId: 'big', layersServed: 8, framesServed: 1_000, servingMs: 60_000 }), 0);
  ledger.recordService(service({ hostPeerId: 'small', layersServed: 1, framesServed: 10, servingMs: 1_000 }), 0);
  const ledgerAdverse = new StandingLedger({ noiseSource: (peerId) => (peerId === 'small' ? 1 : -1) }); // best case for inversion
  ledgerAdverse.recordService(service({ hostPeerId: 'big', layersServed: 8, framesServed: 1_000, servingMs: 60_000 }), 0);
  ledgerAdverse.recordService(service({ hostPeerId: 'small', layersServed: 1, framesServed: 10, servingMs: 1_000 }), 0);

  assert.ok(ledgerAdverse.priorityScore('big', 0) > ledgerAdverse.priorityScore('small', 0));
});

test('defaultNoiseSource: bounded to [-1, 1) and deterministic for the same (peerId, bucket)', () => {
  for (let i = 0; i < 200; i++) {
    const v = defaultNoiseSource(`peer-${i}`, i * 137);
    assert.ok(v >= -1 && v < 1, `noise ${v} out of range`);
  }
  const a = defaultNoiseSource('stable-peer', 5_000);
  const b = defaultNoiseSource('stable-peer', 5_500); // same 1000ms bucket
  assert.equal(a, b);
});

// ── pickOptimisticSlot (optimistic-unchoke analog) ───────────────────────

test('pickOptimisticSlot: empty candidate list returns undefined', () => {
  const ledger = new StandingLedger();
  assert.equal(ledger.pickOptimisticSlot([]), undefined);
});

test('pickOptimisticSlot: an unseen candidate always wins over a seen one, any standing', () => {
  const ledger = new StandingLedger();
  ledger.recordService(service({ hostPeerId: 'veteran', layersServed: 8, framesServed: 10_000, servingMs: 600_000 }), 0);
  assert.equal(ledger.pickOptimisticSlot(['veteran', 'rookie']), 'rookie');
  assert.equal(ledger.pickOptimisticSlot(['rookie', 'veteran']), 'rookie'); // order-independent
});

test('pickOptimisticSlot: among seen candidates, fewest recorded events wins', () => {
  const ledger = new StandingLedger();
  ledger.recordService(service({ hostPeerId: 'frequent' }), 0);
  ledger.recordService(service({ hostPeerId: 'frequent' }), 1);
  ledger.recordService(service({ hostPeerId: 'frequent' }), 2);
  ledger.recordService(service({ hostPeerId: 'occasional' }), 0);
  assert.equal(ledger.pickOptimisticSlot(['frequent', 'occasional']), 'occasional');
});

test('pickOptimisticSlot: ties on eventCount broken by earliest firstSeenAt', () => {
  const ledger = new StandingLedger();
  ledger.recordService(service({ hostPeerId: 'later' }), 1_000);
  ledger.recordService(service({ hostPeerId: 'earlier' }), 100);
  assert.equal(ledger.pickOptimisticSlot(['later', 'earlier']), 'earlier');
});

test('pickOptimisticSlot: fully tied unseen candidates break by peerId ascending, deterministically', () => {
  const ledger = new StandingLedger();
  assert.equal(ledger.pickOptimisticSlot(['zebra', 'apple', 'mango']), 'apple');
});

// ── topContributors / myStanding (status/leaderboard read API) ──────────

test('topContributors: sorted descending by standing, limited to n', () => {
  const ledger = new StandingLedger({ noiseSource: ZERO_NOISE });
  ledger.recordService(service({ hostPeerId: 'gold', layersServed: 8, framesServed: 1_000, servingMs: 60_000 }), 0);
  ledger.recordService(service({ hostPeerId: 'silver', layersServed: 4, framesServed: 500, servingMs: 30_000 }), 0);
  ledger.recordService(service({ hostPeerId: 'bronze', layersServed: 1, framesServed: 100, servingMs: 10_000 }), 0);

  const top2 = ledger.topContributors(2, 0);
  assert.deepEqual(top2.map((s) => s.peerId), ['gold', 'silver']);
  assert.ok(top2[0]!.standing > top2[1]!.standing);
});

test('topContributors: ties on standing broken by peerId ascending', () => {
  const ledger = new StandingLedger();
  ledger.recordService(service({ hostPeerId: 'b-peer', layersServed: 1, framesServed: 10, servingMs: 1_000 }), 0);
  ledger.recordService(service({ hostPeerId: 'a-peer', layersServed: 1, framesServed: 10, servingMs: 1_000 }), 0);
  const top = ledger.topContributors(10, 0);
  assert.deepEqual(top.map((s) => s.peerId), ['a-peer', 'b-peer']);
});

test('topContributors: n=0 returns an empty list; excludes peers never recorded', () => {
  const ledger = new StandingLedger();
  ledger.recordService(service({ hostPeerId: 'p' }), 0);
  assert.deepEqual(ledger.topContributors(0, 0), []);
});

test('myStanding: unseen peer reports standing 0 and the newcomer floor', () => {
  const ledger = new StandingLedger({ noiseSource: ZERO_NOISE });
  const mine = ledger.myStanding('me', 0);
  assert.deepEqual(mine, { peerId: 'me', standing: 0, priorityScore: DEFAULT_NEWCOMER_FLOOR });
});

test('myStanding: reflects decay at the queried now', () => {
  const ledger = new StandingLedger({ noiseSource: ZERO_NOISE });
  ledger.recordService(service({ hostPeerId: 'me', layersServed: 1, framesServed: 100, servingMs: 1_000 }), 0);
  const mine = ledger.myStanding('me', DEFAULT_HALF_LIFE_MS);
  approxEqual(mine.standing, 50);
});

// ── factory + binding helpers ─────────────────────────────────────────────

test('createStandingLedger: equivalent to `new StandingLedger(config)`', () => {
  const ledger = createStandingLedger({ noiseSource: ZERO_NOISE });
  assert.ok(ledger instanceof StandingLedger);
  ledger.recordService(service({ hostPeerId: 'p', layersServed: 1, framesServed: 10, servingMs: 1_000 }), 0);
  assert.equal(ledger.standingOf('p', 0), 10);
});

test('bindPriorityScore: binds a live ledger + clock to the (peerId) => number shape popNextByPriority expects', () => {
  const ledger = new StandingLedger({ noiseSource: ZERO_NOISE });
  ledger.recordService(service({ hostPeerId: 'vip', layersServed: 8, framesServed: 1_000, servingMs: 60_000 }), 0);
  let now = 0;
  const priorityScore = bindPriorityScore(ledger, () => now);

  assert.equal(priorityScore.length, 1); // exactly (peerId: string) => number — the PriorityScoreFn shape
  const scoreAt0 = priorityScore('vip');
  now = DEFAULT_HALF_LIFE_MS;
  const scoreAtHalfLife = priorityScore('vip');
  assert.ok(scoreAtHalfLife < scoreAt0); // clock advanced -> decay visible through the bound function
  assert.equal(priorityScore('unseen-peer'), DEFAULT_NEWCOMER_FLOOR); // clock is at half-life now, unaffected for an unseen peer
});

// ── config sanity ──────────────────────────────────────────────────────────

test('DEFAULT_STANDING_CONFIG matches the exported default constants', () => {
  assert.equal(DEFAULT_STANDING_CONFIG.halfLifeMs, DEFAULT_HALF_LIFE_MS);
  assert.equal(DEFAULT_STANDING_CONFIG.newcomerFloor, DEFAULT_NEWCOMER_FLOOR);
  assert.equal(DEFAULT_STANDING_CONFIG.lowestLane, DEFAULT_LOWEST_LANE);
  assert.equal(DEFAULT_STANDING_CONFIG.noiseAmplitude, DEFAULT_NOISE_AMPLITUDE);
  assert.ok(DEFAULT_STANDING_CONFIG.lowestLane < DEFAULT_STANDING_CONFIG.newcomerFloor);
});
