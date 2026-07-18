/**
 * Driver-side host-health tracker — the anti-thrash primitive behind
 * "temporarily demote blockers and re-sort, heal slowly."
 *
 * A driver records what it EXPERIENCES from each remote host (attach
 * timeouts, mid-stream stalls, and "blocker" verdicts where a host's camped
 * layer range forces an unfillable non-contiguous gap). Repeat offenders
 * enter a COOLDOWN with exponential backoff so the planner stops handing them
 * work; a clean run decays the penalty so a recovered host is rehabilitated
 * rather than banned forever.
 *
 * Deliberately LOCAL to each driver — never a shared/broadcast reputation
 * (that would let one malicious peer poison everyone's view). Pure and
 * clock-injectable (`now`) so it unit-tests without wall-clock flakiness.
 *
 * The two ways a driver consumes it:
 *   - `excludedPeerIds()` -> feed into `buildCommunalTopology`'s
 *     `excludePeerIds` so a peer in cooldown isn't planned at all.
 *   - `penalty(peerId)` -> a soft [0,1) rank demotion for a peer that's
 *     flaky-but-not-yet-excluded, so it becomes a last resort, not a ban.
 */

/** What kind of trouble a host caused this driver. Weighted differently:
 * a graceful `stop` is lighter than a silent `attach` timeout or a
 * mid-stream `stall`; a `blocker` is the "your camped range makes the mesh
 * unsolvable" verdict the assembly raises. */
export type HostFailureKind = 'attach' | 'stall' | 'stop' | 'blocker';

const FAILURE_WEIGHT: Record<HostFailureKind, number> = {
  attach: 1,
  stall: 1,
  stop: 0.5,
  blocker: 1.5,
};

export interface HostHealthOptions {
  /** Weighted-strike total within `windowMs` that trips a cooldown. Default 3. */
  strikeThreshold?: number;
  /** Rolling window over which strikes accumulate (ms). Default 60_000. */
  windowMs?: number;
  /** First cooldown duration (ms); doubles per consecutive cooldown up to
   * `maxCooldownMs`. Default 30_000. */
  baseCooldownMs?: number;
  /** Cap on the backed-off cooldown (ms). Default 600_000 (10 min). */
  maxCooldownMs?: number;
  /** Injected clock for tests. Default `Date.now`. */
  now?: () => number;
}

interface HostRecord {
  /** Weighted strikes with their timestamps (pruned to `windowMs`). */
  strikes: { at: number; weight: number }[];
  /** now < cooldownUntil => excluded. 0 = not in cooldown. */
  cooldownUntil: number;
  /** Consecutive cooldowns served — drives the exponential backoff. Decays
   * on a clean run so a rehabilitated host resets its backoff. */
  cooldownCount: number;
}

export interface HostHealthSnapshotEntry {
  strikeWeight: number;
  excluded: boolean;
  cooldownUntil: number;
  cooldownCount: number;
}

export interface HostHealthTracker {
  /** Record a failure the driver attributed to `peerId`. */
  recordFailure(peerId: string, kind: HostFailureKind): void;
  /** Record that `peerId` served correctly — decays its penalty. */
  recordSuccess(peerId: string): void;
  /** Peers currently in cooldown (feed to `excludePeerIds`). */
  excludedPeerIds(): string[];
  isExcluded(peerId: string): boolean;
  /** Soft rank demotion in [0,1) for a flaky-but-not-excluded peer — 0 when
   * healthy, approaching 1 as it nears the exclusion threshold. */
  penalty(peerId: string): number;
  /** Debug/telemetry view (e.g. `window.__legionChat`). */
  snapshot(): Record<string, HostHealthSnapshotEntry>;
}

export function createHostHealthTracker(opts: HostHealthOptions = {}): HostHealthTracker {
  const strikeThreshold = opts.strikeThreshold ?? 3;
  const windowMs = opts.windowMs ?? 60_000;
  const baseCooldownMs = opts.baseCooldownMs ?? 30_000;
  const maxCooldownMs = opts.maxCooldownMs ?? 600_000;
  const now = opts.now ?? Date.now;

  const hosts = new Map<string, HostRecord>();

  function rec(peerId: string): HostRecord {
    let r = hosts.get(peerId);
    if (!r) {
      r = { strikes: [], cooldownUntil: 0, cooldownCount: 0 };
      hosts.set(peerId, r);
    }
    return r;
  }

  function prune(r: HostRecord, t: number): void {
    const cutoff = t - windowMs;
    if (r.strikes.length && r.strikes[0]!.at < cutoff) {
      r.strikes = r.strikes.filter((s) => s.at >= cutoff);
    }
  }

  function strikeWeight(r: HostRecord, t: number): number {
    prune(r, t);
    let sum = 0;
    for (const s of r.strikes) sum += s.weight;
    return sum;
  }

  return {
    recordFailure(peerId, kind) {
      const t = now();
      const r = rec(peerId);
      r.strikes.push({ at: t, weight: FAILURE_WEIGHT[kind] });
      if (strikeWeight(r, t) >= strikeThreshold && t >= r.cooldownUntil) {
        // Trip (or re-trip) a cooldown with exponential backoff.
        const dur = Math.min(maxCooldownMs, baseCooldownMs * 2 ** r.cooldownCount);
        r.cooldownUntil = t + dur;
        r.cooldownCount += 1;
        // Reset the strike window — the cooldown is the punishment; it takes a
        // fresh burst after it expires to trip again (backoff still climbs).
        r.strikes = [];
      }
    },

    recordSuccess(peerId) {
      const r = hosts.get(peerId);
      if (!r) return;
      // A clean run heals: clear strikes and step the backoff down one notch
      // so a recovered host isn't punished by its history forever. Fully
      // healthy (count 0, no strikes) => forget it entirely.
      r.strikes = [];
      if (r.cooldownCount > 0) r.cooldownCount -= 1;
      if (r.cooldownCount === 0) hosts.delete(peerId);
    },

    excludedPeerIds() {
      const t = now();
      const out: string[] = [];
      for (const [peerId, r] of hosts) if (t < r.cooldownUntil) out.push(peerId);
      return out;
    },

    isExcluded(peerId) {
      const r = hosts.get(peerId);
      return !!r && now() < r.cooldownUntil;
    },

    penalty(peerId) {
      const r = hosts.get(peerId);
      if (!r) return 0;
      const t = now();
      if (t < r.cooldownUntil) return 1;
      return Math.min(1, strikeWeight(r, t) / strikeThreshold);
    },

    snapshot() {
      const t = now();
      const out: Record<string, HostHealthSnapshotEntry> = {};
      for (const [peerId, r] of hosts) {
        out[peerId] = {
          strikeWeight: strikeWeight(r, t),
          excluded: t < r.cooldownUntil,
          cooldownUntil: r.cooldownUntil,
          cooldownCount: r.cooldownCount,
        };
      }
      return out;
    },
  };
}
