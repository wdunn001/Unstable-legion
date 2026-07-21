/**
 * threadStore — small typed IndexedDB wrapper for conversation
 * persistence. No IndexedDB layer existed anywhere in this repo before
 * this app; everything here is hand-rolled (no `idb` dependency) since
 * the surface needed is tiny: one object store, keyed by thread id,
 * indexed by `updatedAt` for recency ordering.
 *
 * Every function is a plain Promise-returning function over a shared
 * lazily-opened `IDBDatabase` — no React here, so it's testable with
 * `fake-indexeddb` under plain `node:test` (see test/threadStore.test.ts)
 * and reusable outside a component if this app ever needs it (a service
 * worker, an export/import feature, etc).
 */

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  /** True when this assistant message's generation lived through a
   * mid-stream host death that the communal pipeline recovered from
   * (continue-from-history) — surfaced as a "reconnected" indicator,
   * not an error (see `useCommunalChat`'s `restartCount`). */
  reconnected?: boolean;
  /** Tool activity behind this assistant message, one human-readable line
   * per round (e.g. `current_time → ok · served by @nick`). Rendered as
   * chips above the content; deliberately NOT folded back into prompts
   * (the raw tool exchange re-enters context via chatPrompt's `rounds`
   * during the exchange, and is summarized by the final text after). */
  toolTrace?: string[];
  /** Decode throughput of this assistant message's generation, in tokens
   * per second (first generated token → last; see useCommunalChat's
   * `ChatGenTiming`). Rendered as a small metric badge under the message.
   * Undefined for user messages and for generations too short to measure
   * (fewer than 2 tokens). */
  tokPerSec?: number;
}

export interface ChatThread {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

const DB_NAME = 'unstable-legion-chat';
// v2 REPAIR: a prior build's useModelFolder shared this DB name but declared a
// different store ('model-folder') at v1, so if it opened first it created the
// DB WITHOUT 'threads' — leaving putThread/getThreads throwing "object store
// not found". Bumping the version fires onupgradeneeded on those DBs and the
// guard below recreates 'threads'. Healthy DBs (already have 'threads') no-op.
// (useModelFolder now uses its OWN DB, so this collision can't recur.)
const DB_VERSION = 2;
const STORE = 'threads';

let dbPromise: Promise<IDBDatabase> | null = null;
/** Mirrors the resolved value of `dbPromise` so `_resetDbHandleForTests`
 * can `.close()` it before deleting — an open connection otherwise makes
 * `indexedDB.deleteDatabase` hang waiting on a `blocked` resolution that
 * never fires deterministically in every implementation. */
let dbInstance: IDBDatabase | null = null;

/** Drop the cached connection so the NEXT call reopens a fresh one. Called
 * when a connection closes (storage-pressure eviction, a `versionchange`
 * from another tab, or the browser reclaiming it) or errors — otherwise
 * `openDb` keeps handing back a dead handle whose `.transaction()` throws
 * `InvalidStateError: The database connection is closing`. This is exactly
 * what a full disk triggers: the UA closes the IDB connection under storage
 * pressure and every subsequent putThread failed until a reload. */
function clearDbCache(): void {
  dbPromise = null;
  dbInstance = null;
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      dbInstance = db;
      // A closed connection must not stay cached. `close` fires on UA
      // eviction; `versionchange` fires when another tab upgrades the DB —
      // close our handle so theirs isn't blocked, then reopen on next use.
      db.onclose = () => {
        if (dbInstance === db) clearDbCache();
      };
      db.onversionchange = () => {
        db.close();
        if (dbInstance === db) clearDbCache();
      };
      resolve(db);
    };
    req.onerror = () => {
      clearDbCache();
      reject(req.error ?? new Error('failed to open IndexedDB'));
    };
  });
  return dbPromise;
}

/** Run one transaction, reopening once if the cached connection was closing.
 * `db.transaction()` throws `InvalidStateError` synchronously on a closing
 * connection; that single retry (with a freshly reopened db) turns a hard
 * failure into a transparent recovery. Any other error propagates. */
async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | { result?: T },
  read: boolean,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const req = run(store) as IDBRequest<T>;
      if (read) {
        return await promisifyRequest(req);
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
      });
      return req.result as T;
    } catch (err) {
      if (
        attempt === 0 &&
        err instanceof DOMException &&
        err.name === 'InvalidStateError'
      ) {
        clearDbCache();
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/** All threads, most-recently-updated first. */
export async function listThreads(): Promise<ChatThread[]> {
  const threads = await withStore<ChatThread[]>(
    'readonly',
    (store) => store.index('updatedAt').getAll(),
    true,
  );
  return threads.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getThread(id: string): Promise<ChatThread | undefined> {
  return withStore<ChatThread | undefined>('readonly', (store) => store.get(id), true);
}

export async function putThread(thread: ChatThread): Promise<void> {
  await withStore<IDBValidKey>('readwrite', (store) => store.put(thread), false);
}

export async function deleteThread(id: string): Promise<void> {
  await withStore<undefined>('readwrite', (store) => store.delete(id), false);
}

/** Test-only escape hatch: drops the whole database and forces the next
 * call to any of the above to re-open a fresh one. `fake-indexeddb`
 * (like real IndexedDB) persists data across `open()` calls for the same
 * DB name within one process/tab — just clearing the cached `dbPromise`
 * re-opens the SAME populated database, so tests need an actual delete,
 * not just a handle reset. Production code never calls this. */
export function _resetDbHandleForTests(): Promise<void> {
  dbPromise = null;
  dbInstance?.close();
  dbInstance = null;
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('failed to delete test database'));
    req.onblocked = () => resolve();
  });
}

/** First ~48 chars of the first user message, single-lined — the
 * auto-title convention. Falls back to "New chat" for an empty thread. */
export function autoTitle(firstUserMessage: string | undefined): string {
  if (!firstUserMessage) return 'New chat';
  const oneLine = firstUserMessage.replace(/\s+/g, ' ').trim();
  if (!oneLine) return 'New chat';
  return oneLine.length > 48 ? `${oneLine.slice(0, 48)}…` : oneLine;
}

let idCounter = 0;
/** Sortable-enough unique id: timestamp + counter + a little randomness.
 * Not a UUID — this app has no cross-device sync story, so collision
 * resistance only needs to hold within one browser's IndexedDB. */
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
