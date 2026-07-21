import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalFolderFetch, createNullShardStore, fragmentRelativePath } from '../src/localFolderFetch.ts';
import { fetchAndCacheFragment, createMemoryShardStore, sha256Hex } from '@unstable-legion/stage-runtime';

/**
 * A minimal mock `FileSystemDirectoryHandle` — just enough of the File
 * System Access API surface (`getDirectoryHandle`/`getFileHandle`) for
 * `createLocalFolderFetch` to walk, backed by a plain nested-object "file
 * tree" (`{ shared: { 'embeddings.gguf': Uint8Array }, layers: {...} }`).
 * Throws `NotFoundError`-shaped errors for missing entries, matching the
 * real API's behavior closely enough for this module's try/catch fallback
 * to exercise correctly.
 */
type FileTree = { [name: string]: FileTree | Uint8Array };

function mockDirHandle(tree: FileTree): FileSystemDirectoryHandle {
  function wrap(node: FileTree): FileSystemDirectoryHandle {
    return {
      async getDirectoryHandle(name: string) {
        const entry = node[name];
        if (!entry || entry instanceof Uint8Array) {
          throw new DOMException(`directory ${name} not found`, 'NotFoundError');
        }
        return wrap(entry);
      },
      async getFileHandle(name: string) {
        const entry = node[name];
        if (!entry || !(entry instanceof Uint8Array)) {
          throw new DOMException(`file ${name} not found`, 'NotFoundError');
        }
        const bytes = entry;
        return {
          async getFile() {
            return new File([bytes], name);
          },
        } as unknown as FileSystemFileHandle;
      },
    } as unknown as FileSystemDirectoryHandle;
  }
  return wrap(tree);
}

test('fragmentRelativePath: extracts the shared/… or layers/… segment from a resolved fragment URL', () => {
  assert.equal(
    fragmentRelativePath('https://huggingface.co/wdunn001/legion-model-qwen3-8b/resolve/main/layers/layer-000.gguf'),
    'layers/layer-000.gguf',
  );
  assert.equal(
    fragmentRelativePath('https://huggingface.co/wdunn001/legion-model-qwen3-8b/resolve/main/shared/embeddings.gguf'),
    'shared/embeddings.gguf',
  );
  // Query string / fragment stripped.
  assert.equal(fragmentRelativePath('https://cdn.example.com/pkg/shared/output.gguf?v=2#frag'), 'shared/output.gguf');
});

test('fragmentRelativePath: returns undefined for a URL that is not a recognizable fragment path', () => {
  assert.equal(fragmentRelativePath('https://example.com/wasm/legion-stage.js'), undefined);
  assert.equal(fragmentRelativePath('https://huggingface.co/wdunn001/legion-model-qwen3-8b/resolve/main/model-package.json'), undefined);
});

test('createLocalFolderFetch: returns local bytes for a fragment present in the folder', async () => {
  const localBytes = new Uint8Array([1, 2, 3, 4, 5]);
  const dir = mockDirHandle({ layers: { 'layer-000.gguf': localBytes } });
  let fallbackCalled = false;
  const fallback = (async () => {
    fallbackCalled = true;
    return new Response('should not be used');
  }) as typeof fetch;

  const localFetch = createLocalFolderFetch(dir, fallback);
  const res = await localFetch('https://huggingface.co/wdunn001/legion-model-qwen3-8b/resolve/main/layers/layer-000.gguf');
  const got = new Uint8Array(await res.arrayBuffer());

  assert.deepEqual(got, localBytes);
  assert.equal(fallbackCalled, false);
});

test('createLocalFolderFetch: falls back for a fragment missing from a PARTIAL local folder — never throws', async () => {
  // The folder only has the embeddings shard; layer-000 is absent (a
  // partial local copy). The missing piece must still resolve via the
  // fallback, not throw.
  const dir = mockDirHandle({ shared: { 'embeddings.gguf': new Uint8Array([9, 9]) } });
  const networkBytes = new Uint8Array([7, 7, 7]);
  let fallbackInput: string | undefined;
  const fallback = (async (input: RequestInfo | URL) => {
    fallbackInput = String(input);
    return new Response(networkBytes);
  }) as typeof fetch;

  const localFetch = createLocalFolderFetch(dir, fallback);
  const res = await localFetch('https://huggingface.co/wdunn001/legion-model-qwen3-8b/resolve/main/layers/layer-000.gguf');
  const got = new Uint8Array(await res.arrayBuffer());

  assert.deepEqual(got, networkBytes);
  assert.equal(fallbackInput, 'https://huggingface.co/wdunn001/legion-model-qwen3-8b/resolve/main/layers/layer-000.gguf');
});

test('createLocalFolderFetch: falls back (never throws) for a URL that is not a fragment path at all', async () => {
  const dir = mockDirHandle({});
  let fallbackCalled = false;
  const fallback = (async () => {
    fallbackCalled = true;
    return new Response('glue module bytes');
  }) as typeof fetch;

  const localFetch = createLocalFolderFetch(dir, fallback);
  const res = await localFetch('https://example.com/wasm/legion-stage.js');
  assert.equal(await res.text(), 'glue module bytes');
  assert.equal(fallbackCalled, true);
});

test('createLocalFolderFetch: a stale/unreadable handle (getFile() throws) falls back instead of propagating', async () => {
  const dir: FileSystemDirectoryHandle = {
    async getDirectoryHandle() {
      throw new DOMException('folder moved', 'NotFoundError');
    },
    async getFileHandle() {
      throw new DOMException('folder moved', 'NotFoundError');
    },
  } as unknown as FileSystemDirectoryHandle;
  const fallback = (async () => new Response('network wins')) as typeof fetch;
  const localFetch = createLocalFolderFetch(dir, fallback);
  const res = await localFetch('https://huggingface.co/x/resolve/main/shared/metadata.gguf');
  assert.equal(await res.text(), 'network wins');
});

// ── SECURITY: the trust path is intact ──────────────────────────────────
//
// createLocalFolderFetch supplies ONLY bytes — it never inspects or trusts
// any hash. The actual security boundary is downstream, in stage-runtime's
// EXISTING `fetchAndCacheFragment` (shardCache.ts), which hashes whatever
// bytes its `fetchImpl` returns and throws when they don't match the
// fragment's `sha256` — a value that ALWAYS comes from the remote manifest,
// never from the local folder (createLocalFolderFetch has no manifest/hash
// concept at all — see its module doc comment). These tests feed
// createLocalFolderFetch's output straight into the real
// `fetchAndCacheFragment` to prove that chain end-to-end, rather than just
// asserting on createLocalFolderFetch in isolation.

test('SECURITY: correct local bytes pass fetchAndCacheFragment verification against the remote-sourced hash', async () => {
  const goodBytes = new Uint8Array([10, 20, 30, 40, 50]);
  const correctHash = sha256Hex(goodBytes);
  const dir = mockDirHandle({ layers: { 'layer-001.gguf': goodBytes } });
  const localFetch = createLocalFolderFetch(dir);

  const result = await fetchAndCacheFragment(
    {
      // Stands in for a fragment.url resolved by fragmentsForRange against
      // the REMOTE manifest — the sha256 below is likewise the REMOTE
      // manifest's value, never read from the folder.
      url: 'https://huggingface.co/wdunn001/legion-model-qwen3-8b/resolve/main/layers/layer-001.gguf',
      sha256: correctHash,
      bytes: goodBytes.byteLength,
      role: 'layer',
    },
    { fetchImpl: localFetch, store: createMemoryShardStore() },
  );

  assert.deepEqual(result.bytes, goodBytes);
});

test('createNullShardStore: never retains (get always misses, put discards) — so a folder load adds nothing to OPFS', async () => {
  const store = createNullShardStore();
  await store.put('some-hash.gguf', new Uint8Array([1, 2, 3]));
  assert.equal(await store.get('some-hash.gguf'), undefined, 'put must not retain — folder is the source of truth, no OPFS duplicate');
});

test('createNullShardStore: still verifies via fetchAndCacheFragment (put is skipped, hash check is NOT)', async () => {
  // Good bytes from the folder + the null store: verify passes, nothing cached.
  const goodBytes = new Uint8Array([5, 6, 7, 8]);
  const dir = mockDirHandle({ layers: { 'layer-003.gguf': goodBytes } });
  const result = await fetchAndCacheFragment(
    {
      url: 'https://huggingface.co/wdunn001/legion-model-qwen3-8b/resolve/main/layers/layer-003.gguf',
      sha256: sha256Hex(goodBytes),
      bytes: goodBytes.byteLength,
      role: 'layer',
    },
    { fetchImpl: createLocalFolderFetch(dir), store: createNullShardStore() },
  );
  assert.deepEqual(result.bytes, goodBytes);
});

test('SECURITY: a local file that does not match the remote manifest hash is REJECTED (fail-closed), not silently loaded', async () => {
  const tamperedBytes = new Uint8Array([1, 1, 1, 1, 1]); // what's actually on disk
  const officialHash = sha256Hex(new Uint8Array([2, 2, 2, 2, 2])); // what the REMOTE manifest says it should be
  const dir = mockDirHandle({ layers: { 'layer-002.gguf': tamperedBytes } });
  const localFetch = createLocalFolderFetch(dir);

  // This is fetchAndCacheFragment's OWN existing throw (shardCache.ts) —
  // createLocalFolderFetch does not add, remove, or wrap any check here.
  await assert.rejects(
    fetchAndCacheFragment(
      {
        url: 'https://huggingface.co/wdunn001/legion-model-qwen3-8b/resolve/main/layers/layer-002.gguf',
        sha256: officialHash,
        bytes: tamperedBytes.byteLength,
        role: 'layer',
      },
      { fetchImpl: localFetch, store: createMemoryShardStore() },
    ),
    /failed SHA-256 verification/,
  );
});
