/**
 * useDeviceCompat — React wrapper around `detectDeviceCompat`.
 *
 * Probes the GPU adapter on mount and returns the detected
 * compatibility tier. `null` while the probe is in flight (typically
 * one tick — `requestAdapter()` resolves quickly).
 */
import { useEffect, useState } from 'react';
import { detectDeviceCompat, type DeviceCompat } from '@unstable-legion/core';

export function useDeviceCompat(): DeviceCompat | null {
  const [compat, setCompat] = useState<DeviceCompat | null>(null);
  useEffect(() => {
    let cancelled = false;
    detectDeviceCompat().then((c) => {
      if (!cancelled) setCompat(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return compat;
}
