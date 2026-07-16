import type { CapacityView } from '../viewmodels/meshViewModels.js';

export function CapacityMeter(props: { capacity: CapacityView }) {
  const { capacity } = props;
  return (
    <section className="mesh-card capacity-meter">
      <h3>Model capacity</h3>
      {/* Product requirement: never a bare percentage — the model being
       * assembled/served is named on every status this card shows. */}
      <div className="capacity-status-line">{capacity.statusLine}</div>
      <div className="capacity-bar-track" role="progressbar" aria-valuenow={capacity.coveragePercent} aria-valuemin={0} aria-valuemax={100}>
        <div
          className={`capacity-bar-fill ${capacity.ready ? 'capacity-bar-fill-ready' : 'capacity-bar-fill-gap'}`}
          style={{ width: `${capacity.coveragePercent}%` }}
        />
      </div>
      {!capacity.ready && <div className="capacity-gap-cta">{capacity.gapMessage}</div>}
    </section>
  );
}
