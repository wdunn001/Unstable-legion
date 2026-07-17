import test from 'node:test';
import assert from 'node:assert/strict';
import {
  communalLayerCountLabel,
  claimLayerCount,
  claimLayerCountLabel,
  downloadProgressFraction,
  assembledLayerCount,
  downloadProgressLabel,
  deriveHostingLifecycleState,
  hostingStatusLabel,
} from '../src/hostingLabels.ts';

// ── Layer-count labels ────────────────────────────────────────────────

test('communalLayerCountLabel: pluralizes correctly and never renders a raw range', () => {
  assert.equal(communalLayerCountLabel(34), '34 communal layers');
  assert.equal(communalLayerCountLabel(1), '1 communal layer');
  assert.doesNotMatch(communalLayerCountLabel(34), /\d+–\d+/);
});

test('claimLayerCount / claimLayerCountLabel: half-open range collapses to a plain count, never the raw exclusive-end pair', () => {
  const claim = { layerStart: 2, layerEnd: 36 };
  assert.equal(claimLayerCount(claim), 34);
  assert.equal(claimLayerCountLabel(claim), '34 layers');
  assert.doesNotMatch(claimLayerCountLabel(claim), /2.*36/);
});

test('claimLayerCountLabel: singular for a 1-layer claim', () => {
  assert.equal(claimLayerCountLabel({ layerStart: 5, layerEnd: 6 }), '1 layer');
});

// ── Download progress fraction/labels (layer-scaled, never raw shard counts) ──

test('downloadProgressFraction: byte-based when totalBytes is known', () => {
  const f = downloadProgressFraction({ shardsFetched: 3, totalShards: 36, bytesFetched: 2_350_000_000, totalBytes: 4_700_000_000 });
  assert.ok(Math.abs(f - 0.5) < 1e-9);
});

test('downloadProgressFraction: falls back to shard-count-based when totalBytes is absent', () => {
  const f = downloadProgressFraction({ shardsFetched: 9, totalShards: 36, bytesFetched: 0, totalBytes: undefined });
  assert.ok(Math.abs(f - 0.25) < 1e-9);
});

test('downloadProgressFraction: clamped to [0,1] and safe against totalShards=0', () => {
  assert.equal(downloadProgressFraction({ shardsFetched: 0, totalShards: 0, bytesFetched: 0 }), 0);
});

test('assembledLayerCount: scales the byte fraction onto the LAYER domain, not the raw 36-fragment domain', () => {
  // 18/34 layers worth of progress, expressed via a 36-fragment/4.7GB backing signal.
  const progress = { shardsFetched: 19, totalShards: 36, bytesFetched: 2_350_000_000, totalBytes: 4_700_000_000 }; // 50% bytes
  assert.equal(assembledLayerCount(progress, 34), 17); // round(0.5 * 34) = 17
});

test('assembledLayerCount: never exceeds layerCount even at 100%+ fraction', () => {
  const progress = { shardsFetched: 36, totalShards: 36, bytesFetched: 5_000_000_000, totalBytes: 4_700_000_000 };
  assert.equal(assembledLayerCount(progress, 34), 34);
});

test('downloadProgressLabel: reports "X of N layers", NEVER the raw shard/fragment numerator or the 36-count', () => {
  const progress = { shardsFetched: 19, totalShards: 36, bytesFetched: 2_350_000_000, totalBytes: 4_700_000_000 };
  const label = downloadProgressLabel(progress, 34);
  assert.equal(label, 'Downloading model: 17 of 34 layers (2.4GB of ~4.7GB)');
  assert.doesNotMatch(label, /36/, 'must never leak the raw fragment total (metadata+output+layers)');
  assert.doesNotMatch(label, /19/, 'must never leak the raw fragment numerator');
});

test('downloadProgressLabel: falls back to layer-count-only phrasing when totalBytes is unknown', () => {
  const progress = { shardsFetched: 1, totalShards: 1, bytesFetched: 500, totalBytes: undefined };
  assert.equal(downloadProgressLabel(progress, 1), 'Downloading model: 1 of 1 layer');
});

// ── Hosting lifecycle state machine ──────────────────────────────────────

test('deriveHostingLifecycleState: off when hosting is not enabled, regardless of phase', () => {
  assert.equal(deriveHostingLifecycleState({ hostingEnabled: false, phase: 'active' }), 'off');
});

test('deriveHostingLifecycleState: idle when enabled but no claim/loading has started yet', () => {
  assert.equal(deriveHostingLifecycleState({ hostingEnabled: true, phase: 'idle' }), 'idle');
});

test('deriveHostingLifecycleState: downloading while shards are still in flight', () => {
  assert.equal(
    deriveHostingLifecycleState({
      hostingEnabled: true,
      phase: 'loading',
      claim: { layerStart: 2, layerEnd: 36 },
      downloadProgress: { shardsFetched: 5, totalShards: 36 },
    }),
    'downloading',
  );
});

test('deriveHostingLifecycleState: downloading (not opening) when no progress event has arrived yet', () => {
  assert.equal(deriveHostingLifecycleState({ hostingEnabled: true, phase: 'loading', claim: { layerStart: 2, layerEnd: 36 } }), 'downloading');
});

test('deriveHostingLifecycleState: opening once every shard is fetched but the stage is not yet active', () => {
  assert.equal(
    deriveHostingLifecycleState({
      hostingEnabled: true,
      phase: 'loading',
      claim: { layerStart: 2, layerEnd: 36 },
      downloadProgress: { shardsFetched: 36, totalShards: 36 },
    }),
    'opening',
  );
});

test('deriveHostingLifecycleState: hosting once the phase reports active', () => {
  assert.equal(
    deriveHostingLifecycleState({ hostingEnabled: true, phase: 'active', claim: { layerStart: 2, layerEnd: 36 } }),
    'hosting',
  );
});

test('deriveHostingLifecycleState: hosting also covers draining (still serving existing sessions)', () => {
  assert.equal(deriveHostingLifecycleState({ hostingEnabled: true, phase: 'draining' }), 'hosting');
});

test('deriveHostingLifecycleState: retrying and error phases map directly', () => {
  assert.equal(deriveHostingLifecycleState({ hostingEnabled: true, phase: 'retrying' }), 'retrying');
  assert.equal(deriveHostingLifecycleState({ hostingEnabled: true, phase: 'error' }), 'error');
});

test('deriveHostingLifecycleState: full realistic sequence never says "hosting" before phase active', () => {
  const sequence: HostingLifecycleTestStep[] = [
    { hostingEnabled: true, phase: 'idle' },
    { hostingEnabled: true, phase: 'loading', claim: { layerStart: 2, layerEnd: 36 }, downloadProgress: { shardsFetched: 1, totalShards: 36 } },
    { hostingEnabled: true, phase: 'loading', claim: { layerStart: 2, layerEnd: 36 }, downloadProgress: { shardsFetched: 20, totalShards: 36 } },
    { hostingEnabled: true, phase: 'loading', claim: { layerStart: 2, layerEnd: 36 }, downloadProgress: { shardsFetched: 36, totalShards: 36 } },
    { hostingEnabled: true, phase: 'active', claim: { layerStart: 2, layerEnd: 36 } },
  ];
  const states = sequence.map(deriveHostingLifecycleState);
  assert.deepEqual(states, ['idle', 'downloading', 'downloading', 'opening', 'hosting']);
  assert.equal(states.indexOf('hosting'), states.length - 1, 'hosting must only be reached at the very end');
});

type HostingLifecycleTestStep = Parameters<typeof deriveHostingLifecycleState>[0];

// ── hostingStatusLabel: the word "Hosting" is earned, never premature ──

test('hostingStatusLabel: never says "Hosting" for downloading/opening/idle/off', () => {
  const capacityPreviewLabel = 'up to 34 of 34 layers (~8.0GB)';
  for (const state of ['off', 'idle', 'downloading', 'opening', 'retrying', 'error'] as const) {
    const label = hostingStatusLabel(state, { capacityPreviewLabel });
    assert.doesNotMatch(label, /^Hosting/, `state ${state} must not say "Hosting"`);
  }
});

test('hostingStatusLabel: hosting state names the claimed layer count', () => {
  const label = hostingStatusLabel('hosting', { claim: { layerStart: 2, layerEnd: 36 }, capacityPreviewLabel: 'up to 34 of 34 layers (~8.0GB)' });
  assert.equal(label, 'Hosting 34 layers');
});

test('hostingStatusLabel: idle state offers the capacity preview without claiming to already be hosting', () => {
  const label = hostingStatusLabel('idle', { capacityPreviewLabel: 'up to 34 of 34 layers (~8.0GB)' });
  assert.equal(label, 'Ready to host — up to 34 of 34 layers (~8.0GB)');
});

test('deriveHostingLifecycleState: a re-download while already hosting reports downloading, NOT hosting', () => {
  // The bug this locks down: raising the layer budget makes the host re-claim
  // a bigger range and start fetching, but useCommunalHost flips `phase` back
  // to 'active' (the PREVIOUS stage is still loaded + advertised). A
  // phase-first check rendered "Hosting N layers" with no progress bar while
  // gigabytes silently re-downloaded. Any time bytes are moving, say so.
  assert.equal(
    deriveHostingLifecycleState({
      hostingEnabled: true,
      phase: 'active',
      claim: { layerStart: 2, layerEnd: 13 },
      downloadProgress: { shardsFetched: 3, totalShards: 12 },
    }),
    'downloading',
  );
  // Same for the native-open tail of that re-load.
  assert.equal(
    deriveHostingLifecycleState({
      hostingEnabled: true,
      phase: 'active',
      claim: { layerStart: 2, layerEnd: 13 },
      downloadProgress: { shardsFetched: 12, totalShards: 12 },
    }),
    'opening',
  );
});

test('deriveHostingLifecycleState: still "hosting" once the load settles (progress cleared)', () => {
  // useStageHost clears loadProgress when a load settles, so absence — not a
  // stale final value — is what lets 'hosting' win again.
  assert.equal(
    deriveHostingLifecycleState({
      hostingEnabled: true,
      phase: 'active',
      claim: { layerStart: 2, layerEnd: 13 },
      downloadProgress: undefined,
    }),
    'hosting',
  );
});
