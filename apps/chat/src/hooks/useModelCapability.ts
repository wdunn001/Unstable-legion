/**
 * useModelCapability — OPTIONAL-STAGE0 Phase 2: fetches + parses the
 * CURRENT channel's manifest to derive the PER-MODEL floor
 * (`requiredStorageBufferBytesForManifest` — the shared embeddings tensor's
 * byte size) a device needs to host stage 0 for THIS model. Replaces the
 * flat 128MB `USABLE_STAGE_HOST_MIN_BYTES` floor (calibrated to the tiny
 * 0.6B test model) for the real capability decision: production Qwen3-8B
 * needs a ~350MB single storage-buffer allocation, well past a phone's
 * typical 128MB `maxStorageBufferBindingSize` — the flat floor let phones
 * clear the gate and then crash on the real allocation.
 *
 * Independent, best-effort probe — same "separate from useCommunalHost's
 * own internal manifest fetch" rationale as `useGpuDetection` (this one
 * needs to be available before hosting/chat even starts, to decide whether
 * THIS device routes capable or thin/text-relay).
 */
import { useEffect, useState } from 'react';
import { requiredStorageBufferBytesForManifest, USABLE_STAGE_HOST_MIN_BYTES } from '@unstable-legion/react';
import { parseLayerPackageManifest } from '@unstable-legion/stage-runtime';

export interface UseModelCapabilityHandle {
  /** The required single storage-buffer bytes to host stage 0 for the
   * CURRENT channel's model — feed this into `isThinDriverForModel`.
   * Undefined only while the very first resolution is in flight. */
  requiredStorageBufferBytes: number | undefined;
}

export function useModelCapability(manifestUrl: string | readonly string[] | undefined): UseModelCapabilityHandle {
  const [requiredStorageBufferBytes, setRequiredStorageBufferBytes] = useState<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const urls = typeof manifestUrl === 'string' ? [manifestUrl] : [...(manifestUrl ?? [])];
    if (urls.length === 0) {
      // No manifest configured at all (e.g. the `?testModel=1` swap) — the
      // flat demo/test-model floor IS the correct requirement for that model.
      setRequiredStorageBufferBytes(USABLE_STAGE_HOST_MIN_BYTES);
      return;
    }
    void (async () => {
      for (const url of urls) {
        try {
          const res = await fetch(url);
          if (!res.ok) continue;
          const manifest = parseLayerPackageManifest(await res.json());
          if (!cancelled) setRequiredStorageBufferBytes(requiredStorageBufferBytesForManifest(manifest));
          return;
        } catch {
          // try the next source in the failover list
        }
      }
      // Every source failed — fall back rather than block classification
      // forever; a real load failure later surfaces loudly through the
      // existing error-reporting path, this is only a capability GATE.
      if (!cancelled) setRequiredStorageBufferBytes(USABLE_STAGE_HOST_MIN_BYTES);
    })();
    return () => {
      cancelled = true;
    };
  }, [manifestUrl]);

  return { requiredStorageBufferBytes };
}
