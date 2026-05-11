/**
 * PersonaForm — operator persona settings: nick, skills, advertised
 * tools, MCP endpoints. Browses the public MCP registry inline.
 *
 * Driven by `usePersona`. The host passes:
 *   - the persona + update fn (from `usePersona`)
 *   - the list of all locally-registered tool names (typically derived
 *     from the host's `ToolRegistry.list()`)
 *
 * On submit calls `onSubmit()` — the host typically transitions a
 * `joined: false → true` state at that point.
 */
import { useState, type FormEvent } from 'react';
import type { BootMode, MeshPersona } from '@unstable-legion/core';
import { useMcpRegistry } from '../useMcp.js';
import {
  DEFAULT_MODEL_CATALOG,
  type ModelCatalogEntry,
} from '../modelCatalog.js';
import { PERSONA_PRESETS, type PersonaPreset } from '../personaPresets.js';

// Re-import the BootMode type so the form's onUpdate cast is type-safe
// even if the host imports it from a different module path.
type _BootMode = BootMode;
void {} as _BootMode | undefined;

export interface PersonaFormProps {
  persona: MeshPersona;
  onUpdate: (patch: Partial<MeshPersona>) => void;
  onSubmit: () => void;
  /** Names of all registered tools for the opt-in checklist. */
  availableToolNames: readonly string[];
  /**
   * Override the model catalog the picker renders. Defaults to
   * `DEFAULT_MODEL_CATALOG` (parity with leet's catalog). Pass `[]` to
   * hide the picker entirely.
   */
  modelCatalog?: readonly ModelCatalogEntry[];
  /**
   * When the host has detected this device can't run a local model
   * (e.g. Adreno WebGPU), pass a short explanation here. The form
   * replaces the model picker with this notice + a positive note
   * about the tool/routing roles the peer CAN still play.
   */
  thinClientReason?: string;
  /** Brand title at the top of the form. */
  title?: string;
  /** Tagline beneath the title. */
  tagline?: string;
  /** Optional explanatory footer content. */
  footer?: React.ReactNode;
}

export function PersonaForm(props: PersonaFormProps) {
  const { persona, onUpdate, onSubmit, availableToolNames } = props;
  const modelCatalog = props.modelCatalog ?? DEFAULT_MODEL_CATALOG;
  const [nickDraft, setNickDraft] = useState(persona.nick);
  const [skillsDraft, setSkillsDraft] = useState(persona.skills.join(', '));
  const [authDraft, setAuthDraft] = useState((persona.authoritative ?? []).join(', '));
  const [delegDraft, setDelegDraft] = useState((persona.delegating ?? []).join(', '));
  const [mcpDraft, setMcpDraft] = useState(persona.mcpEndpoints.join('\n'));
  const registry = useMcpRegistry();
  const [registryFilter, setRegistryFilter] = useState('');

  /** Apply a preset — fills in skills/authoritative/delegating + suggests tools. */
  const applyPreset = (preset: PersonaPreset): void => {
    setSkillsDraft(preset.skills.join(', '));
    setAuthDraft(preset.authoritative.join(', '));
    setDelegDraft(preset.delegating.join(', '));
    // Union the suggested tools with whatever's already opted in.
    const merged = new Set<string>([
      ...persona.availableTools,
      ...preset.suggestedTools,
    ]);
    onUpdate({ availableTools: [...merged] });
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const nick = nickDraft.trim().slice(0, 24);
    if (!nick) return;
    const skills = skillsDraft
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const authoritative = authDraft
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const delegating = delegDraft
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const mcpEndpoints = mcpDraft
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && /^https?:\/\//.test(s));
    onUpdate({ nick, skills, authoritative, delegating, mcpEndpoints });
    onSubmit();
  };

  const toggleTool = (name: string) => {
    const next = persona.availableTools.includes(name)
      ? persona.availableTools.filter((t) => t !== name)
      : [...persona.availableTools, name];
    onUpdate({ availableTools: next });
  };

  const addMcpUrl = (url: string) => {
    setMcpDraft((prev) => {
      const lines = prev
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (lines.includes(url)) return prev;
      return [...lines, url].join('\n');
    });
  };

  const filteredEntries = registry.registry?.entries.filter(
    (e) =>
      !registryFilter ||
      e.name.toLowerCase().includes(registryFilter.toLowerCase()) ||
      e.title.toLowerCase().includes(registryFilter.toLowerCase()) ||
      e.description.toLowerCase().includes(registryFilter.toLowerCase()),
  );

  return (
    <main className="ul-join">
      {props.title && <h1>{props.title}</h1>}
      {props.tagline && <p className="ul-tagline">{props.tagline}</p>}
      <form onSubmit={handleSubmit}>
        <label htmlFor="ul-nick">nickname</label>
        <input
          id="ul-nick"
          type="text"
          autoFocus
          maxLength={24}
          value={nickDraft}
          onChange={(e) => setNickDraft(e.target.value)}
          placeholder="anon"
        />

        {modelCatalog.length === 0 && (
          <div className="ul-thin-client-info">
            <strong>model forward-pass unavailable on this device.</strong>
            <p className="ul-muted ul-small">
              {props.thinClientReason ??
                "WebGPU compute on this GPU produces invalid matmul output, so the model can't be hosted here. Tokenizer + detokenizer (pure-JS BPE) work fine — only the inference matmul is broken."}
            </p>
            <p className="ul-muted ul-small">
              <strong>You're a first-class peer.</strong> What you contribute:
            </p>
            <ul className="ul-muted ul-small ul-bullet">
              <li>
                <strong>tokenize outbound prompts</strong> locally before they
                hit the wire — peers receive pure token IDs, no text crossing
                the network
              </li>
              <li>
                <strong>detokenize inbound responses</strong> from any peer
                running a working model — receives raw Codec frames + renders
                them through the right vocab here
              </li>
              <li>
                <strong>host tools</strong> the mesh can call (
                <code>current_time</code>, <code>fetch_text</code>, MCP-attached
                endpoints, custom registrations)
              </li>
              <li>
                <strong>route skills</strong> as a DNS-style delegating node —
                fill in "delegating zones" below to forward queries deeper
              </li>
              <li>
                <strong>direct work</strong> via <code>/skill</code>,{' '}
                <code>/ensemble</code>, <code>/director</code> — the mesh sends
                the forward pass to a peer that can run it
              </li>
            </ul>
          </div>
        )}

        {modelCatalog.length > 0 && (
          <>
            <label htmlFor="ul-bootmode">boot mode</label>
            <select
              id="ul-bootmode"
              value={persona.bootMode}
              onChange={(e) =>
                onUpdate({ bootMode: e.target.value as MeshPersona['bootMode'] })
              }
            >
              <option value="auto">
                auto · mobile→fp32, desktop→fp16 (recommended)
              </option>
              <option value="fp16">
                fp16 only · faster, needs WebGPU shader-f16 (desktop)
              </option>
              <option value="fp32">
                fp32 only · mobile-safe, ~2× download
              </option>
            </select>

            <label htmlFor="ul-model">local model</label>
            <select
              id="ul-model"
              value={persona.modelId}
              onChange={(e) => onUpdate({ modelId: e.target.value })}
            >
              {modelCatalog.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} · {m.downloadMB} MB
                </option>
              ))}
            </select>
            {(() => {
              const selected = modelCatalog.find((m) => m.id === persona.modelId);
              return selected ? (
                <p className="ul-muted ul-small">{selected.tagline}</p>
              ) : null;
            })()}
          </>
        )}

        <label className="ul-section-label">
          mesh role (pick one — sets sensible skills + tools)
        </label>
        <div className="ul-preset-grid">
          {PERSONA_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="ul-preset"
              onClick={() => applyPreset(p)}
              title={p.rationale}
            >
              <div className="ul-preset-label">{p.label}</div>
              <div className="ul-preset-desc">{p.description}</div>
              {p.bestModelHint && (
                <div className="ul-muted ul-small">
                  best fit: {p.bestModelHint}
                </div>
              )}
            </button>
          ))}
        </div>

        <details className="ul-jargon-explainer">
          <summary>What do "skills", "authoritative", "delegating" mean?</summary>
          <p className="ul-muted ul-small">
            <strong>Skills</strong> are capability labels a peer claims —
            other peers route work to whoever advertises the right skill.
            Use dotted paths for hierarchy:{' '}
            <code>coding.python.optimize</code> is more specific than{' '}
            <code>coding.python</code>, which is more specific than{' '}
            <code>coding</code>.
          </p>
          <p className="ul-muted ul-small">
            <strong>Authoritative</strong> = skills this peer{' '}
            <em>executes</em> — when a query matches, this peer answers.
            (Like a DNS A-record.)
          </p>
          <p className="ul-muted ul-small">
            <strong>Delegating</strong> = zones this peer{' '}
            <em>routes for</em> without executing. e.g. setting{' '}
            <code>coding</code> here means "I know peers who handle
            anything under <code>coding.*</code> — ask me and I'll
            forward via my <code>route_skill</code> tool." (Like a DNS
            NS-record.) Empty = leaf-only specialist.
          </p>
          <p className="ul-muted ul-small">
            The resolver tries authoritative-exact first, then
            authoritative-prefix, then delegating-prefix (longest wins,
            like DNS). Bounded by a hop limit to prevent loops.
          </p>
        </details>

        <details className="ul-advanced">
          <summary>Advanced — edit skills / zones manually</summary>
          <label htmlFor="ul-skills">skills (comma-separated)</label>
          <input
            id="ul-skills"
            type="text"
            value={skillsDraft}
            onChange={(e) => setSkillsDraft(e.target.value)}
            placeholder="code-review, ja-translate"
          />

          <label htmlFor="ul-auth">
            authoritative skills (dotted paths)
          </label>
          <input
            id="ul-auth"
            type="text"
            value={authDraft}
            onChange={(e) => setAuthDraft(e.target.value)}
            placeholder="coding.python, language.ja.translate"
          />

          <label htmlFor="ul-deleg">
            delegating zones (DNS-NS-style)
          </label>
          <input
            id="ul-deleg"
            type="text"
            value={delegDraft}
            onChange={(e) => setDelegDraft(e.target.value)}
            placeholder="coding, language.ja"
          />
        </details>

        <label>tools to advertise</label>
        <div className="ul-tool-grid">
          {availableToolNames.map((name) => (
            <label key={name} className="ul-tool-toggle">
              <input
                type="checkbox"
                checked={persona.availableTools.includes(name)}
                onChange={() => toggleTool(name)}
              />
              <code>{name}</code>
            </label>
          ))}
        </div>

        <label htmlFor="ul-mcp">MCP endpoints (one per line)</label>
        <textarea
          id="ul-mcp"
          rows={3}
          value={mcpDraft}
          onChange={(e) => setMcpDraft(e.target.value)}
          placeholder="https://your-mcp-server.example/mcp"
        />

        <details className="ul-mcp-registry">
          <summary>
            browse public MCP registry{' '}
            {registry.registry ? `(${registry.registry.entries.length} servers)` : '…'}
          </summary>
          {registry.loading && <p className="ul-muted">loading registry…</p>}
          {registry.error && <p className="ul-warn">registry error: {registry.error}</p>}
          {filteredEntries && (
            <>
              <input
                type="search"
                placeholder="filter by name / description"
                value={registryFilter}
                onChange={(e) => setRegistryFilter(e.target.value)}
              />
              <ul className="ul-mcp-list">
                {filteredEntries.slice(0, 50).map((e) => (
                  <li key={e.name}>
                    <strong>{e.title}</strong>{' '}
                    <span className="ul-muted">({e.name})</span>
                    <p className="ul-muted ul-small">{e.description || '(no description)'}</p>
                    {e.urls.map((u) => {
                      // Some upstream-registry URLs are malformed (relative paths,
                      // missing scheme) — `new URL()` throws on those. Fall back
                      // to the raw URL as the host-label and let the user click
                      // to add literally — they'll see the issue when the
                      // discover call fails with a typed `network`/`protocol`
                      // error in the MCP status row.
                      let host: string;
                      try {
                        host = new URL(u).hostname;
                      } catch {
                        host = u;
                      }
                      return (
                        <button
                          key={u}
                          type="button"
                          className="ul-link"
                          onClick={() => addMcpUrl(u)}
                        >
                          + add {host}
                        </button>
                      );
                    })}
                  </li>
                ))}
                {filteredEntries.length > 50 && (
                  <li className="ul-muted ul-small">
                    showing first 50 of {filteredEntries.length} — narrow your filter.
                  </li>
                )}
              </ul>
            </>
          )}
        </details>

        <button type="submit" disabled={nickDraft.trim().length === 0}>
          join room
        </button>
      </form>
      {props.footer}
    </main>
  );
}
