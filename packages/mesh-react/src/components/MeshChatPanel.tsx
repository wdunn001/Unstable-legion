/**
 * MeshChatPanel — chat composer + message list + live AI streams.
 *
 *   - Plain text: routes through `useMeshChat.send` (safety prefilter
 *     fires; blocked sends raise the safety dialog).
 *   - `/ai <prompt>`: requires `localLlm` ready; streams raw Codec
 *     frames via `peer.sendFrame` AND locally detokenizes for
 *     self-display.
 *   - `/tool <peer-nick> <name> [json-args]`: invokes a peer's tool via
 *     `useMeshTools.callTool`; result lands as a chat line.
 *
 * Receiving peers' frames are detokenized per-sender into a `Map<peerId,
 * AiStreamState>` that renders inline with the message list.
 *
 * The component registers itself as the draft-bridge target on mount so
 * `MeshRosterPanel` clicks insert templates into the composer.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Detokenizer, type TokenizerMap } from '@codecai/web';
import {
  ensemble as ensembleCore,
  llmSummarize,
  mapReduce as mapReduceCore,
  type CodecMsgpackFrame,
  type MeshToolResult,
} from '@unstable-legion/core';
import { useMeshContext } from '../provider.js';
import { useMeshChat } from '../useMeshChat.js';
import { useMeshRoster } from '../useMeshRoster.js';
import { useCodecMapResolver } from '../useCodecMap.js';
import type { UseMeshToolsHandle } from '../useMeshTools.js';
import type { UnifiedToolHandle } from '../useMeshToolBus.js';
import { useDirector } from '../useDirector.js';
import type { UseLocalLlmHandle } from '../useLocalLlm.js';
import { registerDraftSetter } from '../draftBridge.js';
import { SafetyDialog } from './SafetyDialog.js';
import { DirectorTrace, type DirectorTraceStep } from './DirectorTrace.js';

interface AiStreamState {
  text: string;
  frameCount: number;
  byteCount: number;
  done: boolean;
}

export interface MeshChatPanelProps {
  /** Local LLM handle (for `/ai`). Optional — without it, `/ai` reports "not ready". */
  llm?: UseLocalLlmHandle;
  /** Tokenizer map used to detokenize incoming frames for display. */
  map: TokenizerMap | null;
  /** Tokenizer-map load error string for surface in the UI. */
  mapError?: string | null;
  /** Tool calling handle (for `/tool`). Optional — without it `/tool` is a no-op. */
  tools?: UseMeshToolsHandle;
  /**
   * Unified tool bus (for `/skill`, `/ensemble`, `/maps`). Optional —
   * those commands report "no bus wired" without it. Typically built
   * via `useMeshToolBus()` in the host App.
   */
  bus?: UnifiedToolHandle;
  /** Placeholder for the composer input. */
  placeholder?: string;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function shortenFrom(from: string, self: string | undefined): string {
  if (self && from === self) return 'me';
  return truncate(from, 8);
}

/** Cheap byte-size estimate for a CodecFrame — 4 B/id + ~16 B envelope. */
function estimateFrameBytes(frame: { ids?: readonly number[] }): number {
  return (frame.ids?.length ?? 0) * 4 + 16;
}

/** One-line summary of a MeshToolResult for the trace + chat echo. */
function summarizeResult(result: MeshToolResult): string {
  if (result.status !== 'ok') {
    return result.error ?? `(${result.status})`;
  }
  const content =
    (result.result as { content?: unknown } | undefined)?.content ?? result.result;
  if (typeof content === 'string') return truncate(content, 120);
  if (content && typeof content === 'object' && 'text' in content) {
    const t = (content as { text?: unknown }).text;
    if (typeof t === 'string') return truncate(t, 120);
  }
  return truncate(JSON.stringify(content), 120);
}

export function MeshChatPanel(props: MeshChatPanelProps) {
  const { llm, map, mapError, tools, bus, placeholder } = props;
  const { messages, send } = useMeshChat();
  const { peer } = useMeshContext();
  const roster = useMeshRoster();
  /** Recent orchestration traces — newest first; capped at 5. */
  const [traces, setTraces] = useState<
    ReadonlyArray<{ id: string; header: string; steps: readonly DirectorTraceStep[] }>
  >([]);
  const pushTrace = (header: string, steps: readonly DirectorTraceStep[]) => {
    setTraces((prev) =>
      [{ id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, header, steps }, ...prev].slice(0, 5),
    );
  };
  // Resolver maps each remote peer's advertised modelId → its tokenizer
  // family → a Detokenizer bound to the right vocab. Without this,
  // frames from a peer running SmolLM2 (or any non-local-family model)
  // get rendered through the LOCAL family's vocab and come out as
  // garbage.
  const mapResolver = useCodecMapResolver();
  // /director uses this hook (no-op when llm/bus aren't provided).
  const director = useDirector({
    llm: llm ?? { status: { phase: 'idle' }, load: async () => undefined, streamFrames: async () => undefined },
    map,
    bus: bus ?? {
      catalog: [],
      find: () => undefined,
      dispatch: async () => ({
        v: 1 as const,
        ts: Date.now(),
        callId: 'noop',
        status: 'error',
        error: 'no bus wired',
      }),
      asFunctionSchemas: () => [],
    },
  });
  const [draft, setDraft] = useState('');

  useEffect(() => {
    registerDraftSetter((mutator) => setDraft((cur) => mutator(cur)));
    return () => registerDraftSetter(null);
  }, []);

  const [pending, setPending] = useState<
    | null
    | {
        text: string;
        decision: Extract<Awaited<ReturnType<typeof send>>, { kind: 'blocked' }>;
      }
  >(null);

  const [aiStreams, setAiStreams] = useState<Map<string, AiStreamState>>(
    () => new Map(),
  );
  const detoksRef = useRef<Map<string, Detokenizer>>(new Map());

  // The roster is captured by ref so the onFrame closure always reads
  // the latest peer-cap-modelId without re-binding the subscription on
  // every roster change.
  const rosterRef = useRef(roster);
  useEffect(() => {
    rosterRef.current = roster;
  }, [roster]);

  useEffect(() => {
    if (!peer) return;
    const unsub = peer.onFrame((frame: CodecMsgpackFrame, peerId: string) => {
      // Pick the detokenizer for THIS peer based on their cap.modelId.
      // Fall back to the local `map` only if the resolver hasn't loaded
      // the right family yet (it kicks off the fetch on miss).
      let detok = detoksRef.current.get(peerId);
      if (!detok) {
        const rosterEntry = rosterRef.current.find((r) => r.peerId === peerId);
        const remoteDetok = rosterEntry
          ? mapResolver.detokenizerFor(rosterEntry.modelId)
          : null;
        if (remoteDetok) {
          detok = remoteDetok;
        } else if (map) {
          // Resolver hasn't loaded yet, OR roster entry missing.
          // Use the local map as a fallback so the user sees SOMETHING.
          // Once the resolver lands the right family on a later frame,
          // we'll swap in the correct detok.
          detok = new Detokenizer(map);
        } else {
          // No usable map at all — skip this frame.
          return;
        }
        detoksRef.current.set(peerId, detok);
      }
      const delta =
        frame.ids.length > 0
          ? detok.render(frame.ids, { partial: !frame.done })
          : '';
      setAiStreams((prev) => {
        const next = new Map(prev);
        const cur = next.get(peerId) ?? {
          text: '',
          frameCount: 0,
          byteCount: 0,
          done: false,
        };
        next.set(peerId, {
          text: cur.text + delta,
          frameCount: cur.frameCount + 1,
          byteCount: cur.byteCount + estimateFrameBytes(frame),
          done: frame.done,
        });
        return next;
      });
      if (frame.done) {
        detok.reset();
        // Drop the cached detok on completion so the next stream picks
        // up the right family — handles the case where the peer's
        // modelId changed mid-session.
        detoksRef.current.delete(peerId);
      }
    });
    return () => {
      unsub();
    };
  }, [peer, map, mapResolver]);

  const selfDetokRef = useRef<Detokenizer | null>(null);
  useEffect(() => {
    selfDetokRef.current = map ? new Detokenizer(map) : null;
  }, [map]);

  // Echo an inline error chat message to the room (just the local
  // sender sees this — receivers see only successfully-sent messages).
  const echoError = async (message: string): Promise<void> => {
    if (peer) {
      await peer.sendChat({ to: '', bodyKind: 'text', text: `[error] ${message}` });
    }
  };

  // Replace the most recent trace's steps with a new step list (used
  // when a /skill, /ensemble, or /maps call transitions running → done).
  const replaceLatestTraceSteps = (steps: readonly DirectorTraceStep[]): void => {
    setTraces((prev) => {
      if (prev.length === 0) return prev;
      const [head, ...rest] = prev;
      return [{ ...head!, steps }, ...rest];
    });
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');

    // /director <prompt> → run the function-calling director loop
    if (text.startsWith('/director ')) {
      if (!bus) {
        await echoError('this peer has no tool bus wired.');
        return;
      }
      if (!llm || llm.status.phase !== 'ready') {
        await echoError(`/director needs the local LLM ready (current: ${llm?.status.phase ?? 'absent'}).`);
        return;
      }
      const prompt = text.slice(10).trim();
      if (!prompt) {
        await echoError('usage: /director <prompt>');
        return;
      }
      // Initialize an empty trace so the UI shows the row immediately;
      // we'll append steps as the director loop fires onStep callbacks.
      const traceId = `dir-${Date.now()}`;
      pushTrace(`/director "${truncate(prompt, 50)}"`, []);
      const liveSteps: DirectorTraceStep[] = [];
      try {
        const result = await director.run(prompt, (step) => {
          // Update or push the step based on its id.
          const idx = liveSteps.findIndex((s) => s.id === step.id);
          if (idx >= 0) {
            liveSteps[idx] = step;
          } else {
            liveSteps.push(step);
          }
          replaceLatestTraceSteps([...liveSteps]);
        });
        // Final summary step (the answer).
        const answerStep: DirectorTraceStep = {
          id: `${traceId}-final`,
          label: 'final answer',
          status: 'ok',
          startedAt: Date.now(),
          finishedAt: Date.now(),
          summary: truncate(result.text, 200),
          detail: result.text,
        };
        replaceLatestTraceSteps([...liveSteps, answerStep]);
        if (peer && result.text) {
          await peer.sendChat({ to: '', bodyKind: 'text', text: `[director] ${result.text}` });
        }
      } catch (err) {
        await echoError(`/director exception: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // /skill <dotted-path> <prompt>  → routeBySkill via the bus
    if (text.startsWith('/skill ')) {
      if (!bus) {
        await echoError('this peer has no tool bus wired (pass `bus` to MeshChatPanel).');
        return;
      }
      const rest = text.slice(7).trim();
      const m = rest.match(/^(\S+)\s+(.+)$/s);
      if (!m) {
        await echoError('usage: /skill <dotted.skill.path> <prompt>');
        return;
      }
      const [, skillPath, prompt] = m;
      const busName = `skill.${skillPath}`;
      const step: DirectorTraceStep = {
        id: `skill-${Date.now()}`,
        label: `skill ${skillPath}`,
        target: undefined,
        status: 'running',
        startedAt: Date.now(),
      };
      pushTrace(`/skill ${skillPath}`, [step]);
      try {
        const result = await bus.dispatch(busName, { user: prompt });
        const summary = summarizeResult(result);
        const finalStep: DirectorTraceStep = {
          ...step,
          status: result.status === 'ok' ? 'ok' : result.status === 'denied' ? 'denied' : 'error',
          finishedAt: Date.now(),
          summary,
          detail: result,
        };
        replaceLatestTraceSteps([finalStep]);
        if (peer) {
          await peer.sendChat({
            to: '',
            bodyKind: 'text',
            text: `[skill ${result.status}] ${skillPath} → ${summary}`,
          });
        }
      } catch (err) {
        const failStep: DirectorTraceStep = {
          ...step,
          status: 'error',
          finishedAt: Date.now(),
          summary: err instanceof Error ? err.message : String(err),
          detail: err,
        };
        replaceLatestTraceSteps([failStep]);
        await echoError(`/skill exception: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // /ensemble <N> <prompt>  → fan to N peers running engine_run, aggregate
    if (text.startsWith('/ensemble ')) {
      if (!peer) {
        await echoError('mesh not connected.');
        return;
      }
      const rest = text.slice(10).trim();
      const m = rest.match(/^(\d+)\s+(.+)$/s);
      if (!m) {
        await echoError('usage: /ensemble <N> <prompt>');
        return;
      }
      const n = Math.max(1, Math.min(8, parseInt(m[1]!, 10)));
      const prompt = m[2]!;
      // Pick N peers that have engine_run available, prefer non-self.
      const candidates = roster.filter(
        (r) =>
          r.available &&
          r.peerId !== peer.selfId &&
          r.tools.some((t) => t.name === 'engine_run'),
      );
      if (candidates.length === 0) {
        await echoError('no peers advertise engine_run.');
        return;
      }
      const picked = candidates.slice(0, n);
      const startSteps: DirectorTraceStep[] = picked.map((p, i) => ({
        id: `ens-${Date.now()}-${i}`,
        label: `engine_run`,
        target: p.nick,
        status: 'running',
        startedAt: Date.now(),
      }));
      pushTrace(`/ensemble ${n} "${truncate(prompt, 40)}"`, startSteps);
      try {
        // Use llmSummarize via the LOCAL peer's engine_run if the local
        // LLM is ready; fall back to a simple concat-join otherwise.
        const aggregator =
          llm?.status.phase === 'ready'
            ? llmSummarize(peer, peer.selfId)
            : (rs: readonly string[]) => rs.map((r, i) => `(${i + 1}) ${r}`).join('\n\n---\n\n');
        const { result, samples, failures } = await ensembleCore(
          peer,
          picked.map((p) => p.peerId),
          prompt,
          aggregator,
        );
        const endSteps: DirectorTraceStep[] = picked.map((p, i) => ({
          id: `ens-${Date.now()}-${i}`,
          label: `engine_run`,
          target: p.nick,
          status: samples[i] !== undefined ? 'ok' : 'error',
          startedAt: startSteps[i]!.startedAt,
          finishedAt: Date.now(),
          summary:
            samples[i] !== undefined
              ? truncate(samples[i]!, 80)
              : failures[i]?.message ?? 'unknown error',
          detail: samples[i] ?? failures[i],
        }));
        replaceLatestTraceSteps(endSteps);
        if (peer) {
          await peer.sendChat({
            to: '',
            bodyKind: 'text',
            text: `[ensemble ${samples.length}/${n}] ${typeof result === 'string' ? result : JSON.stringify(result)}`,
          });
        }
      } catch (err) {
        await echoError(`/ensemble exception: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // /maps <toolName> <item1> <item2> ...  → run mapTool on each item in parallel
    if (text.startsWith('/maps ')) {
      if (!peer) {
        await echoError('mesh not connected.');
        return;
      }
      const parts = text.slice(6).trim().split(/\s+/);
      if (parts.length < 2) {
        await echoError('usage: /maps <toolName> <item1> [<item2> ...]');
        return;
      }
      const toolName = parts[0]!;
      const items = parts.slice(1);
      const candidates = roster.filter(
        (r) =>
          r.available &&
          r.peerId !== peer.selfId &&
          r.tools.some((t) => t.name === toolName),
      );
      if (candidates.length === 0) {
        await echoError(`no peers advertise tool "${toolName}".`);
        return;
      }
      const startSteps: DirectorTraceStep[] = items.map((item, i) => ({
        id: `map-${Date.now()}-${i}`,
        label: `${toolName}(${truncate(item, 24)})`,
        target: candidates[i % candidates.length]?.nick,
        status: 'running',
        startedAt: Date.now(),
      }));
      pushTrace(`/maps ${toolName} (${items.length} items)`, startSteps);
      try {
        // For simple tools like fetch_text we assume a single `url` arg.
        // Generalized arg shape: try {url:item} first, then {item}, then {input:item}.
        const argsFor = (item: string): Record<string, unknown> => {
          if (/^https?:\/\//i.test(item)) return { url: item };
          return { input: item };
        };
        const reduced = await mapReduceCore(
          peer,
          candidates.map((c) => c.peerId),
          items,
          { name: toolName, argsFor },
          (mapped) => mapped,
        );
        const endSteps: DirectorTraceStep[] = items.map((item, i) => {
          const got = reduced[i];
          const isErr = got instanceof Error;
          return {
            id: `map-${Date.now()}-${i}`,
            label: `${toolName}(${truncate(item, 24)})`,
            target: candidates[i % candidates.length]?.nick,
            status: isErr ? 'error' : 'ok',
            startedAt: startSteps[i]!.startedAt,
            finishedAt: Date.now(),
            summary: isErr ? (got as Error).message : truncate(JSON.stringify(got), 80),
            detail: got,
          };
        });
        replaceLatestTraceSteps(endSteps);
        if (peer) {
          const okCount = endSteps.filter((s) => s.status === 'ok').length;
          await peer.sendChat({
            to: '',
            bodyKind: 'text',
            text: `[maps ${okCount}/${items.length}] ${toolName} done — expand the trace for results.`,
          });
        }
      } catch (err) {
        await echoError(`/maps exception: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    if (text.startsWith('/tool ')) {
      if (!tools) {
        if (peer) {
          await peer.sendChat({
            to: '',
            bodyKind: 'text',
            text: '[error] this peer has no tool-caller wired in (pass `tools` to MeshChatPanel).',
          });
        }
        return;
      }
      const rest = text.slice(6).trim();
      const m = rest.match(/^(\S+)\s+(\S+)(?:\s+(.+))?$/);
      if (!m) {
        if (peer) {
          await peer.sendChat({
            to: '',
            bodyKind: 'text',
            text: '[error] usage: /tool <peer-nick-or-prefix> <toolName> [json-args]',
          });
        }
        return;
      }
      const [, targetNick, toolName, jsonArgsStr] = m;
      const targetEntry = roster.find(
        (p) =>
          p.nick.toLowerCase() === targetNick!.toLowerCase() ||
          p.peerId.toLowerCase().startsWith(targetNick!.toLowerCase()),
      );
      if (!targetEntry) {
        if (peer) {
          await peer.sendChat({
            to: '',
            bodyKind: 'text',
            text: `[error] no peer matches "${targetNick}".`,
          });
        }
        return;
      }
      let args: Record<string, unknown> = {};
      if (jsonArgsStr) {
        try {
          const parsed = JSON.parse(jsonArgsStr);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('args must be a JSON object');
          }
          args = parsed as Record<string, unknown>;
        } catch (err) {
          if (peer) {
            await peer.sendChat({
              to: '',
              bodyKind: 'text',
              text: `[error] invalid json args: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
          return;
        }
      }
      if (peer) {
        await peer.sendChat({
          to: '',
          bodyKind: 'text',
          text: `/tool ${targetEntry.nick} ${toolName} ${JSON.stringify(args)}`,
        });
      }
      try {
        const result: MeshToolResult = await tools.callTool(
          targetEntry.peerId,
          toolName!,
          args,
        );
        if (peer) {
          const resultContent =
            (result.result as Record<string, unknown> | undefined)?.content ??
            result.result;
          const summary =
            result.status === 'ok'
              ? `[tool ok] ${toolName} → ${JSON.stringify(resultContent)}`
              : `[tool ${result.status}] ${toolName}: ${result.error ?? '(no details)'}`;
          await peer.sendChat({ to: '', bodyKind: 'text', text: summary });
        }
      } catch (err) {
        if (peer) {
          await peer.sendChat({
            to: '',
            bodyKind: 'text',
            text: `[tool exception] ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
      return;
    }

    if (text.startsWith('/ai ')) {
      const prompt = text.slice(4);
      if (peer) {
        await peer.sendChat({ to: '', bodyKind: 'text', text: `/ai ${prompt}` });
      }
      if (!llm || llm.status.phase !== 'ready') {
        if (peer) {
          await peer.sendChat({
            to: '',
            bodyKind: 'text',
            text: `[error] /ai requested but local LLM is "${llm?.status.phase ?? 'absent'}".`,
          });
        }
        return;
      }
      const selfDetok = selfDetokRef.current;
      if (selfDetok) selfDetok.reset();
      setAiStreams((prev) => {
        const next = new Map(prev);
        next.set(peer?.selfId ?? 'me', { text: '', frameCount: 0, byteCount: 0, done: false });
        return next;
      });
      try {
        await llm.streamFrames(prompt, (frame) => {
          if (peer) {
            void peer.sendFrame(frame as unknown as CodecMsgpackFrame);
          }
          if (selfDetok) {
            const delta =
              frame.ids.length > 0
                ? selfDetok.render(frame.ids, { partial: !frame.done })
                : '';
            setAiStreams((prev) => {
              const next = new Map(prev);
              const key = peer?.selfId ?? 'me';
              const cur = next.get(key) ?? {
                text: '',
                frameCount: 0,
                byteCount: 0,
                done: false,
              };
              next.set(key, {
                text: cur.text + delta,
                frameCount: cur.frameCount + 1,
                byteCount:
                  cur.byteCount + estimateFrameBytes(frame as unknown as CodecMsgpackFrame),
                done: frame.done,
              });
              return next;
            });
          }
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (peer) {
          await peer.sendChat({
            to: '',
            bodyKind: 'text',
            text: `[/ai error] ${errMsg}`,
          });
        }
      }
      return;
    }

    const decision = await send(text);
    if (decision.kind === 'blocked') {
      setPending({
        text,
        decision: decision as Extract<typeof decision, { kind: 'blocked' }>,
      });
    }
  };

  return (
    <section className="ul-chat">
      <h3>Chat</h3>
      {mapError && <div className="ul-warn">tokenizer map load failed: {mapError}</div>}
      <div className="ul-msgs">
        {messages.length === 0 && aiStreams.size === 0 ? (
          <p className="ul-muted">
            no messages yet. <code>/ai &lt;prompt&gt;</code> invokes the local
            WebGPU LLM; <code>/tool &lt;peer&gt; &lt;name&gt;</code> invokes a peer
            tool.
          </p>
        ) : (
          <>
            {messages.map((m, i) => (
              <div key={`m${i}`} className="ul-msg">
                <span className="ul-from">{shortenFrom(m.from, peer?.selfId)}</span>
                <span className="ul-body">{m.text}</span>
                {m.safety?.category && (
                  <span className="ul-badge">{m.safety.category}</span>
                )}
              </div>
            ))}
            {[...aiStreams.entries()].map(([peerId, state]) => (
              <div key={`ai-${peerId}`} className="ul-msg ul-msg-ai">
                <span className="ul-from">
                  {shortenFrom(peerId, peer?.selfId)} <em>(ai)</em>
                </span>
                <span className="ul-body">
                  {state.text || <em className="ul-muted">(awaiting tokens…)</em>}
                </span>
                <span className="ul-badge ul-badge-ok">
                  {state.frameCount} frames · {state.byteCount} B
                </span>
              </div>
            ))}
          </>
        )}
        {traces.length > 0 && (
          <div className="ul-traces">
            {traces.map((t) => (
              <DirectorTrace key={t.id} header={t.header} steps={t.steps} />
            ))}
          </div>
        )}
      </div>
      <form onSubmit={onSubmit} className="ul-composer">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder ?? 'message the mesh… or /ai <prompt>'}
          autoComplete="off"
        />
        <button type="submit" disabled={!draft.trim() || !peer}>send</button>
      </form>
      {pending && (
        <SafetyDialog
          decision={pending.decision}
          onRedact={async () => {
            await send(pending.text, { safety: { policy: 'redact-auto' } });
            setPending(null);
          }}
          onSendAnyway={async () => {
            if (peer) {
              await peer.sendChat({ to: '', bodyKind: 'text', text: pending.text });
            }
            setPending(null);
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </section>
  );
}
