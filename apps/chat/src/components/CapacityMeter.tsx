import type { CapacityView } from '../viewmodels/meshViewModels.js';

/** The COVERAGE meter — "is the model assembled / does it need hosts."
 * Deliberately its own card, visually separate from `OccupancyMeter`
 * (see meshViewModels.ts's module doc comment) — this one IS the "needs
 * more hosts" signal; occupancy never is. */
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
