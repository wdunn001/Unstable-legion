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
