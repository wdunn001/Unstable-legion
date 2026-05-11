/**
 * useMeshRoster — observable list of remote peers in the room.
 *
 * Backs onto `roster.subscribe()` via `useSyncExternalStore` so React
 * doesn't tear under concurrent renders. The returned array is the
 * same reference until a peer is added / removed / re-capped, so
 * memoized children don't re-render on each heartbeat.
 *
 * Empty array until the `MeshProvider` peer connects.
 */
import { useSyncExternalStore } from 'react';
import type { MeshRosterEntry } from '@unstable-legion/core';

import { useMeshContext } from './provider.js';

const EMPTY: readonly MeshRosterEntry[] = Object.freeze([]);

export function useMeshRoster(): readonly MeshRosterEntry[] {
  const { peer } = useMeshContext();

  return useSyncExternalStore(
    // subscribe
    (notify) => {
      if (!peer) return () => undefined;
      return peer.roster.subscribe(() => notify());
    },
    // getSnapshot
    () => (peer ? peer.roster.snapshot() : EMPTY),
    // getServerSnapshot — SSR path, always empty
    () => EMPTY,
  );
}
