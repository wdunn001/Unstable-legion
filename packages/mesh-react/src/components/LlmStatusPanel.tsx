/**
 * LlmStatusPanel — renders the current `useLocalLlm` status (idle /
 * follower / loading / ready / error / unsupported) plus a boot button
 * in the idle state.
 *
 * Uses semantic class names — host app styles via CSS. Renders nothing
 * but a `section.ul-llm-row` with an additional state class.
 */
import type { UseLocalLlmHandle } from '../useLocalLlm.js';

export interface LlmStatusPanelProps {
  llm: UseLocalLlmHandle;
  /** Gate the "boot" button on something external being ready (e.g. tokenizer map). */
  bootDisabled?: boolean;
  /** Label shown on the boot button while enabled. Default "boot model". */
  bootLabel?: string;
  /** Label shown on the boot button while disabled. Default "waiting…". */
  bootDisabledLabel?: string;
  /**
   * Model id the persona currently has selected. When this differs from
   * the engine's actually-booted modelId (`llm.status.modelId`), we
   * surface a "switch model · refresh required" warning so the user
   * doesn't see their old engine's tokens detokenized through the new
   * model's vocab (= garbage). Same UX leet uses.
   */
  selectedModelId?: string;
  /**
   * Device-compat tier from `useDeviceCompat`. When set to
   * `'thinclient'` the panel renders a thin-client notice INSTEAD of
   * the boot button — Adreno (and similar broken-WebGPU) devices
   * can't produce correct local output regardless of which model
   * they pick. When `'small-only'`, surfaces a hint that fp32 mobile
   * models are the only ones likely to work.
   */
  compatTier?: 'full' | 'small-only' | 'thinclient' | 'unknown';
  /** Optional explanation message shown alongside the tier-derived state. */
  compatReason?: string;
}

export function LlmStatusPanel(props: LlmStatusPanelProps) {
  const { llm, bootDisabled, bootLabel = 'boot model', bootDisabledLabel = 'waiting…' } = props;
  const status = llm.status;

  // Thin-client tier — the GPU is known-broken for ML even if WebGPU
  // technically reports as available. Render a thin-client notice
  // INSTEAD of any boot path so the user doesn't waste a 600 MB
  // download on a model that can't run correctly.
  if (props.compatTier === 'thinclient') {
    return (
      <section className="ul-llm-row ul-llm-warn">
        <strong>thin-client mode.</strong>{' '}
        {props.compatReason ??
          'this device cannot run a local LLM. join the mesh as a thin client and route prompts via `/skill` or `/director` to other peers.'}
      </section>
    );
  }

  if (status.phase === 'unsupported') {
    return (
      <section className="ul-llm-row ul-llm-warn">
        <strong>WebGPU not available.</strong> {status.reason}
      </section>
    );
  }
  if (status.phase === 'follower') {
    return (
      <section className="ul-llm-row ul-llm-warn">
        <strong>follower mode.</strong> {status.reason}
      </section>
    );
  }
  if (status.phase === 'idle') {
    return (
      <section className="ul-llm-row">
        <span>local LLM not loaded.</span>
        <button
          className="ul-llm-boot"
          onClick={() => void llm.load()}
          disabled={bootDisabled}
        >
          {bootDisabled ? bootDisabledLabel : bootLabel}
        </button>
      </section>
    );
  }
  if (status.phase === 'loading') {
    return (
      <section className="ul-llm-row">
        <progress value={status.pct} max={1} />
        <span className="ul-muted">{status.text}</span>
      </section>
    );
  }
  if (status.phase === 'ready') {
    const mismatch =
      props.selectedModelId !== undefined &&
      props.selectedModelId !== status.modelId;
    if (mismatch) {
      return (
        <section className="ul-llm-row ul-llm-warn">
          <strong>model mismatch:</strong> engine still serving{' '}
          <code>{status.modelId}</code>, but persona is set to{' '}
          <code>{props.selectedModelId}</code>. Refresh the page to load the
          new model — otherwise the chat will detokenize {status.modelId}{' '}
          tokens through the {props.selectedModelId} vocab and render garbage.
        </section>
      );
    }
    return (
      <section className="ul-llm-row ul-llm-ok">
        <strong>llm ready:</strong> {status.modelId} ·{' '}
        <span className="ul-muted">mapId=<code>{status.mapId}</code></span>
      </section>
    );
  }
  return (
    <section className="ul-llm-row ul-llm-err">
      <strong>llm load failed:</strong> {status.error}
    </section>
  );
}
