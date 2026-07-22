/**
 * ToolContributionPanel — "contribute tools, no GPU needed".
 *
 * The GPU-less counterpart of the hosting consent banner: any tab can
 * switch on built-in tools (current_time / ping / fetch_text) or attach an
 * MCP endpoint, advertise them on its peer cap, and serve calls routed to
 * it by whichever driver's model asked for the tool (docs/TOOL-NODES.md).
 * State + persistence live in `useToolContribution`; serving lives in
 * `useMeshTools` (Dashboard). This component is presentation only.
 */
import { useState } from 'react';
import type { McpError } from '@unstable-legion/core';
import type { EngineLoadProgress } from '@unstable-legion/speech';
import type { UseToolContributionHandle } from '../hooks/useToolContribution.js';

function describeMcpError(err: McpError): string {
  switch (err.kind) {
    case 'cors':
      return 'blocked (CORS)';
    case 'timeout':
      return 'timed out';
    case 'network':
      return 'unreachable';
    default:
      return 'protocol error';
  }
}

/**
 * Renders a host toggle's `loading`/`progress` as one short status line —
 * `useSpeechHost`/`useTtsHost`'s `warmup()` reports a percentage on most
 * loads, but a warm Cache Storage hit can resolve `ready` with zero
 * `progress` events, and even a cold load's very first tick arrives
 * before transformers.js has a byte count yet — so this degrades through
 * "% known" -> "status known" -> a plain fallback rather than showing
 * nothing or a stuck "0%".
 */
function formatLoadProgress(p: EngineLoadProgress | null): string {
  if (p && typeof p.progress === 'number') return `loading model… ${Math.round(p.progress)}%`;
  if (p?.status === 'initiate') return 'loading model… starting download';
  if (p?.status === 'done') return 'loading model… finishing up';
  return 'loading model…';
}

const BUILTIN_HINTS: Record<string, string> = {
  current_time: 'Answer "what time is it" from your clock',
  ping: 'Echo + mesh hop latency probe',
  fetch_text: 'Fetch a URL through your browser (CORS applies)',
};

export interface ToolContributionSpeechProps {
  enabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  /** True once the Whisper MODEL has finished loading (not just the
   * worker constructed) and the `transcribe` tool is registered/
   * advertised — see `useSpeechHost`. */
  ready: boolean;
  /** True while the model is downloading/initializing, between `enabled`
   * and `ready` — see `useSpeechHost`. */
  loading: boolean;
  /** Most recent load-progress event, for the "loading model… N%" status
   * line — see `formatLoadProgress`. */
  progress: EngineLoadProgress | null;
  error: string | null;
}

/** Mirrors `ToolContributionSpeechProps` exactly, reverse capability — see `useTtsHost`. */
export interface ToolContributionTtsProps {
  enabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  /** True once the Kokoro MODEL has finished loading (not just the
   * worker constructed) and the `synthesize` tool is registered/
   * advertised — see `useTtsHost`. */
  ready: boolean;
  /** True while the model is downloading/initializing, between `enabled`
   * and `ready` — see `useTtsHost`. */
  loading: boolean;
  /** Most recent load-progress event, for the "loading model… N%" status
   * line — see `formatLoadProgress`. */
  progress: EngineLoadProgress | null;
  error: string | null;
}

/**
 * "Auto-speak replies" — a CONSUMPTION preference ("read replies aloud to
 * me"), not a hosting one, so it's distinct from `ToolContributionTtsProps`
 * above: usable whenever TTS is reachable at all (this tab hosts it, OR a
 * roster peer advertises `TTS_SKILL`), never gated on THIS tab's own
 * `ttsHost.enabled`.
 */
export interface ToolContributionAutoSpeakProps {
  enabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  /** True when some TTS target (local host or roster peer) is reachable. */
  reachable: boolean;
}

/**
 * "💬 Conversation mode (hands-free)" — increment 3c. Needs BOTH directions
 * reachable at once (an utterance has nowhere useful to go if either ASR or
 * TTS is missing), unlike `ToolContributionAutoSpeakProps`/the ASR mic
 * button above, which each only need their own single direction.
 */
export interface ToolContributionConversationModeProps {
  enabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  /** True when BOTH an ASR target and a TTS target are reachable (this tab
   * hosts them, or a roster peer advertises `asr.transcribe`/
   * `tts.synthesize` respectively). */
  reachable: boolean;
}

/**
 * "Require wake word" (increment 3b) — only meaningful once 💬 Conversation
 * mode is on (it gates THAT mode's auto-send; there's nothing to gate
 * otherwise), so the row is disabled/hinted rather than hidden when
 * conversation mode is off — same "visible but inert with a reason" pattern
 * `autoSpeak`/`conversationMode`'s own reachability hints use.
 */
export interface ToolContributionWakeWordProps {
  requireEnabled: boolean;
  onToggleRequireEnabled: (enabled: boolean) => void;
  phrase: string;
  onChangePhrase: (phrase: string) => void;
  /** Whether 💬 Conversation mode itself is on — see the doc comment above. */
  conversationModeEnabled: boolean;
}

export function ToolContributionPanel(props: {
  tools: UseToolContributionHandle;
  speechHost: ToolContributionSpeechProps;
  ttsHost: ToolContributionTtsProps;
  autoSpeak: ToolContributionAutoSpeakProps;
  conversationMode: ToolContributionConversationModeProps;
  wakeWord: ToolContributionWakeWordProps;
}) {
  const { tools, speechHost, ttsHost, autoSpeak, conversationMode, wakeWord } = props;
  const [mcpUrl, setMcpUrl] = useState('');
  const [attachBusy, setAttachBusy] = useState(false);

  async function handleAttach() {
    const url = mcpUrl.trim();
    if (!url || attachBusy) return;
    setAttachBusy(true);
    try {
      tools.addMcpEndpoint(url);
      setMcpUrl('');
    } finally {
      setAttachBusy(false);
    }
  }

  return (
    <section className="mesh-card tool-contrib-panel" data-testid="tool-contrib-panel">
      <h3>Tool contributions</h3>
      <p className="tool-contrib-sub">
        No GPU needed — serve tool calls to the mesh and earn standing. The model can use any tool a live peer
        advertises.
      </p>
      <div className="tool-contrib-builtins">
        {tools.builtinNames.map((name) => (
          <label key={name} className="tool-contrib-row" title={BUILTIN_HINTS[name] ?? name}>
            <input type="checkbox" checked={tools.optedIn.includes(name)} onChange={() => tools.toggleTool(name)} />
            <span className="tool-contrib-name">{name}</span>
          </label>
        ))}
      </div>
      <div className="tool-contrib-mcp">
        <div className="tool-contrib-mcp-attach">
          <input
            type="text"
            className="tool-contrib-mcp-input"
            placeholder="MCP endpoint URL (https://…)"
            value={mcpUrl}
            onChange={(e) => setMcpUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleAttach();
            }}
          />
          <button type="button" className="btn-secondary" disabled={!mcpUrl.trim() || attachBusy} onClick={() => void handleAttach()}>
            Attach
          </button>
        </div>
        {tools.mcpEndpoints.map((url) => {
          const status = tools.mcp.statuses.get(url);
          const toolNames = tools.mcp.attachedTools.filter((t) => t.url === url).map((t) => t.toolName);
          return (
            <div key={url} className="tool-contrib-mcp-row">
              <span className="tool-contrib-mcp-url" title={url}>
                {url.replace(/^https?:\/\//, '')}
              </span>
              <span className={`tool-contrib-mcp-status tool-contrib-mcp-${status?.phase ?? 'pending'}`}>
                {status?.phase === 'attached'
                  ? `${toolNames.length} tool${toolNames.length === 1 ? '' : 's'}`
                  : status?.phase === 'error'
                    ? describeMcpError(status.error)
                    : 'attaching…'}
              </span>
              <button type="button" className="btn-link" onClick={() => tools.removeMcpEndpoint(url)}>
                detach
              </button>
            </div>
          );
        })}
      </div>
      {tools.optedIn.length > 0 && (
        <p className="tool-contrib-served">
          Advertising {tools.optedIn.length} tool{tools.optedIn.length === 1 ? '' : 's'} · served {tools.servedCount} call
          {tools.servedCount === 1 ? '' : 's'} this session
        </p>
      )}
      <div className="tool-contrib-speech">
        <label className="tool-contrib-row" title="Loads a local Whisper model and transcribes for any peer that asks.">
          <input
            type="checkbox"
            checked={speechHost.enabled}
            onChange={(e) => speechHost.onToggleEnabled(e.target.checked)}
          />
          <span className="tool-contrib-name">🎤 Host speech-to-text (uses your GPU)</span>
        </label>
        <p className="tool-contrib-sub">Advertises asr.transcribe to the mesh so other tabs can send you their mic audio.</p>
        {speechHost.enabled && speechHost.loading && !speechHost.error && (
          <span className="tool-contrib-speech-status">{formatLoadProgress(speechHost.progress)}</span>
        )}
        {speechHost.enabled && speechHost.ready && (
          <span className="tool-contrib-speech-status tool-contrib-speech-ready">ready</span>
        )}
        {speechHost.error && <span className="tool-contrib-speech-error">{speechHost.error}</span>}
      </div>
      <div className="tool-contrib-speech tool-contrib-tts">
        <label className="tool-contrib-row" title="Loads a local Kokoro model and synthesizes speech for any peer that asks.">
          <input
            type="checkbox"
            checked={ttsHost.enabled}
            onChange={(e) => ttsHost.onToggleEnabled(e.target.checked)}
          />
          <span className="tool-contrib-name">🔊 Host text-to-speech (uses your GPU)</span>
        </label>
        <p className="tool-contrib-sub">Advertises tts.synthesize to the mesh so other tabs can have you speak replies aloud.</p>
        {ttsHost.enabled && ttsHost.loading && !ttsHost.error && (
          <span className="tool-contrib-speech-status">{formatLoadProgress(ttsHost.progress)}</span>
        )}
        {ttsHost.enabled && ttsHost.ready && (
          <span className="tool-contrib-speech-status tool-contrib-speech-ready">ready</span>
        )}
        {ttsHost.error && <span className="tool-contrib-speech-error">{ttsHost.error}</span>}
      </div>
      <div className="tool-contrib-speech tool-contrib-auto-speak">
        <label
          className="tool-contrib-row"
          title="Speaks each assistant reply aloud automatically, the moment it finishes streaming — no 🔊 click needed."
        >
          <input
            type="checkbox"
            checked={autoSpeak.enabled}
            onChange={(e) => autoSpeak.onToggleEnabled(e.target.checked)}
          />
          <span className="tool-contrib-name">🗣 Auto-speak replies</span>
        </label>
        <p className="tool-contrib-sub">Hands-free listening: every reply is read aloud as soon as it's done.</p>
        {autoSpeak.enabled && !autoSpeak.reachable && (
          <span className="tool-contrib-speech-status">needs a TTS host on the mesh</span>
        )}
      </div>
      <div className="tool-contrib-speech tool-contrib-conversation-mode">
        <label
          className="tool-contrib-row"
          title="Hands-free back-and-forth: talk, it auto-sends and the reply auto-speaks, then it's listening again. Talk while it's speaking to interrupt (barge-in)."
        >
          <input
            type="checkbox"
            checked={conversationMode.enabled}
            onChange={(e) => conversationMode.onToggleEnabled(e.target.checked)}
          />
          <span className="tool-contrib-name">💬 Conversation mode (hands-free)</span>
        </label>
        <p className="tool-contrib-sub">
          Continuous mic + auto-send + auto-speak + barge-in — no buttons once it's on. Turns off the manual 🎙 Listen
          toggle while active (they'd otherwise fight over the mic).
        </p>
        {conversationMode.enabled && !conversationMode.reachable && (
          <span className="tool-contrib-speech-status">needs both an ASR host and a TTS host on the mesh</span>
        )}
      </div>
      <div className="tool-contrib-speech tool-contrib-wake-word">
        <label
          className="tool-contrib-row"
          title="While asleep, conversation mode ignores everything except this phrase — say it to wake it up. Without this, conversation mode is open-mic: it responds to anything said while it's on."
        >
          <input
            type="checkbox"
            checked={wakeWord.requireEnabled}
            disabled={!wakeWord.conversationModeEnabled}
            onChange={(e) => wakeWord.onToggleRequireEnabled(e.target.checked)}
          />
          <span className="tool-contrib-name">🔴 Require wake word</span>
        </label>
        <p className="tool-contrib-sub">
          {wakeWord.conversationModeEnabled
            ? 'Conversation mode only wakes up (and auto-sends) after you say the phrase below; a short window afterward lets you follow up without repeating it.'
            : 'Only applies once 💬 Conversation mode is on.'}
        </p>
        <input
          type="text"
          className="tool-contrib-wake-phrase-input"
          value={wakeWord.phrase}
          disabled={!wakeWord.conversationModeEnabled || !wakeWord.requireEnabled}
          onChange={(e) => wakeWord.onChangePhrase(e.target.value)}
          placeholder="hey legion"
          aria-label="Wake phrase"
        />
      </div>
    </section>
  );
}
