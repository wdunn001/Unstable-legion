/**
 * One-shot local WebGPU probe for the "Contribute more" panel — separate
 * from (and redundant with) `useCommunalHost`'s own internal probe by
 * design: this hook's result feeds UI display (detected GPU name, live
 * "what a budget affords you" math) and must be available even before
 * hosting is enabled/consented-to, which `useCommunalHost` deliberately
 * gates its own probing behind.
 */
import { useEffect, useState } from 'react';
import { detectWebGpuLimits, type StageHostLimits } from '@unstable-legion/react';

export interface UseGpuDetectionHandle {
  ok: boolean;
  reason?: string;
  limits?: StageHostLimits;
}

export function useGpuDetection(): UseGpuDetectionHandle {
  const [state, setState] = useState<UseGpuDetectionHandle>({ ok: false });
  useEffect(() => {
    let cancelled = false;
    void detectWebGpuLimits().then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}
