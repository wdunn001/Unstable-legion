/**
 * useHostingConsent's REUSE-STAGE0 "Serve the first stage" persistence —
 * `loadServeFirstStage`/`saveServeFirstStage` are exported specifically so
 * this sticky-localStorage contract is testable without rendering the hook
 * (this repo doesn't have a React test renderer — see the other
 * `useHostingConsent.ts` load/save pairs, none of which are hook-tested
 * either; only pure functions are). Installs a tiny in-memory
 * `localStorage` fake since `node --test` has no DOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadServeFirstStage,
  saveServeFirstStage,
  SERVE_FIRST_STAGE_STORAGE_KEY,
} from '../src/hooks/useHostingConsent.ts';

function fakeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

test('loadServeFirstStage: defaults to false when nothing persisted', () => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = fakeLocalStorage();
  assert.equal(loadServeFirstStage(), false);
});

test('saveServeFirstStage(true) then loadServeFirstStage(): round-trips true', () => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = fakeLocalStorage();
  saveServeFirstStage(true);
  assert.equal(loadServeFirstStage(), true);
});

test('saveServeFirstStage(false) after a prior true: clears the key, loads back false', () => {
  const ls = fakeLocalStorage();
  (globalThis as unknown as { localStorage: Storage }).localStorage = ls;
  saveServeFirstStage(true);
  assert.equal(ls.getItem(SERVE_FIRST_STAGE_STORAGE_KEY), '1');
  saveServeFirstStage(false);
  assert.equal(ls.getItem(SERVE_FIRST_STAGE_STORAGE_KEY), null);
  assert.equal(loadServeFirstStage(), false);
});

test('loadServeFirstStage: a garbage persisted value is treated as false, never throws', () => {
  const ls = fakeLocalStorage();
  (globalThis as unknown as { localStorage: Storage }).localStorage = ls;
  ls.setItem(SERVE_FIRST_STAGE_STORAGE_KEY, 'true'); // not the literal '1' this module writes
  assert.equal(loadServeFirstStage(), false);
});

test('loadServeFirstStage / saveServeFirstStage: no localStorage in the environment -> safe false / no-op, never throws', () => {
  const prev = (globalThis as unknown as { localStorage?: Storage }).localStorage;
  delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
  try {
    assert.equal(loadServeFirstStage(), false);
    assert.doesNotThrow(() => saveServeFirstStage(true));
  } finally {
    (globalThis as unknown as { localStorage?: Storage }).localStorage = prev;
  }
});
