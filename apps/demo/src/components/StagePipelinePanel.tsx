/**
 * StagePipelinePanel — Phase C demo UI. Two roles live in the mesh at
 * once, gated independently:
 *
 *   - "Host stages" toggle -> `useStageHost` (this peer answers
 *     `stage.load`/`sf` from whichever peer is currently driving).
 *   - "run split inference" -> `useStagePipeline` (this peer becomes the
 *     driver: plans across the roster's stage-hosting peers, hosts stage
 *     0 locally, streams tokens back).
 *
 * A single peer can do both (a driver hosting its own remote fallback
 * isn't meaningful here, but nothing stops an operator from toggling
 * both on to see the roster from every angle) — the demo doesn't
 * prevent it, matching the "no hardcoded roles" spirit of the rest of
 * this app.
 *
 * `window.__legionStage` is populated for Playwright/manual debugging —
 * see apps/demo/e2e/*.spec.ts.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  useMeshContext,
  useMeshRoster,
  useStageHost,
  useStagePipeline,
  type MeshPeerCap,
} from '@unstable-legion/react';

export interface StagePipelinePanelProps {
  /** This peer's cap minus `stageHost` — same object the app feeds
   * `MeshProvider`, so `useStageHost` can layer `stageHost` on top of it. */
  baseCap: Omit<MeshPeerCap, 'stageHost' | 'ts'> & { ts?: number };
  keepaliveEnabled: boolean;
}

const DEFAULT_PROMPT = 'Tell me a short story about a lighthouse keeper who talks to ships.';

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 10)}…` : id;
}

export function StagePipelinePanel(props: StagePipelinePanelProps) {
  const { peer } = useMeshContext();
  const roster = useMeshRoster();
  const [hostingEnabled, setHostingEnabled] = useState(false);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);

  // Same worker script backs both roles — each call returns a FRESH
  // worker instance (neither hook holds onto this factory's return
  // value across calls), so one stable factory covers both.
  const createStageWorker = useCallback(
    () => new Worker(new URL('../workers/stageWorker.ts', import.meta.url), { type: 'module' }),
    [],
  );

  // Stable identities — `useStageHost`'s internal ref-capture (see that
  // hook's `logRef` doc comment) already defends against an unstable
  // logger tearing down an in-flight worker load, but passing a fresh
  // arrow function on every render is still a footgun (any future effect
  // that lists `log` in its deps reintroduces the bug) and costs nothing
  // to avoid.
  const logStageHost = useCallback((line: string) => console.info('[stage-host]', line), []);
  const logStagePipeline = useCallback((line: string) => console.info('[stage-pipeline]', line), []);

  const host = useStageHost({
    enabled: hostingEnabled,
    peer,
    baseCap: props.baseCap,
    createStageWorker,
    keepaliveEnabled: props.keepaliveEnabled,
    log: logStageHost,
  });

  const pipeline = useStagePipeline({
    peer,
    createStageWorker,
    log: logStagePipeline,
  });

  // Debug surface for Playwright + manual console poking. Cheap to keep
  // in prod too (no PII, mirrors the existing `window.__legion_debug` pattern).
  useEffect(() => {
    (window as unknown as { __legionStage?: unknown }).__legionStage = {
      selfId: peer?.selfId,
      roster: roster.map((r) => ({ peerId: r.peerId, hasStageHost: !!r.stageHost, nick: r.nick })),
      host: {
        active: host.active,
        sessions: host.sessions,
        tokensDecoded: host.tokensDecoded,
        maxSessions: host.maxSessions,
        queueLength: host.queueLength,
        lastError: host.lastError,
      },
      pipeline: {
        status: pipeline.status,
        plan: pipeline.plan,
        tokens: pipeline.tokens,
        text: pipeline.text,
        tpotMs: pipeline.tpotMs,
        restartCount: pipeline.restartCount,
        readyStageIndexes: pipeline.readyStageIndexes,
      },
    };
  }, [peer, roster, host, pipeline]);

  const stageHostPeerCount = useMemo(() => roster.filter((r) => !!r.stageHost && r.peerId !== peer?.selfId).length, [roster, peer]);

  const busy = pipeline.status.phase === 'planning' || pipeline.status.phase === 'starting' || pipeline.status.phase === 'running';

  return (
    <section className="sp-panel">
      <h3>
        pipeline-split inference <span className="sp-model">qwen3-0.6b-q8_0</span>
      </h3>

      <div className="sp-host-row">
        <label className="sp-host-toggle">
          <input
            type="checkbox"
            checked={hostingEnabled}
            disabled={!host.supported}
            onChange={(e) => setHostingEnabled(e.target.checked)}
          />
          host stages{host.active ? ' — advertising' : ''}
        </label>
        {!host.supported && <span className="sp-warn">{host.unsupportedReason}</span>}
        {host.sessions.length > 0 && (
          <span className="sp-badge">
            hosting {host.sessions.length}/{host.maxSessions} session(s) [{host.sessions[0]!.layerStart},{host.sessions[0]!.layerEnd}) · {host.tokensDecoded} tok
            {host.queueLength > 0 ? ` · ${host.queueLength} queued` : ''}
          </span>
        )}
        {host.lastError && <span className="sp-err">{host.lastError}</span>}
        <span className="ul-muted sp-small">{stageHostPeerCount} remote stage host(s) in roster</span>
      </div>

      <div className="sp-run-row">
        <input
          className="sp-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="prompt for the split pipeline…"
          disabled={busy}
        />
        <button disabled={busy || !peer} onClick={() => void pipeline.start(prompt, { maxDecodeTokens: 64 })}>
          {busy ? 'running…' : 'run split inference'}
        </button>
        {busy && (
          <button className="sp-abort" onClick={() => pipeline.abort('user cancelled')}>
            abort
          </button>
        )}
      </div>

      <div className="sp-status-row">
        status: <strong>{pipeline.status.phase}</strong>
        {pipeline.status.phase === 'error' && <span className="sp-err"> — {pipeline.status.error}</span>}
        {pipeline.status.phase === 'aborted' && <span className="sp-err"> — {pipeline.status.reason}</span>}
        {pipeline.status.phase === 'follower' && (
          <span className="ul-muted"> — another tab is already driving a split run</span>
        )}
        {pipeline.tpotMs !== undefined && <span className="sp-badge">TPOT {pipeline.tpotMs.toFixed(0)}ms</span>}
        <span className={`sp-badge${pipeline.restartCount > 0 ? ' sp-badge-warn' : ''}`}>restarts: {pipeline.restartCount}</span>
      </div>

      {pipeline.plan && (
        <div className="sp-topology">
          <div className="sp-topology-title">topology</div>
          <ol>
            {pipeline.plan.stages.map((s) => {
              const ready = s.stageIndex === 0 || pipeline.readyStageIndexes.includes(s.stageIndex);
              return (
                <li key={s.stageIndex} className={ready ? 'sp-stage-ready' : 'sp-stage-pending'}>
                  stage {s.stageIndex}
                  {s.stageIndex === 0 ? ' (local)' : ''} — {shortId(s.peerId)} — layers [{s.layerStart},{s.layerEnd})
                  {ready ? ' ✓ ready' : ' … loading'}
                </li>
              );
            })}
          </ol>
          {pipeline.plan.hotSparePeerId && (
            <div className="ul-muted sp-small">hot spare: {shortId(pipeline.plan.hotSparePeerId)}</div>
          )}
        </div>
      )}

      <pre className="sp-output">{pipeline.text || (busy ? '…' : '')}</pre>
    </section>
  );
}
