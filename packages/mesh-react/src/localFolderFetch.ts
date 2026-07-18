/**
 * Local-model-folder loading — lets a user who already has a clone of the
 * model package on disk (the HF repo, or a `.88`-sliced copy) point the
 * chat app at that folder instead of downloading every fragment over the
 * network.
 *
 * TRUST MODEL (read this before touching anything here):
 *   - The MANIFEST (`model-package.json`, carrying a `sha256` for every
 *     fragment) always comes from the REMOTE source
 *     (`resolveChatModelConfig().manifestUrl` — Hugging Face primary +
 *     same-origin mirror fallback). This module NEVER reads a manifest or
 *     a hash from the local folder — it has no idea what the "right"
 *     bytes even look like, and doesn't need to.
 *   - The local folder supplies BYTES ONLY. Every fragment this module
 *     returns still flows through the EXISTING verify path
 *     (`fetchAndCacheFragment` in `@unstable-legion/stage-runtime`'s
 *     `shardCache.ts`), which hashes the bytes and compares them against
 *     the REMOTE manifest's `sha256` — unchanged, not bypassed, not
 *     weakened. A corrupt or tampered local file fails that hash check
 *     exactly like a corrupt network response and the load is refused
 *     (see `shardCache.ts`'s `fetchAndCacheFragment` — it throws on a
 *     mismatch; nothing in this module or its caller catches/suppresses
 *     that throw).
 *   - Net effect: pointing this at an untrusted/malicious folder cannot
 *     make a bad layer load — the worst it can do is serve WRONG bytes
 *     for a fragment, which the downstream hash check turns into a hard
 *     failure ("failed SHA-256 verification"), never a silent load.
 *
 * This module ONLY changes WHERE fragment bytes come from (folder vs.
 * network) — it plugs into `loadStage`'s existing `fetchImpl` seam
 * (`legion-stage-runtime`'s `LoadStageOptions.fetchImpl`), so nothing
 * about the verify path, the manifest resolution, or the caching layer
 * needs to change (or even know this exists).
 */

/** Manifest-relative directory segments a layer-package fragment's
 * resolved URL always contains (see legion-stage-runtime's `manifest.ts`:
 * `shared/{metadata,embeddings,output}.gguf` + `layers/layer-NNNNN.gguf`,
 * resolved via `new URL(fragment.path, manifestUrl)`). Order matters only
 * in that both are checked; a URL containing neither isn't a fragment this
 * module knows how to serve locally (falls back to the network). */
const FRAGMENT_DIR_MARKERS = ['/shared/', '/layers/'] as const;

/** Best-effort string form of whatever `fetch`-compatible callers pass as
 * their first argument (a plain URL string, a `URL`, or a `Request`) — the
 * stage-runtime loader only ever calls its `fetchImpl` with a plain string
 * URL (see `wasm-loader.ts`/`shardCache.ts`), but this stays defensive
 * against a `Request` object too so it behaves like a real `fetch` drop-in. */
function urlStringFrom(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Derive a fragment's manifest-relative path (`shared/embeddings.gguf`,
 * `layers/layer-000.gguf`) from its RESOLVED absolute URL, by locating the
 * trailing `shared/…`/`layers/…` segment — the manifest itself only ever
 * carries paths relative to its own URL (see `fragmentsForRange`'s doc
 * comment in legion-stage-runtime's manifest.ts), so this is the inverse
 * of that resolution, not a guess. Strips any query string/fragment first
 * (a CDN mirror may append cache-busting params). Returns `undefined` for
 * a URL that isn't a recognizable fragment path (e.g. the wasm glue module,
 * or a manifest fetch itself) — the caller falls back to the network for
 * those, exactly as if this module didn't exist.
 */
export function fragmentRelativePath(url: string): string | undefined {
  const clean = url.split('?')[0]!.split('#')[0]!;
  for (const marker of FRAGMENT_DIR_MARKERS) {
    const idx = clean.lastIndexOf(marker);
    if (idx !== -1) return clean.slice(idx + 1); // drop the leading '/'
  }
  return undefined;
}

/**
 * Walk `root` by the fragment's relative path (`shared/embeddings.gguf` ->
 * `root.getDirectoryHandle('shared').getFileHandle('embeddings.gguf')`)
 * and return its bytes as a `File`. Throws (NotFoundError, or a permission/
 * IO error) exactly when the browser's own File System Access API throws —
 * the caller is responsible for treating any throw as "not available
 * locally" and falling back, per this module's "never throw on a missing
 * file" contract.
 */
async function readFragmentFromFolder(root: FileSystemDirectoryHandle, relativePath: string): Promise<File> {
  const parts = relativePath.split('/').filter(Boolean);
  if (parts.length === 0) throw new Error(`empty relative path`);
  let dir = root;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i]!);
  }
  const fileHandle = await dir.getFileHandle(parts[parts.length - 1]!);
  return fileHandle.getFile();
}

/**
 * Builds a `fetch`-compatible function that serves GGUF fragment bytes
 * from `dirHandle` (a folder the user picked via `showDirectoryPicker`),
 * falling back to `fallback` (real `fetch` by default) for anything the
 * folder doesn't have — the wasm glue module, the manifest itself
 * (deliberately never served locally — see this module's doc comment),
 * and any fragment missing from a PARTIAL local copy (so a folder that's
 * missing a few layers still works: those download normally and get
 * verified exactly like every other fragment).
 *
 * Never throws for a missing/unreadable local file — a stale handle (folder
 * moved/deleted since picking), a revoked permission, or a fragment simply
 * not present in this folder all fall through to `fallback` rather than
 * aborting the load. The ONLY thing that can still fail the load is the
 * EXISTING downstream hash check in `fetchAndCacheFragment` — see this
 * module's top doc comment.
 *
 * Pass the result as `loadStage`'s `opts.fetchImpl` (see
 * `apps/chat/src/workers/stageWorker.ts`'s `case 'load'`).
 */
export function createLocalFolderFetch(dirHandle: FileSystemDirectoryHandle, fallback: typeof fetch = fetch): typeof fetch {
  return async function localFolderFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const relativePath = fragmentRelativePath(urlStringFrom(input));
    if (relativePath) {
      try {
        const file = await readFragmentFromFolder(dirHandle, relativePath);
        return new Response(file);
      } catch {
        // Not in the folder (or unreadable) — fall through to the network.
        // Deliberately swallowed: see this function's "never throw on a
        // missing file" contract above.
      }
    }
    return fallback(input as RequestInfo, init);
  };
}
