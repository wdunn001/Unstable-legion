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

const BUILTIN_HINTS: Record<string, string> = {
  current_time: 'Answer "what time is it" from your clock',
  ping: 'Echo + mesh hop latency probe',
  fetch_text: 'Fetch a URL through your browser (CORS applies)',
};

export interface ToolContributionSpeechProps {
  enabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  /** True once the Whisper worker is loaded and the `transcribe` tool is
   * registered/advertised — see `useSpeechHost`. */
  ready: boolean;
  error: string | null;
}

/** Mirrors `ToolContributionSpeechProps` exactly, reverse capability — see `useTtsHost`. */
export interface ToolContributionTtsProps {
  enabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  /** True once the Kokoro worker is loaded and the `synthesize` tool is
   * registered/advertised — see `useTtsHost`. */
  ready: boolean;
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

export function ToolContributionPanel(props: {
  tools: UseToolContributionHandle;
  speechHost: ToolContributionSpeechProps;
  ttsHost: ToolContributionTtsProps;
  autoSpeak: ToolContributionAutoSpeakProps;
}) {
  const { tools, speechHost, ttsHost, autoSpeak } = props;
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
        {speechHost.enabled && !speechHost.ready && !speechHost.error && (
          <span className="tool-contrib-speech-status">initializing (downloading model on first use)…</span>
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
        {ttsHost.enabled && !ttsHost.ready && !ttsHost.error && (
          <span className="tool-contrib-speech-status">initializing (downloading model on first use)…</span>
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
    </section>
  );
}
