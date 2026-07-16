/**
 * CommunalChatPanel — the driver-side communal chat UI. `useCommunalChat`
 * (M3/M4 close-out) builds a `CommunalRoute` from the LIVE roster's
 * self-assembled coverage (`CommunalHostPanel`'s hosts) and runs
 * `runCommunalDriverSession` against it — the piece `docs/COMMUNAL.md`'s
 * "What's NOT done" flagged as the single largest remaining M3 gap.
 *
 * Deliberately minimal (not the full OWUI-style chat this repo's M5 will
 * eventually build) — same altitude as `StagePipelinePanel`'s run
 * controls, just pointed at the communal path instead of the legacy
 * driver-plans-everything one.
 *
 * `window.__legionCommunalChat` is populated for Playwright/manual
 * debugging, mirroring `StagePipelinePanel`'s `window.__legionStage` and
 * `CommunalHostPanel`'s `window.__legionCommunal` conventions.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  useCommunalChat,
  useMeshContext,
  useMeshRoster,
  bindPriorityScore,
  type StandingLedger,
} from '@unstable-legion/react';
import { STAGE_MODEL_ID } from '@unstable-legion/react';

export interface CommunalChatPanelProps {
  standingLedger: StandingLedger;
}

const DEFAULT_PROMPT = 'Name three colors.';

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 10)}…` : id;
}

export function CommunalChatPanel(props: CommunalChatPanelProps) {
  const { peer } = useMeshContext();
  const roster = useMeshRoster();
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);

  const createStageWorker = useCallback(
    () => new Worker(new URL('../workers/stageWorker.ts', import.meta.url), { type: 'module' }),
    [],
  );
  const log = useCallback((line: string) => console.info('[communal-chat]', line), []);
  const priorityScore = useMemo(() => bindPriorityScore(props.standingLedger, () => Date.now()), [props.standingLedger]);

  // `?spreadWidth=N` override — e2e-only knob (mirrors `?room=`/`?nochat=1`).
  // Production leaves this unset (hook default 3, the anti-stampede
  // spread). The communal.spec.ts acceptance test sets `spreadWidth=1` on
  // driver pages so multiple concurrent drivers deterministically converge
  // on the SAME top-ranked host instead of fanning out across warm spares
  // — the shared-dependency shape needed to prove "kill one host, both
  // chats survive" rather than leaving it to chance which candidate each
  // driver's peerId hash happens to pick.
  const spreadWidthParam = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('spreadWidth') : null;
  const spreadWidth = spreadWidthParam ? Number(spreadWidthParam) : undefined;

  const chat = useCommunalChat({
    peer,
    createStageWorker,
    priorityScore,
    spreadWidth,
    standingLedger: props.standingLedger,
    log,
  });

  useEffect(() => {
    (window as unknown as { __legionCommunalChat?: unknown }).__legionCommunalChat = {
      selfId: peer?.selfId,
      status: chat.status,
      plan: chat.plan,
      tokens: chat.tokens,
      text: chat.text,
      restartCount: chat.restartCount,
      readyStageIndexes: chat.readyStageIndexes,
    };
  }, [peer, chat]);

  const busy = chat.status.phase === 'planning' || chat.status.phase === 'starting' || chat.status.phase === 'running';
  const communalHostCount = roster.filter((r) => (r.stageHost?.loadedStages?.length ?? 0) > 0).length;

  return (
    <section className="sp-panel">
      <h3>
        communal chat <span className="sp-model">{STAGE_MODEL_ID}</span>
      </h3>

      <div className="sp-host-row">
        <span className="ul-muted sp-small">{communalHostCount} communal host(s) advertising a loaded stage</span>
      </div>

      <div className="sp-run-row">
        <input
          className="sp-prompt communal-chat-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="prompt for the communal pipeline…"
          disabled={busy}
        />
        <button
          className="communal-chat-run"
          disabled={busy || !peer}
          onClick={() => void chat.start(prompt, { maxDecodeTokens: 64 })}
        >
          {busy ? 'running…' : 'run communal chat'}
        </button>
        {busy && (
          <button className="sp-abort communal-chat-abort" onClick={() => chat.abort('user cancelled')}>
            abort
          </button>
        )}
      </div>

      <div className="sp-status-row communal-chat-status">
        status: <strong>{chat.status.phase}</strong>
        {chat.status.phase === 'error' && <span className="sp-err"> — {chat.status.error}</span>}
        {chat.status.phase === 'aborted' && <span className="sp-err"> — {chat.status.reason}</span>}
        {chat.status.phase === 'follower' && (
          <span className="ul-muted"> — another tab is already driving a communal chat</span>
        )}
        <span className={`sp-badge communal-chat-restarts${chat.restartCount > 0 ? ' sp-badge-warn' : ''}`}>
          restarts: {chat.restartCount}
        </span>
      </div>

      {chat.plan && (
        <div className="sp-topology">
          <div className="sp-topology-title">route</div>
          <ol>
            {chat.plan.stages.map((s) => {
              const ready = s.stageIndex === 0 || chat.readyStageIndexes.includes(s.stageIndex);
              return (
                <li key={s.stageIndex} className={ready ? 'sp-stage-ready' : 'sp-stage-pending'}>
                  stage {s.stageIndex}
                  {s.stageIndex === 0 ? ' (local)' : ''} — {shortId(s.peerId)} — layers [{s.layerStart},{s.layerEnd})
                  {ready ? ' ✓ ready' : ' … attaching'}
                </li>
              );
            })}
          </ol>
          {chat.plan.hotSparePeerId && <div className="ul-muted sp-small">hot spare: {shortId(chat.plan.hotSparePeerId)}</div>}
        </div>
      )}

      <pre className="sp-output communal-chat-output">{chat.text || (busy ? '…' : '')}</pre>
    </section>
  );
}
