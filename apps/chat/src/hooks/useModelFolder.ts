/**
 * useModelFolder — "load model layers from a local folder" (Chrome/Edge
 * only — the File System Access API). Lets a user who already has the
 * model package on disk (a clone of the HF repo, or a `.88` slice) point
 * the app at that folder instead of downloading every fragment.
 *
 * TRUST MODEL: this hook only ever hands out a `FileSystemDirectoryHandle`
 * — a source of BYTES. It never reads a manifest or a hash from the
 * folder. The manifest (and every fragment's sha256) still comes from the
 * REMOTE source (`resolveChatModelConfig().manifestUrl`) exactly as
 * before, and every fragment this folder supplies is still verified
 * against that remote manifest by the existing `fetchAndCacheFragment`
 * path (see `@unstable-legion/react`'s `localFolderFetch.ts` for the full
 * writeup — this hook is purely "pick a folder, remember it, keep its
 * permission alive"; the actual byte-substitution + verification live
 * downstream, unmodified by anything here).
 *
 * Persistence: `FileSystemDirectoryHandle` is structured-cloneable and IDB
 * supports storing it directly (the standard File System Access API
 * persistence pattern) — a tiny inline IndexedDB wrapper (no dependency)
 * remembers the picked folder across visits. A restored handle's granted
 * permission does NOT necessarily survive a browser restart, so every
 * mount re-verifies via `queryPermission`/`requestPermission({mode:
 * 'read'})` before trusting it again.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const DB_NAME = 'unstable-legion-chat';
const DB_VERSION = 1;
const STORE_NAME = 'model-folder';
const HANDLE_KEY = 'handle';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

async function idbGetHandle(): Promise<FileSystemDirectoryHandle | undefined> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(HANDLE_KEY);
      req.onsuccess = () => resolve(req.result as FileSystemDirectoryHandle | undefined);
      req.onerror = () => reject(req.error ?? new Error('indexedDB get failed'));
    });
  } finally {
    db.close();
  }
}

async function idbSetHandle(handle: FileSystemDirectoryHandle | undefined): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      if (handle === undefined) tx.objectStore(STORE_NAME).delete(HANDLE_KEY);
      else tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB write failed'));
    });
  } finally {
    db.close();
  }
}

/** `queryPermission` (no user gesture needed) first; only falls to
 * `requestPermission` (may silently no-op without a gesture — a mount
 * effect has none — but some browsers still honor a previously-granted
 * origin) when the query itself doesn't already say 'granted'. Missing
 * methods entirely (a handle shape this hook didn't create, or a browser
 * that predates the permission API) are treated as NOT granted rather than
 * thrown — the caller falls back to "needs permission" UI either way. */
async function hasReadPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    if ((await handle.queryPermission?.({ mode: 'read' })) === 'granted') return true;
    if ((await handle.requestPermission?.({ mode: 'read' })) === 'granted') return true;
  } catch {
    // best-effort — any failure here just means "not granted"
  }
  return false;
}

export interface UseModelFolderHandle {
  /** The active, permission-verified folder handle, or `undefined` when
   * none is picked (or a restored one's permission couldn't be
   * re-verified — see `needsPermission`). */
  handle: FileSystemDirectoryHandle | undefined;
  /** Open the browser's directory picker (`showDirectoryPicker({mode:
   * 'read'})`), persist the result, and make it active. A no-op when
   * `!supported`. User cancellation (AbortError) is silent, not an error. */
  pick: () => Promise<void>;
  /** Stop using the local folder (falls back to downloads) and forget it. */
  clear: () => Promise<void>;
  /** `true` only in Chrome/Edge (or any browser implementing
   * `showDirectoryPicker`) — feature-detected, not sniffed. */
  supported: boolean;
  /** `true` when IndexedDB remembers a folder from a previous visit but
   * its read permission could not be silently re-verified this time — the
   * UI should offer a re-pick (picking again re-grants, since it's a user
   * gesture) rather than claiming the folder is active. */
  needsPermission: boolean;
  /** Set when `pick()`'s `showDirectoryPicker()` call itself failed for a
   * reason OTHER than the user cancelling (e.g. a genuinely unsupported
   * browser despite the feature-detect, or a denied permission prompt). */
  error?: string;
}

export function useModelFolder(): UseModelFolderHandle {
  const supported = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
  const [handle, setHandle] = useState<FileSystemDirectoryHandle | undefined>(undefined);
  const [needsPermission, setNeedsPermission] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // Guards the restore effect below against setting state after a `clear()`/
  // fresh `pick()` already raced ahead of it (both StrictMode double-invoke
  // and a fast user click before the async restore settles).
  const restoreTokenRef = useRef(0);

  useEffect(() => {
    if (!supported) return;
    const token = ++restoreTokenRef.current;
    void (async () => {
      let stored: FileSystemDirectoryHandle | undefined;
      try {
        stored = await idbGetHandle();
      } catch {
        return; // no persisted folder (or IDB unavailable) — stay inactive
      }
      if (!stored || restoreTokenRef.current !== token) return;
      const granted = await hasReadPermission(stored);
      if (restoreTokenRef.current !== token) return;
      if (granted) setHandle(stored);
      else setNeedsPermission(true);
    })();
  }, [supported]);

  const pick = useCallback(async () => {
    if (!supported || !window.showDirectoryPicker) return;
    setError(undefined);
    try {
      const dir = await window.showDirectoryPicker({ mode: 'read' });
      restoreTokenRef.current++; // supersede any still-in-flight restore
      await idbSetHandle(dir).catch(() => undefined); // persistence is best-effort
      setNeedsPermission(false);
      setHandle(dir);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return; // user cancelled — not an error
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [supported]);

  const clear = useCallback(async () => {
    restoreTokenRef.current++;
    setHandle(undefined);
    setNeedsPermission(false);
    setError(undefined);
    await idbSetHandle(undefined).catch(() => undefined);
  }, []);

  return { handle, pick, clear, supported, needsPermission, error };
}
