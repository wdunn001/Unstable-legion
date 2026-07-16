import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithStallWatchdog, StallTimeoutError } from '../src/loadWatchdog.ts';

/** Deterministic fake clock — `advance(ms)` fires every due timer (in
 * fireAt order), including ones newly scheduled by a firing callback
 * (e.g. `armStall` rescheduling itself), so tests never depend on real
 * wall-clock time. */
function createFakeClock() {
  let nextId = 1;
  let now = 0;
  const timers = new Map<number, { fireAt: number; cb: () => void }>();
  const setTimeoutImpl = ((cb: () => void, ms: number) => {
    const id = nextId++;
    timers.set(id, { fireAt: now + ms, cb });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimeoutImpl = ((id: unknown) => {
    timers.delete(id as number);
  }) as typeof clearTimeout;
  function advance(ms: number): void {
    now += ms;
    for (;;) {
      let dueId: number | undefined;
      let dueAt = Infinity;
      for (const [id, t] of timers) {
        if (t.fireAt <= now && t.fireAt < dueAt) {
          dueId = id;
          dueAt = t.fireAt;
        }
      }
      if (dueId === undefined) return;
      const t = timers.get(dueId)!;
      timers.delete(dueId);
      t.cb();
    }
  }
  return { setTimeoutImpl, clearTimeoutImpl, advance };
}

test('runWithStallWatchdog: resolves with work\'s value when it finishes before any timeout', async () => {
  const clock = createFakeClock();
  const result = await runWithStallWatchdog(async () => 'ok', {
    stallMs: 1000,
    ceilingMs: 100_000,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
  });
  assert.equal(result, 'ok');
});

test('runWithStallWatchdog: a normal work-thrown error propagates unchanged (not mistaken for a stall)', async () => {
  const clock = createFakeClock();
  const resultPromise = runWithStallWatchdog(
    async () => {
      throw new Error('boom');
    },
    { stallMs: 1000, ceilingMs: 100_000, setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl },
  );
  await assert.rejects(resultPromise, /boom/);
});

test('runWithStallWatchdog: fires a StallTimeoutError when no progress arrives within stallMs', async () => {
  const clock = createFakeClock();
  const never = new Promise<void>(() => undefined); // never settles on its own
  const resultPromise = runWithStallWatchdog(() => never, {
    stallMs: 1000,
    ceilingMs: 100_000,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
  });
  clock.advance(1000);
  await assert.rejects(resultPromise, StallTimeoutError);
  await assert.rejects(resultPromise, /no progress for 1000ms/);
});

test('runWithStallWatchdog: progressTick() resets the stall clock — a steady trickle never stalls even past stallMs total', async () => {
  const clock = createFakeClock();
  let resolveWork: (v: string) => void = () => undefined;
  const workDone = new Promise<string>((resolve) => {
    resolveWork = resolve;
  });

  const resultPromise = runWithStallWatchdog(
    (progressTick) => {
      // 5 ticks, 800ms apart — each individual gap is under the 1000ms
      // stall window, but the TOTAL elapsed time (4000ms) comfortably
      // exceeds it. A flat (non-resetting) timeout would have fired.
      let count = 0;
      const tick = (): void => {
        count++;
        progressTick();
        if (count < 5) clock.setTimeoutImpl(tick, 800);
        else resolveWork('done');
      };
      clock.setTimeoutImpl(tick, 800);
      return workDone;
    },
    { stallMs: 1000, ceilingMs: 100_000, setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl },
  );

  for (let i = 0; i < 5; i++) clock.advance(800);
  assert.equal(await resultPromise, 'done');
});

test('runWithStallWatchdog: ceilingMs fires as a generous backstop even with continuous progress', async () => {
  const clock = createFakeClock();
  const resultPromise = runWithStallWatchdog(
    (progressTick) => {
      const loop = (): void => {
        progressTick();
        clock.setTimeoutImpl(loop, 100);
      };
      clock.setTimeoutImpl(loop, 100);
      return new Promise<void>(() => undefined); // never resolves on its own
    },
    { stallMs: 100_000, ceilingMs: 500, setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl },
  );

  for (let i = 0; i < 6; i++) clock.advance(100);
  await assert.rejects(resultPromise, /overall ceiling of 500ms/);
});

test('runWithStallWatchdog: a stall timeout does not also fire the ceiling timeout afterward', async () => {
  const clock = createFakeClock();
  const never = new Promise<void>(() => undefined);
  const resultPromise = runWithStallWatchdog(() => never, {
    stallMs: 100,
    ceilingMs: 200,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
  });
  clock.advance(100); // stall fires first
  await assert.rejects(resultPromise, /no progress/);
  // Advancing further must not throw an unhandled rejection from a
  // second (ceiling) timer still pending — the stall firing must have
  // cleared it.
  assert.doesNotThrow(() => clock.advance(1000));
});
