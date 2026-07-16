import type { OccupancyView } from '../viewmodels/meshViewModels.js';

/** The OCCUPANCY meter — "now that the model's up, how much room-wide
 * chat headroom is there." Only rendered once the coverage meter reports
 * `ready` (see App.tsx — `capacity.occupancy` is `undefined` until then).
 * A SEPARATE card from `CapacityMeter` on purpose: this is never a call
 * for more hosts, so it must never visually blend into the meter that
 * is. Shows an occupancy fraction, never a bare free count, and frames
 * zero headroom as a soft queue, never "full"/"blocked". */
export function OccupancyMeter(props: { occupancy: OccupancyView }) {
  const { occupancy } = props;
  const pctActive = occupancy.total > 0 ? Math.round((occupancy.active / occupancy.total) * 100) : 0;
  return (
    <section className="mesh-card occupancy-meter">
      <h3>Chat headroom</h3>
      <div className={`occupancy-label ${occupancy.atCapacity ? 'occupancy-label-busy' : ''}`}>{occupancy.label}</div>
      {!occupancy.atCapacity && (
        <div className="occupancy-bar-track" role="progressbar" aria-valuenow={pctActive} aria-valuemin={0} aria-valuemax={100}>
          <div className="occupancy-bar-fill" style={{ width: `${pctActive}%` }} />
        </div>
      )}
    </section>
  );
}
