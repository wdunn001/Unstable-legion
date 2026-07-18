/**
 * hostingLabels — pure lifecycle + formatting helpers for the hosting-
 * consent banner and "Contribute more" panel. Split out from the
 * components (same "keep the view-models pure and testable" convention
 * as viewmodels/meshViewModels.ts) so the state machine and label/
 * percentage math are unit-tested directly, without rendering React.
 *
 * ── Why a lifecycle state machine (not just claim-presence) ──────────
 * The hosting panel used to say "Hosting up to 34 of 34 layers (~8 GB)"
 * the MOMENT a claim was made — while the shards were still DOWNLOADING
 * (console showing "shard 2/36 fetched+verified…"). That's misleading:
 * the browser isn't hosting anything yet, it's trying to.
 * `deriveHostingLifecycleState` turns the real signals (`hostingEnabled`,
 * `useCommunalHost`'s `phase`, `claim`, `useStageHost`'s per-shard
 * `downloadProgress`) into ONE lifecycle state, and `hostingStatusLabel`
 * renders that state's copy — the word "Hosting" only ever appears once
 * the stage is genuinely loaded and advertising/serving.
 *
 * ── Why layer counts, never raw shard/fragment counts ─────────────────
 * The wasm loader's per-shard progress (`shardsFetched`/`totalShards`)
 * counts GGUF FRAGMENTS, not transformer layers — the fragment list
 * includes `shared/metadata.gguf` and (on the final host) `shared/
 * output.gguf` alongside the actual per-layer fragments, so e.g. a 34-
 * layer claim fetches 36 fragments. Surfacing that raw "36" reads as the
 * model's total layer count (it isn't — Qwen3-8B has 36 layers total,
 * 2 of which run locally as the driver, leaving 34 communal — an
 * unrelated coincidence of numbers that's actively confusing). Every
 * user-facing progress readout here is expressed in LAYER units instead
 * — `assembledLayerCount` scales the real byte-progress fraction onto
 * the claim's layer-count domain — while the byte/GB readout stays the
 * real total (correctly including that small metadata/output overhead).
 */
import type { StageWorkerLoadProgress, CommunalHostPhase } from '@unstable-legion/react';

// ── Layer-count labels (no raw half-open ranges) ─────────────────────────

/** "N communal layers" — replaces a raw half-open `[driverLayers,
 * totalLayers)` range (e.g. "layers 2–36") that reads as an off-by-one to
 * anyone not already fluent in half-open interval notation. */
export function communalLayerCountLabel(communalLayerCount: number): string {
  return `${communalLayerCount} communal layer${communalLayerCount === 1 ? '' : 's'}`;
}

/** "N layers" for a specific claimed range (this host's OWN claim, which
 * may cover only part of the communal space) — same count-only phrasing. */
export function claimLayerCount(claim: { layerStart: number; layerEnd: number }): number {
  return Math.max(0, claim.layerEnd - claim.layerStart);
}

export function claimLayerCountLabel(claim: { layerStart: number; layerEnd: number }): string {
  const count = claimLayerCount(claim);
  return `${count} layer${count === 1 ? '' : 's'}`;
}

// ── Download progress ─────────────────────────────────────────────────

type ProgressLike = Pick<StageWorkerLoadProgress, 'shardsFetched' | 'totalShards' | 'bytesFetched' | 'totalBytes'>;

/** 0-1 fraction of REAL bytes/shards done — byte-based when every shard
 * declared a size (`totalBytes` present), falling back to shard-count-
 * based otherwise. This is the underlying fraction every layer-count and
 * bar-width readout below scales onto its own display domain; it is
 * itself never shown to a user directly (it's fragment-based, not
 * layer-based — see module doc). Clamped to [0, 1]. */
export function downloadProgressFraction(progress: ProgressLike): number {
  if (progress.totalShards <= 0) return 0;
  const fraction =
    progress.totalBytes && progress.totalBytes > 0 ? progress.bytesFetched / progress.totalBytes : progress.shardsFetched / progress.totalShards;
  return Math.max(0, Math.min(1, fraction));
}

/** Scales progress onto a LAYER count so the user only ever sees "X of N
 * layers", never a raw fragment count that includes non-layer artifacts
 * (metadata/output). `layerCount` should be the count for WHATEVER is being
 * fetched right now (a claim's layer count, or the communal-layer total).
 *
 * Scales by the SHARD fraction, NOT the byte fraction: each shard is roughly
 * one layer, so this discrete counter tracks COMPLETED shards and lines up
 * with the host's console shard log ("shard 5/38"). (The bar %/byte readout
 * stay byte-based — bytes are the honest continuous download progress, but
 * they LAG the shard count because the embeddings/output shards are far
 * larger than any single layer, which made this counter read one behind.) */
export function assembledLayerCount(progress: ProgressLike, layerCount: number): number {
  if (layerCount <= 0 || progress.totalShards <= 0) return 0;
  const shardFraction = Math.max(0, Math.min(1, progress.shardsFetched / progress.totalShards));
  return Math.max(0, Math.min(layerCount, Math.round(shardFraction * layerCount)));
}

function formatGigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)}GB`;
}

/** "Downloading model: 18 of 34 layers (2.1 of ~4.7 GB)" — the label
 * shown above/inside the download-progress bar. `layerCount` is the
 * layer count for whatever's being fetched (normally the current claim's
 * layer count). Falls back to layer-count-only phrasing when
 * `totalBytes` isn't known (the streamed/unhashed path). */
export function downloadProgressLabel(progress: ProgressLike, layerCount: number): string {
  const layers = assembledLayerCount(progress, layerCount);
  const layersPart = `${layers} of ${layerCount} layer${layerCount === 1 ? '' : 's'}`;
  if (progress.totalBytes && progress.totalBytes > 0) {
    return `Downloading model: ${layersPart} (${formatGigabytes(progress.bytesFetched)} of ~${formatGigabytes(progress.totalBytes)})`;
  }
  return `Downloading model: ${layersPart}`;
}

/** Shared byte-formatting for the coverage card's own "assembling" copy
 * (meshViewModels.ts) — kept here so both call sites format bytes
 * identically instead of drifting. */
export { formatGigabytes };

// ── Hosting-status lifecycle state machine ────────────────────────────

export type HostingLifecycleState = 'off' | 'idle' | 'downloading' | 'opening' | 'hosting' | 'retrying' | 'error';

export interface HostingLifecycleInputs {
  hostingEnabled: boolean;
  phase: CommunalHostPhase;
  claim?: { layerStart: number; layerEnd: number };
  downloadProgress?: Pick<StageWorkerLoadProgress, 'shardsFetched' | 'totalShards' | 'phase'>;
}

/**
 * Pure derivation — no React, no timers.
 *
 * An IN-FLIGHT LOAD IS AUTHORITATIVE, checked before `phase`: if bytes are
 * moving, say so, whatever the phase claims. This matters because `phase`
 * lies during a re-load — when a user raises their layer budget, the host
 * re-claims a bigger range and starts fetching, but `useCommunalHost` flips
 * `phase` straight back to 'active' (the PREVIOUS stage is still loaded and
 * advertised), so a phase-first check rendered "Hosting 11 layers" with no
 * bar while it silently re-downloaded gigabytes. The rule is simply: any
 * time we're downloading, show that we're downloading.
 *
 * This relies on `useStageHost` clearing `loadProgress` when a load settles,
 * so its presence means "loading right now" and never a stale leftover.
 * 'downloading' (shards still in flight) vs 'opening' (every shard fetched;
 * native `legion_stage_open` still running) uses the same shard counts the
 * bar renders. The word "hosting" is reachable ONLY via the 'hosting' state —
 * never while merely claimed-and-loading.
 */
export function deriveHostingLifecycleState(inputs: HostingLifecycleInputs): HostingLifecycleState {
  if (!inputs.hostingEnabled) return 'off';
  if (inputs.phase === 'error') return 'error';
  if (inputs.phase === 'retrying') return 'retrying';
  const p = inputs.downloadProgress;
  if (p && p.totalShards > 0) {
    // The loader's own phase is authoritative. Falling back to shard counts
    // is what made a CACHE-WARM load read "Downloading model…" for minutes:
    // every shard is resident almost instantly and the real wait is the VRAM
    // upload, which the counts cannot see.
    if (p.phase) return p.phase;
    return p.shardsFetched < p.totalShards ? 'downloading' : 'opening';
  }
  if (inputs.phase === 'active' || inputs.phase === 'draining') return 'hosting';
  // Claimed and loading, but no shard tick has landed yet.
  if (inputs.phase === 'loading') return 'downloading';
  return 'idle'; // enabled, no claim assigned yet
}

/** The single short status word/phrase shown next to the hosting toggle —
 * detail (shard/byte progress) belongs in the separate progress bar, not
 * duplicated here. `capacityPreviewLabel` should already read like
 * "up to 34 of 34 layers (~8GB)" (no leading "Hosting" — this function
 * supplies that word only for the states that have earned it). */
export function hostingStatusLabel(
  state: HostingLifecycleState,
  inputs: { claim?: { layerStart: number; layerEnd: number }; capacityPreviewLabel: string },
): string {
  switch (state) {
    case 'off':
      return '(off)';
    case 'idle':
      return `Ready to host — ${inputs.capacityPreviewLabel}`;
    case 'downloading':
      return 'Downloading model…';
    case 'opening':
      return 'Loading into GPU…';
    case 'hosting':
      return inputs.claim ? `Hosting ${claimLayerCountLabel(inputs.claim)}` : `Hosting ${inputs.capacityPreviewLabel}`;
    case 'retrying':
      return '(retrying…)';
    case 'error':
      return '(failing)';
  }
}
