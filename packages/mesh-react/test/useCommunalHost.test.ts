/**
 * resolveCommunalShardPlan unit tests — the manifest-vs-fallback and
 * OPFS-quota-vs-memory-store decision logic `useCommunalHost.ts` uses to
 * turn a claimed layer range into what `useStageHost`'s `preloadStage`
 * should fetch. No React rendering needed — this function is pure enough
 * to drive directly with a mock `fetch`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCommunalShardPlan, OPFS_QUOTA_CEILING_BYTES } from '../src/useCommunalHost.ts';

function fakeManifest(layerCount: number, perLayerBytes: number) {
  return {
    schema_version: 1,
    model_id: 'm',
    format: 'layer-package',
    layer_count: layerCount,
    activation_width: 1024,
    shared: {
      metadata: { path: 'shared/metadata.gguf', tensor_count: 1, tensor_bytes: 1000, artifact_bytes: 1000, sha256: 'a'.repeat(64) },
      embeddings: { path: 'shared/embeddings.gguf', tensor_count: 1, tensor_bytes: 5000, artifact_bytes: 5000, sha256: 'b'.repeat(64) },
      output: { path: 'shared/output.gguf', tensor_count: 2, tensor_bytes: 5000, artifact_bytes: 5000, sha256: 'c'.repeat(64) },
    },
    layers: Array.from({ length: layerCount }, (_, i) => ({
      path: `layers/layer-${String(i).padStart(5, '0')}.gguf`,
      layer_index: i,
      tensor_count: 9,
      tensor_bytes: perLayerBytes,
      artifact_bytes: perLayerBytes,
      sha256: i.toString(16).padStart(64, '0'),
    })),
  };
}

function fetchReturning(json: unknown): typeof fetch {
  return (async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => json }) as unknown as Response) as unknown as typeof fetch;
}

test('resolveCommunalShardPlan: no manifestUrl -> falls back to fallbackShardUrls, no hashes, no memory store', async () => {
  const { plan } = await resolveCommunalShardPlan(
    { layerStart: 2, layerEnd: 10, includeOutput: false },
    { fallbackShardUrls: () => ['/webllm/stages/m/full.gguf'], opfsQuotaBytes: OPFS_QUOTA_CEILING_BYTES },
  );
  assert.deepEqual(plan.shardUrls, ['/webllm/stages/m/full.gguf']);
  assert.equal(plan.shardHashes, undefined);
  assert.equal(plan.useMemoryShardStore, false);
});

test('resolveCommunalShardPlan: manifest-based fetch resolves layer fragments + hashes for the claimed range', async () => {
  const manifest = fakeManifest(28, 1_000_000); // 1MB/layer
  const { plan, manifestCache } = await resolveCommunalShardPlan(
    { layerStart: 2, layerEnd: 10, includeOutput: false },
    { manifestUrl: 'https://x/model-package.json', opfsQuotaBytes: OPFS_QUOTA_CEILING_BYTES, fetchImpl: fetchReturning(manifest) },
  );
  // metadata + 8 layers (no embeddings -- not isFirst; no output -- not isFinal)
  assert.equal(plan.shardUrls.length, 9);
  assert.equal(plan.shardHashes?.length, 9);
  assert.equal(plan.shardBytes?.length, 9);
  assert.equal(plan.useMemoryShardStore, false);
  assert.equal(manifestCache?.url, 'https://x/model-package.json');
});

test('resolveCommunalShardPlan: includeOutput=true pulls in the output artifact', async () => {
  const manifest = fakeManifest(28, 1_000_000);
  const { plan } = await resolveCommunalShardPlan(
    { layerStart: 20, layerEnd: 28, includeOutput: true },
    { manifestUrl: 'https://x/model-package.json', opfsQuotaBytes: OPFS_QUOTA_CEILING_BYTES, fetchImpl: fetchReturning(manifest) },
  );
  // metadata + 8 layers + output (embeddings NOT re-added since shared.output.tensor_count=2 -> untied)
  assert.equal(plan.shardUrls.length, 10);
});

test('resolveCommunalShardPlan: total fragment bytes exceeding the OPFS quota -> in-memory store', async () => {
  const manifest = fakeManifest(28, 500_000_000); // 500MB/layer -- deliberately huge
  const smallQuota = 1_000_000_000; // 1GB
  const { plan } = await resolveCommunalShardPlan(
    { layerStart: 2, layerEnd: 10, includeOutput: false }, // 8 layers * 500MB = 4GB > 1GB quota
    { manifestUrl: 'https://x/model-package.json', opfsQuotaBytes: smallQuota, fetchImpl: fetchReturning(manifest) },
  );
  assert.equal(plan.useMemoryShardStore, true);
});

test('resolveCommunalShardPlan: total fragment bytes under quota -> OPFS-cached (not memory)', async () => {
  const manifest = fakeManifest(28, 1_000_000); // 1MB/layer
  const { plan } = await resolveCommunalShardPlan(
    { layerStart: 2, layerEnd: 10, includeOutput: false }, // ~9MB total
    { manifestUrl: 'https://x/model-package.json', opfsQuotaBytes: OPFS_QUOTA_CEILING_BYTES, fetchImpl: fetchReturning(manifest) },
  );
  assert.equal(plan.useMemoryShardStore, false);
});

test('resolveCommunalShardPlan: reuses a cached manifest instead of re-fetching for the SAME url', async () => {
  const manifest = fakeManifest(28, 1_000_000);
  let fetchCalls = 0;
  const countingFetch: typeof fetch = (async () => {
    fetchCalls++;
    return { ok: true, status: 200, statusText: 'OK', json: async () => manifest } as unknown as Response;
  }) as unknown as typeof fetch;

  const first = await resolveCommunalShardPlan(
    { layerStart: 2, layerEnd: 10, includeOutput: false },
    { manifestUrl: 'https://x/model-package.json', opfsQuotaBytes: OPFS_QUOTA_CEILING_BYTES, fetchImpl: countingFetch },
  );
  const second = await resolveCommunalShardPlan(
    { layerStart: 10, layerEnd: 18, includeOutput: false },
    { manifestUrl: 'https://x/model-package.json', opfsQuotaBytes: OPFS_QUOTA_CEILING_BYTES, fetchImpl: countingFetch, manifestCache: first.manifestCache },
  );
  assert.equal(fetchCalls, 1);
  assert.equal(second.plan.shardUrls.length, 9); // metadata + 8 layers
});

test('resolveCommunalShardPlan: a DIFFERENT manifestUrl invalidates the cache and re-fetches', async () => {
  const manifest = fakeManifest(28, 1_000_000);
  let fetchCalls = 0;
  const countingFetch: typeof fetch = (async () => {
    fetchCalls++;
    return { ok: true, status: 200, statusText: 'OK', json: async () => manifest } as unknown as Response;
  }) as unknown as typeof fetch;

  const first = await resolveCommunalShardPlan(
    { layerStart: 2, layerEnd: 10, includeOutput: false },
    { manifestUrl: 'https://x/a.json', opfsQuotaBytes: OPFS_QUOTA_CEILING_BYTES, fetchImpl: countingFetch },
  );
  await resolveCommunalShardPlan(
    { layerStart: 2, layerEnd: 10, includeOutput: false },
    { manifestUrl: 'https://x/b.json', opfsQuotaBytes: OPFS_QUOTA_CEILING_BYTES, fetchImpl: countingFetch, manifestCache: first.manifestCache },
  );
  assert.equal(fetchCalls, 2);
});

test('resolveCommunalShardPlan: a failed manifest fetch throws with a descriptive message', async () => {
  const failingFetch: typeof fetch = (async () => ({ ok: false, status: 404, statusText: 'Not Found' }) as unknown as Response) as unknown as typeof fetch;
  await assert.rejects(
    () =>
      resolveCommunalShardPlan(
        { layerStart: 2, layerEnd: 10, includeOutput: false },
        { manifestUrl: 'https://x/missing.json', opfsQuotaBytes: OPFS_QUOTA_CEILING_BYTES, fetchImpl: failingFetch },
      ),
    /failed to fetch communal manifest/,
  );
});

// ── CDN-primary / origin-fallback manifest fetch ──────────────────────────

/** Fetch mock keyed by URL — throws/404s for any URL not listed, so a test
 * can assert exactly which URL(s) actually got hit. */
function fetchByUrlMap(behaviors: Record<string, 'throw' | '404' | unknown>): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    const behavior = behaviors[url];
    if (behavior === undefined) throw new Error(`unexpected fetch: ${url}`);
    if (behavior === 'throw') throw new Error(`network error fetching ${url}`);
    if (behavior === '404') return { ok: false, status: 404, statusText: 'Not Found' } as unknown as Response;
    return { ok: true, status: 200, statusText: 'OK', json: async () => behavior } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test('resolveCommunalShardPlan: CDN manifestUrl succeeds -> manifestFallbackUrl is never fetched', async () => {
  const manifest = fakeManifest(28, 1_000_000);
  const { fetchImpl, calls } = fetchByUrlMap({ 'https://cdn.test/model-package.json': manifest });

  const { plan, manifestCache } = await resolveCommunalShardPlan(
    { layerStart: 2, layerEnd: 10, includeOutput: false },
    {
      manifestUrl: 'https://cdn.test/model-package.json',
      manifestFallbackUrl: 'https://origin.test/webllm/stages/m/model-package.json',
      opfsQuotaBytes: OPFS_QUOTA_CEILING_BYTES,
      fetchImpl,
    },
  );

  assert.deepEqual(calls, ['https://cdn.test/model-package.json']);
  assert.equal(manifestCache?.url, 'https://cdn.test/model-package.json');
  assert.equal(plan.shardUrls.length, 9); // metadata + 8 layers
  // Fragment URLs resolve against the CDN base (the origin that served it).
  assert.ok(plan.shardUrls.every((u) => u.startsWith('https://cdn.test/')));
});

test('resolveCommunalShardPlan: CDN manifestUrl throws -> falls back to manifestFallbackUrl, and fragments resolve against the FALLBACK origin', async () => {
  const manifest = fakeManifest(28, 1_000_000);
  const { fetchImpl, calls } = fetchByUrlMap({
    'https://cdn.test/model-package.json': 'throw',
    'https://origin.test/webllm/stages/m/model-package.json': manifest,
  });

  const { plan, manifestCache } = await resolveCommunalShardPlan(
    { layerStart: 2, layerEnd: 10, includeOutput: false },
    {
      manifestUrl: 'https://cdn.test/model-package.json',
      manifestFallbackUrl: 'https://origin.test/webllm/stages/m/model-package.json',
      opfsQuotaBytes: OPFS_QUOTA_CEILING_BYTES,
      fetchImpl,
    },
  );

  assert.deepEqual(calls, ['https://cdn.test/model-package.json', 'https://origin.test/webllm/stages/m/model-package.json']);
  assert.equal(manifestCache?.url, 'https://origin.test/webllm/stages/m/model-package.json');
  assert.equal(plan.shardUrls.length, 9);
  // Fragments resolve against the ORIGIN that actually served the
  // manifest -- never unconditionally against the CDN primary.
  assert.ok(plan.shardUrls.every((u) => u.startsWith('https://origin.test/webllm/stages/m/')));
});

test('resolveCommunalShardPlan: CDN manifestUrl 404s (non-OK, not a throw) -> also falls back', async () => {
  const manifest = fakeManifest(28, 1_000_000);
  const { fetchImpl, calls } = fetchByUrlMap({
    'https://cdn.test/model-package.json': '404',
    'https://origin.test/webllm/stages/m/model-package.json': manifest,
  });

  const { manifestCache } = await resolveCommunalShardPlan(
    { layerStart: 2, layerEnd: 10, includeOutput: false },
    {
      manifestUrl: 'https://cdn.test/model-package.json',
      manifestFallbackUrl: 'https://origin.test/webllm/stages/m/model-package.json',
      opfsQuotaBytes: OPFS_QUOTA_CEILING_BYTES,
      fetchImpl,
    },
  );

  assert.deepEqual(calls, ['https://cdn.test/model-package.json', 'https://origin.test/webllm/stages/m/model-package.json']);
  assert.equal(manifestCache?.url, 'https://origin.test/webllm/stages/m/model-package.json');
});

test('resolveCommunalShardPlan: BOTH manifestUrl and manifestFallbackUrl fail -> throws (no silent hang)', async () => {
  const { fetchImpl } = fetchByUrlMap({
    'https://cdn.test/model-package.json': 'throw',
    'https://origin.test/webllm/stages/m/model-package.json': '404',
  });

  await assert.rejects(
    () =>
      resolveCommunalShardPlan(
        { layerStart: 2, layerEnd: 10, includeOutput: false },
        {
          manifestUrl: 'https://cdn.test/model-package.json',
          manifestFallbackUrl: 'https://origin.test/webllm/stages/m/model-package.json',
          opfsQuotaBytes: OPFS_QUOTA_CEILING_BYTES,
          fetchImpl,
        },
      ),
    /failed to fetch communal manifest/,
  );
});

test('resolveCommunalShardPlan: no manifestFallbackUrl configured -> a CDN failure propagates (no fallback to try)', async () => {
  const { fetchImpl } = fetchByUrlMap({ 'https://cdn.test/model-package.json': 'throw' });

  await assert.rejects(
    () =>
      resolveCommunalShardPlan(
        { layerStart: 2, layerEnd: 10, includeOutput: false },
        { manifestUrl: 'https://cdn.test/model-package.json', opfsQuotaBytes: OPFS_QUOTA_CEILING_BYTES, fetchImpl },
      ),
    /network error fetching/,
  );
});

test('resolveCommunalShardPlan: a manifest cached from the fallback origin is reused (not re-fetched) on a later call with the same options', async () => {
  const manifest = fakeManifest(28, 1_000_000);
  const { fetchImpl, calls } = fetchByUrlMap({
    'https://cdn.test/model-package.json': 'throw',
    'https://origin.test/webllm/stages/m/model-package.json': manifest,
  });

  const first = await resolveCommunalShardPlan(
    { layerStart: 2, layerEnd: 10, includeOutput: false },
    {
      manifestUrl: 'https://cdn.test/model-package.json',
      manifestFallbackUrl: 'https://origin.test/webllm/stages/m/model-package.json',
      opfsQuotaBytes: OPFS_QUOTA_CEILING_BYTES,
      fetchImpl,
    },
  );
  assert.equal(calls.length, 2); // CDN attempt + fallback

  const second = await resolveCommunalShardPlan(
    { layerStart: 10, layerEnd: 18, includeOutput: false },
    {
      manifestUrl: 'https://cdn.test/model-package.json',
      manifestFallbackUrl: 'https://origin.test/webllm/stages/m/model-package.json',
      opfsQuotaBytes: OPFS_QUOTA_CEILING_BYTES,
      fetchImpl,
      manifestCache: first.manifestCache,
    },
  );
  assert.equal(calls.length, 2, 'cached fallback manifest must not trigger another CDN-then-fallback round');
  assert.equal(second.plan.shardUrls.length, 9);
});

test('resolveCommunalShardPlan: a PAGE-RELATIVE fallback URL (chatModelSource.ts\'s real .198 shape, e.g. "/webllm/stages/m/model-package.json") resolves fragments correctly under a real `location` (regression: WHATWG URL rejects a relative base even for an already-absolute path)', async () => {
  const manifest = fakeManifest(28, 1_000_000);
  const relativeFallback = '/webllm/stages/m/model-package.json';
  const { fetchImpl, calls } = fetchByUrlMap({
    'https://cdn.test/model-package.json': 'throw',
    [relativeFallback]: manifest,
  });

  // Simulate a browser: `location` is what chatModelSource.ts/toAbsoluteManifestUrl
  // resolves a page-relative manifest path against. Restored in `finally` so
  // this doesn't leak into other tests in this file.
  const priorLocation = (globalThis as { location?: unknown }).location;
  (globalThis as { location?: unknown }).location = { origin: 'https://app.example.test' } as Location;
  try {
    const { plan, manifestCache } = await resolveCommunalShardPlan(
      { layerStart: 2, layerEnd: 10, includeOutput: false },
      {
        manifestUrl: 'https://cdn.test/model-package.json',
        manifestFallbackUrl: relativeFallback,
        opfsQuotaBytes: OPFS_QUOTA_CEILING_BYTES,
        fetchImpl,
      },
    );
    assert.deepEqual(calls, ['https://cdn.test/model-package.json', relativeFallback]);
    // Would previously throw "Invalid URL" inside fragmentsForRange/toFragment
    // before manifestBaseUrl was resolved to an absolute URL.
    assert.equal(manifestCache?.url, 'https://app.example.test/webllm/stages/m/model-package.json');
    assert.equal(plan.shardUrls.length, 9);
    assert.ok(plan.shardUrls.every((u) => u.startsWith('https://app.example.test/webllm/stages/m/')));
  } finally {
    (globalThis as { location?: unknown }).location = priorLocation;
  }
});

// ── CDN-chunked artifacts survive the ShardPlan flattening ────────────────

function fakeManifestWithChunkedLayer(layerCount: number, perLayerBytes: number) {
  const m = fakeManifest(layerCount, perLayerBytes) as any;
  m.layers[2] = {
    ...m.layers[2],
    chunks: [
      { path: 'layers/layer-00002.gguf.part0', sha256: 'd'.repeat(64), bytes: Math.floor(perLayerBytes / 2) },
      { path: 'layers/layer-00002.gguf.part1', sha256: 'e'.repeat(64), bytes: perLayerBytes - Math.floor(perLayerBytes / 2) },
    ],
  };
  return m;
}

test('resolveCommunalShardPlan: a chunked layer artifact carries shardChunks through the plan, aligned to shardUrls', async () => {
  const manifest = fakeManifestWithChunkedLayer(28, 1_000_000);
  const { plan } = await resolveCommunalShardPlan(
    { layerStart: 2, layerEnd: 4, includeOutput: false }, // layers 2,3 -- layer 2 is chunked
    { manifestUrl: 'https://cdn.test/model-package.json', opfsQuotaBytes: OPFS_QUOTA_CEILING_BYTES, fetchImpl: fetchByUrlMap({ 'https://cdn.test/model-package.json': manifest }).fetchImpl },
  );
  // metadata, layer-2 (chunked), layer-3 (not chunked)
  assert.equal(plan.shardUrls.length, 3);
  assert.equal(plan.shardChunks?.[0], undefined); // metadata: not chunked
  assert.equal(plan.shardChunks?.[1]?.length, 2); // layer-2: chunked
  assert.equal(plan.shardChunks?.[2], undefined); // layer-3: not chunked
  assert.equal(plan.shardChunks?.[1]?.[0]?.url, 'https://cdn.test/layers/layer-00002.gguf.part0');
});

test('resolveCommunalShardPlan: no artifact in range is chunked -> shardChunks is omitted entirely (byte-for-byte pre-chunking behavior)', async () => {
  const manifest = fakeManifest(28, 1_000_000); // no chunks anywhere
  const { plan } = await resolveCommunalShardPlan(
    { layerStart: 2, layerEnd: 10, includeOutput: false },
    { manifestUrl: 'https://cdn.test/model-package.json', opfsQuotaBytes: OPFS_QUOTA_CEILING_BYTES, fetchImpl: fetchByUrlMap({ 'https://cdn.test/model-package.json': manifest }).fetchImpl },
  );
  assert.equal(plan.shardChunks, undefined);
});
