import type { TopologySegmentView } from '../viewmodels/meshViewModels.js';

export function TopologyMap(props: { segments: readonly TopologySegmentView[]; totalLayers: number; modelLabel: string }) {
  return (
    <section className="mesh-card topology-map">
      <h3>Who's hosting {props.modelLabel}</h3>
      <div className="topology-bar">
        {props.segments.map((seg, i) => {
          const widthPct = ((seg.layerEnd - seg.layerStart) / props.totalLayers) * 100;
          return (
            <div
              key={i}
              className={`topology-segment topology-segment-${seg.kind}${seg.isSelf ? ' topology-segment-self' : ''}`}
              style={{ width: `${widthPct}%` }}
              title={`layers ${seg.layerStart}–${seg.layerEnd}${seg.label ? ` — ${seg.label}` : ' — needs a host'}`}
            >
              <span className="topology-segment-label">{seg.label ?? '?'}</span>
            </div>
          );
        })}
      </div>
      <div className="topology-legend">
        <span>
          <i className="topology-swatch topology-swatch-local" /> you
        </span>
        <span>
          <i className="topology-swatch topology-swatch-covered" /> hosted
        </span>
        <span>
          <i className="topology-swatch topology-swatch-gap" /> needs a host
        </span>
      </div>
    </section>
  );
}
