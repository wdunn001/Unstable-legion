/**
 * Progress-based "stall" watchdog for a long-running async operation whose
 * total duration is unbounded (a multi-GB model download over a slow
 * link) but whose HEALTH is observable via periodic progress signals.
 *
 * `useStageHost.ts`'s `ensureWorkerLoaded` used to race a stage-worker
 * load against a FIXED total timeout (`loadDeadlineMs`, 240_000ms) — a
 * single number can't tell "still downloading, slowly" apart from "worker
 * died silently or stalled". Observed live: loading Qwen3-8B (4.7GB)
 * tripped the 240s ceiling mid-download on an ordinary link, killing a
 * perfectly healthy load —
 *
 *   "[chat] [stage-host] preload FAILED layers=[2,36): stage worker load
 *    exceeded 240000ms (worker died silently or stalled)"
 *
 * — after which it restarted, re-served from the OPFS cache, and limped
 * forward. The fix: reset the deadline on every progress tick (the same
 * per-shard signal `wasm-loader.ts`'s `onProgress` now emits — see
 * `stageWorkerProtocol.ts`'s `progress` response) and only fail on a
 * genuine STALL (no progress for `stallMs`). `ceilingMs` is a generous
 * backstop against a pathological "infinite trickle of progress, never
 * actually finishes" case — it is NOT the primary timeout.
 */

export interface StallWatchdogOptions {
  /** No-progress timeout (ms) — reset on every `progressTick()` call. */
  stallMs: number;
  /** Generous overall ceiling (ms) that fires regardless of progress. */
  ceilingMs: number;
  /** Injectable timer functions (tests only) — default to the real
   * `setTimeout`/`clearTimeout`. */
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

/** Distinguishes a watchdog-triggered rejection (stall or ceiling) from
 * whatever error `work` itself might throw — lets a caller log/handle the
 * two cases differently if it wants to. */
export class StallTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StallTimeoutError';
  }
}

/**
 * Runs `work(progressTick)` racing against the watchdog. `work` MUST call
 * the supplied `progressTick()` on every progress signal it observes (a
 * shard finishing, etc.) — that resets the stall clock. Resolves/rejects
 * with whatever `work` settles to, UNLESS the watchdog fires first: then
 * rejects with a `StallTimeoutError` (no progress for `stallMs`, or the
 * unconditional `ceilingMs` backstop) and `work`'s own eventual
 * settlement (it isn't cancelled — cooperative cancellation isn't
 * available here — just wasted work) is ignored.
 */
export function runWithStallWatchdog<T>(
  work: (progressTick: () => void) => Promise<T>,
  opts: StallWatchdogOptions,
): Promise<T> {
  const setT = opts.setTimeoutImpl ?? setTimeout;
  const clearT = opts.clearTimeoutImpl ?? clearTimeout;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let stallHandle: ReturnType<typeof setTimeout> | undefined;

    const ceilingHandle = setT(() => {
      if (settled) return;
      settled = true;
      if (stallHandle !== undefined) clearT(stallHandle);
      reject(new StallTimeoutError(`operation exceeded its overall ceiling of ${opts.ceilingMs}ms`));
    }, opts.ceilingMs);

    const armStall = (): void => {
      if (settled) return;
      if (stallHandle !== undefined) clearT(stallHandle);
      stallHandle = setT(() => {
        if (settled) return;
        settled = true;
        clearT(ceilingHandle);
        reject(new StallTimeoutError(`no progress for ${opts.stallMs}ms (worker died silently or stalled)`));
      }, opts.stallMs);
    };
    armStall();

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearT(ceilingHandle);
      if (stallHandle !== undefined) clearT(stallHandle);
      fn();
    };

    work(() => armStall()).then(
      (value) => settle(() => resolve(value)),
      (err: unknown) => settle(() => reject(err instanceof Error ? err : new Error(String(err)))),
    );
  });
}
