/**
 * useAggregatedTools — collapses the per-peer `cap.tools` arrays into a
 * single `[toolName, { description, peers: [...] }]` list across the
 * whole roster. Same shape leet's `LeetMeshAggregatedTool` carries so a
 * legion roster panel feels identical.
 *
 * Memoized on the roster snapshot — recomputes only when a cap changes,
 * not on every render.
 */
import { useMemo } from 'react';
import type { MeshToolDescriptor } from '@unstable-legion/core';
import { useMeshRoster } from './useMeshRoster.js';

export type AggregatedTool = readonly [
  string,
  { description: string; peers: string[] },
];

export function useAggregatedTools(): readonly AggregatedTool[] {
  const roster = useMeshRoster();
  return useMemo(() => {
    const map = new Map<string, { description: string; peers: Set<string> }>();
    for (const entry of roster) {
      for (const tool of entry.tools as readonly MeshToolDescriptor[]) {
        const existing = map.get(tool.name);
        if (existing) {
          existing.peers.add(entry.nick);
        } else {
          map.set(tool.name, {
            description: tool.description ?? '',
            peers: new Set([entry.nick]),
          });
        }
      }
    }
    const out: AggregatedTool[] = [];
    for (const [name, info] of map) {
      out.push([name, { description: info.description, peers: [...info.peers].sort() }]);
    }
    out.sort((a, b) => a[0].localeCompare(b[0]));
    return out;
  }, [roster]);
}
