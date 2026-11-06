import type { ChangeEvent } from 'react';
import { CHAT_CHANNELS, chatModelLabel, setStoredChannelId } from '../chatModelSource.js';
import { channelCountLabel } from '../viewmodels/meshViewModels.js';

/**
 * Header model-channel picker. Each channel is its OWN mesh (peers only host
 * for others on the same `modelId`), so switching means leaving one mesh and
 * joining another + downloading that model's layers. That's a heavy,
 * everything-re-inits operation, so a switch PERSISTS the choice and RELOADS
 * rather than hot-swapping `modelId` through the live hook tree (safer given
 * this app's history of mid-session re-init bugs). A native <select> keeps it
 * accessible and dependency-free — no custom dropdown state to churn.
 *
 * Every channel option shows its live member count (`counts`, keyed by
 * modelId, self included) — all channels share one Trystero room, so presence
 * for every channel is already in the roster. Counts only ever ADD to the
 * label; an absent `counts` map renders the picker exactly as before.
 *
 * When `?testModel=1` is active it OVERRIDES any channel, so we render a plain
 * pill (no picker) rather than let a selection silently do nothing.
 */
export function ModelChannelPicker(props: {
  currentModelId: string;
  currentLabel: string;
  isTestModel: boolean;
  /** Present members per channel modelId — see deriveChannelCounts. */
  counts?: Record<string, number>;
}) {
  if (props.isTestModel || CHAT_CHANNELS.length < 2) {
    return (
      <span className="app-model-pill" title={`This mesh is assembling/serving ${props.currentLabel}`}>
        {props.currentLabel}
      </span>
    );
  }

  const onChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    if (id === props.currentModelId) return;
    const ch = CHAT_CHANNELS.find((c) => c.id === id);
    const label = ch ? chatModelLabel(ch.displayName, ch.quant) : id;
    const ok =
      typeof confirm === 'undefined' ||
      confirm(`Switch this tab to ${label}?\n\nEach model is its own mesh — this rejoins a different one and downloads that model's layers.`);
    if (!ok) return;
    setStoredChannelId(id);
    location.reload();
  };

  return (
    <label className="app-model-pill app-model-picker" title="Switch the model this mesh assembles/serves (reloads this tab)">
      <select value={props.currentModelId} onChange={onChange} aria-label="Model channel">
        {CHAT_CHANNELS.map((c) => (
          <option key={c.id} value={c.id}>
            {chatModelLabel(c.displayName, c.quant)}
            {props.counts ? ` · ${channelCountLabel(props.counts[c.id] ?? 0)}` : ''}
          </option>
        ))}
      </select>
      <span className="app-model-picker-caret" aria-hidden="true">▾</span>
    </label>
  );
}
