import type { CrewScaleView, TopologySegmentView } from '../viewmodels/meshViewModels.js';

export function TopologyMap(props: {
  segments: readonly TopologySegmentView[];
  totalLayers: number;
  modelLabel: string;
  scale?: CrewScaleView;
}) {
  return (
    <section className="mesh-card topology-map">
      <h3>Who's hosting {props.modelLabel}</h3>
      {props.scale && (
        <p className="topology-scale" title="Hosts you've discovered covering this model — your crew. A wider census across the whole mesh is separate.">
          <span aria-hidden="true">👥 </span>
          {props.scale.label} <span className="topology-scale-scope">· your crew</span>
        </p>
      )}
      <div className="topology-bar">
        {props.segments.map((seg, i) => {
          const widthPct = ((seg.layerEnd - seg.layerStart) / props.totalLayers) * 100;
          const extra = seg.hostCount && seg.hostCount > 1 ? seg.hostCount - 1 : 0;
          const title =
            `layers ${seg.layerStart}–${seg.layerEnd}` +
            (seg.label ? ` — ${seg.label}` : ' — needs a host') +
            (extra > 0 ? ` (+${extra} more host${extra === 1 ? '' : 's'} covering this range)` : '');
          return (
            <div
              key={i}
              className={`topology-segment topology-segment-${seg.kind}${seg.isSelf ? ' topology-segment-self' : ''}`}
              style={{ width: `${widthPct}%` }}
              title={title}
            >
              <span className="topology-segment-label">{seg.label ?? '?'}</span>
              {extra > 0 && <span className="topology-segment-more">+{extra}</span>}
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
