/**
 * CommunalHostPanel — M3 demo UI. "Contribute to the communal pipeline"
 * toggle -> `useCommunalHost` (this peer's self-assembly loop decides what
 * layer range to claim, loads it proactively, and serves whichever driver
 * later opens a session against it via `stage.session.open`).
 *
 * Deliberately separate from `StagePipelinePanel` (Phase C's
 * driver-plans-everything model) — this panel has no "run inference"
 * control at all; a communal host's only job is to show up and host.
 *
 * `window.__legionCommunal` is populated for Playwright/manual debugging,
 * mirroring `StagePipelinePanel`'s `window.__legionStage` convention.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  useCommunalHost,
  useMeshContext,
  useMeshRoster,
  bindPriorityScore,
  type MeshPeerCap,
  type StandingLedger,
} from '@unstable-legion/react';
import {
  STAGE_MODEL_ID,
  STAGE_TOTAL_LAYERS,
  STAGE_DRIVER_LAYERS,
  STAGE_CTX_SIZE,
  STAGE_AVG_LAYER_BYTES,
  stageShardUrls,
} from '@unstable-legion/react';

export interface CommunalHostPanelProps {
  baseCap: Omit<MeshPeerCap, 'stageHost' | 'ts'> & { ts?: number };
  keepaliveEnabled: boolean;
  /** M4 — this peer's shared contribution-economy ledger (one instance per
   * `MeshProvider`, created once in `App.tsx`'s `Dashboard`). Feeds
   * `useStageHost`'s admission-queue priority (via `bindPriorityScore`)
   * and consumption telemetry on every session free. */
  standingLedger: StandingLedger;
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 10)}…` : id;
}

export function CommunalHostPanel(props: CommunalHostPanelProps) {
  const { peer } = useMeshContext();
  const roster = useMeshRoster();
  const [enabled, setEnabled] = useState(false);

  const createStageWorker = useCallback(
    () => new Worker(new URL('../workers/stageWorker.ts', import.meta.url), { type: 'module' }),
    [],
  );
  const fallbackShardUrls = useCallback(() => stageShardUrls(), []);
  const log = useCallback((line: string) => console.info('[communal-host]', line), []);
  const priorityScore = useMemo(() => bindPriorityScore(props.standingLedger, () => Date.now()), [props.standingLedger]);

  const communal = useCommunalHost({
    enabled,
    peer,
    baseCap: props.baseCap,
    createStageWorker,
    modelId: STAGE_MODEL_ID,
    totalLayers: STAGE_TOTAL_LAYERS,
    driverLayers: STAGE_DRIVER_LAYERS,
    ctxSize: STAGE_CTX_SIZE,
    wireDtype: 'f32',
    // No manifestUrl -- this demo deployment ships full.gguf (Phase A/B
    // convention, see stageModelSource.ts), not a Phase C layer-package
    // manifest, for qwen3-0.6b-q8_0. `resolveCommunalShardPlan` falls
    // back to `fallbackShardUrls` cleanly when `manifestUrl` is absent —
    // wiring a real manifest here is a one-line change once one is
    // deployed for this model (see docs/COMMUNAL.md's honest-state note).
    fallbackShardUrls,
    avgLayerBytes: STAGE_AVG_LAYER_BYTES,
    keepaliveEnabled: props.keepaliveEnabled,
    // M4 — admission-queue priority + consumption telemetry (see
    // docs/ECONOMY.md's "Injection story").
    priorityScore,
    standingLedger: props.standingLedger,
    log,
  });

  useEffect(() => {
    (window as unknown as { __legionCommunal?: unknown }).__legionCommunal = {
      selfId: peer?.selfId,
      roster: roster.map((r) => ({ peerId: r.peerId, loadedStages: r.stageHost?.loadedStages ?? [] })),
      communal: {
        supported: communal.supported,
        unsupportedReason: communal.unsupportedReason,
        phase: communal.phase,
        claim: communal.claim,
        active: communal.active,
        sessions: communal.sessions,
        tokensDecoded: communal.tokensDecoded,
        maxSessions: communal.maxSessions,
        queueLength: communal.queueLength,
        lastError: communal.lastError,
      },
    };
  }, [peer, roster, communal]);

  return (
    <section className="sp-panel">
      <h3>
        communal pipeline <span className="sp-model">{STAGE_MODEL_ID}</span>
      </h3>
      <div className="sp-host-row">
        <label className="sp-host-toggle communal-host-toggle">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!communal.supported}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          contribute to communal pipeline{communal.active ? ` — hosting [${communal.claim?.layerStart},${communal.claim?.layerEnd})` : ''}
        </label>
        {!communal.supported && <span className="sp-warn">{communal.unsupportedReason}</span>}
        <span className="ul-muted sp-small">phase: {communal.phase}</span>
        {communal.sessions.length > 0 && (
          <span className="sp-badge">
            serving {communal.sessions.length}/{communal.maxSessions} session(s) · {communal.tokensDecoded} tok
            {communal.queueLength > 0 ? ` · ${communal.queueLength} queued` : ''}
          </span>
        )}
        {communal.lastError && <span className="sp-err">{communal.lastError}</span>}
      </div>
      <div className="ul-muted sp-small">
        {roster.filter((r) => (r.stageHost?.loadedStages?.length ?? 0) > 0 && r.peerId !== peer?.selfId).length} other communal host(s) advertising a
        loaded stage
      </div>
      {roster.some((r) => (r.stageHost?.loadedStages?.length ?? 0) > 0) && (
        <div className="sp-topology">
          <div className="sp-topology-title">mesh coverage (self-reported)</div>
          <ul>
            {roster
              .filter((r) => (r.stageHost?.loadedStages?.length ?? 0) > 0)
              .map((r) =>
                (r.stageHost!.loadedStages ?? []).map((s, i) => (
                  <li key={`${r.peerId}-${i}`}>
                    {shortId(r.peerId)}
                    {r.peerId === peer?.selfId ? ' (you)' : ''} — layers [{s.layerStart},{s.layerEnd}) · {s.activeSessions}/{s.maxSessions} sessions
                    {s.includeOutput ? ' · output' : ''}
                  </li>
                )),
              )}
          </ul>
        </div>
      )}
    </section>
  );
}
