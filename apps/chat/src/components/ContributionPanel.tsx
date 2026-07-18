/**
 * ContributionPanel — the opt-in "Contribute more" expander inside the
 * hosting-consent status row (M5-follow-up: let strong GPUs host far more
 * than the ~11-layer safe default). Three ways to raise the budget, all
 * feeding the SAME `onChangeBudget(bytes)` callback (persisted by the
 * caller via `useHostingConsent`):
 *
 *   (a) pick-your-GPU searchable select from `gpuCatalog.json`, pre-
 *       selected to the detected renderer when a match exists — free-text
 *       is always available too (HARD RULE: no compile-time enum of GPU
 *       names, see `gpuCatalog.ts`'s doc comment).
 *   (b) type a VRAM number directly (GB).
 *   (c) auto-detect: `gpuProbe.ts`'s allocate-and-back-off probe. Clearly
 *       labeled as stressing the GPU — this is a real hardware test, not
 *       a side-effect-free read (see that module's CRASH RISK doc
 *       comment).
 *
 * No component-level CSS — every className here resolves against
 * `styles.css`'s `.contribution-*` rules, same convention as the rest of
 * this app's components.
 */
import { useMemo, useState } from 'react';
import { GPU_CATALOG, matchGpuCatalog, findGpuCatalogEntryByName, formatVramLabel, parseGbInput } from '../gpuCatalog.js';
import { probeGpuAllocatableBytes } from '../gpuProbe.js';

export interface ContributionPanelProps {
  /** Best-effort detected GPU renderer/adapter name (from
   * `useGpuDetection`) — used only to pre-select the catalog dropdown. */
  detectedGpuName?: string;
  /** Currently persisted override, or `undefined` when using the safe default. */
  contributionBudgetBytes?: number;
  onChangeBudget: (bytes: number | undefined) => void;
  /** Live "what this budget actually affords you" reflection — computed
   * by the caller (needs `avgLayerBytes`/`totalLayers`/`driverLayers`,
   * which this component deliberately doesn't know about — it only knows
   * bytes). Already reflects `maxLayersOverride` when one is set (see
   * `App.tsx`'s `effectiveLayersHosted`) — this is the number the slider
   * below should default to. */
  layersHosted: number;
  totalLayers: number;
  approxGbLabel: string;
  /** "Layers to host: N of `totalLayers`" — a direct layer-count override
   * that supersedes the GB-based budget above. `undefined` = no override
   * yet (the slider still shows/defaults to `layersHosted`, it's just not
   * persisted until the user actually moves it). See
   * `useCommunalHost.ts`'s `maxLayersOverride` doc comment. */
  maxLayersOverride?: number;
  onChangeMaxLayers: (layers: number | undefined) => void;
  /** REUSE-STAGE0 — "Serve the first stage" opt-in. Reuses this device's
   * own already-loaded local stage-0 worker (the one that drives ITS OWN
   * chat) to also serve low-power/thin clients' entry stage, instead of a
   * separate GPU load. Off by default; see
   * `useCommunalChat`'s `serveFirstStage` doc comment. */
  serveFirstStage: boolean;
  onChangeServeFirstStage: (enabled: boolean) => void;
}

const FREE_TEXT_OPTION = '__free_text__';

export function ContributionPanel(props: ContributionPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const preselected = useMemo(() => matchGpuCatalog(props.detectedGpuName), [props.detectedGpuName]);
  const [selectedName, setSelectedName] = useState<string>(preselected?.name ?? FREE_TEXT_OPTION);
  const [manualGb, setManualGb] = useState('');
  const [probing, setProbing] = useState(false);
  const [probeMessage, setProbeMessage] = useState<string | undefined>(undefined);

  if (!expanded) {
    return (
      <button type="button" className="btn-link contribution-expand" onClick={() => setExpanded(true)}>
        Contribute more &#9656;
      </button>
    );
  }

  function applyCatalogPick(name: string): void {
    setSelectedName(name);
    if (name === FREE_TEXT_OPTION) return; // wait for a manual GB entry below
    const entry = findGpuCatalogEntryByName(name);
    if (entry) props.onChangeBudget(entry.vramBytes);
  }

  function applyManualGb(): void {
    const bytes = parseGbInput(manualGb);
    if (bytes !== undefined) props.onChangeBudget(bytes);
  }

  async function runProbe(): Promise<void> {
    setProbing(true);
    setProbeMessage(undefined);
    try {
      const result = await probeGpuAllocatableBytes();
      if (result.ok && result.vramBytes) {
        props.onChangeBudget(result.vramBytes);
        setProbeMessage(`Detected ~${formatVramLabel(result.vramBytes)} usable — budget updated.`);
      } else {
        setProbeMessage(result.reason ?? 'Auto-detect did not find any usable capacity.');
      }
    } finally {
      setProbing(false);
    }
  }

  return (
    <div className="contribution-panel" role="region" aria-label="Contribute more">
      <button type="button" className="btn-link contribution-collapse" onClick={() => setExpanded(false)}>
        Contribute more &#9662;
      </button>
      <p className="contribution-hint">
        Hosting up to {props.layersHosted} of {props.totalLayers} layers (~{props.approxGbLabel}). Pick your GPU, type a
        VRAM number, or auto-detect to raise this.
      </p>
      <p className="contribution-note">
        Prefer ONE tab with a higher budget over many tabs — co-located tabs count as one failure domain and share this
        origin&rsquo;s ~3.3GB disk cache and one GPU.
      </p>

      <label className="contribution-field">
        <span>GPU</span>
        <select className="contribution-select" value={selectedName} onChange={(e) => applyCatalogPick(e.target.value)}>
          <option value={FREE_TEXT_OPTION}>Type my own…</option>
          {GPU_CATALOG.map((entry) => (
            <option key={entry.name} value={entry.name}>
              {entry.name} (~{formatVramLabel(entry.vramBytes)})
            </option>
          ))}
        </select>
      </label>

      {selectedName === FREE_TEXT_OPTION && (
        <div className="contribution-field-row">
          <label className="contribution-field">
            <span>VRAM to contribute (GB)</span>
            <input
              type="number"
              className="contribution-gb-input"
              min="1"
              step="0.5"
              value={manualGb}
              onChange={(e) => setManualGb(e.target.value)}
              placeholder="e.g. 16"
            />
          </label>
          <button type="button" className="btn btn-ghost contribution-apply" onClick={applyManualGb} disabled={parseGbInput(manualGb) === undefined}>
            Use this budget
          </button>
        </div>
      )}

      <div className="contribution-probe-row">
        <button type="button" className="btn btn-ghost contribution-probe-btn" onClick={() => void runProbe()} disabled={probing}>
          {probing ? 'Detecting…' : 'Auto-detect (stresses your GPU)'}
        </button>
        {probeMessage && <span className="contribution-probe-message">{probeMessage}</span>}
      </div>

      {props.contributionBudgetBytes !== undefined && (
        <button type="button" className="btn-link contribution-reset" onClick={() => props.onChangeBudget(undefined)}>
          Reset to default (~1.6GB safe budget)
        </button>
      )}

      <label className="contribution-field contribution-layers-field">
        <span>
          Layers to host: {props.maxLayersOverride ?? props.layersHosted} of {props.totalLayers}
        </span>
        <input
          type="range"
          className="contribution-layers-slider"
          min={0}
          max={props.totalLayers}
          step={1}
          value={props.maxLayersOverride ?? props.layersHosted}
          onChange={(e) => props.onChangeMaxLayers(Number(e.target.value))}
        />
      </label>
      <p className="contribution-note contribution-layers-note">
        Prefer picking a GB budget above (it adapts to what your GPU can actually hold) — use this only if you'd rather
        just say how many layers to serve directly. Setting it overrides the GB budget's layer count.
      </p>

      {props.maxLayersOverride !== undefined && (
        <button type="button" className="btn-link contribution-reset" onClick={() => props.onChangeMaxLayers(undefined)}>
          Reset to GB-budget-derived layer count
        </button>
      )}

      <label className="contribution-field contribution-serve-first-stage-field">
        <input
          type="checkbox"
          checked={props.serveFirstStage}
          onChange={(e) => props.onChangeServeFirstStage(e.target.checked)}
        />
        <span>Serve the first stage — let low-power phones use your device as their entry point (may slow your own chat).</span>
      </label>
    </div>
  );
}
