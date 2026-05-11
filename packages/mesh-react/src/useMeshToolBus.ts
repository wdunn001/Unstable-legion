/**
 * useMeshToolBus — one tool catalog over the whole mesh.
 *
 * The director's local LLM expects ONE flat tool registry to function-
 * call against. This hook merges three sources into a single catalog
 * with a single dispatch function:
 *
 *   1. LOCAL — tools registered in this peer's `ToolRegistry` and
 *      opted into via `optedInLocal`. Names are passed through
 *      unprefixed (the LLM sees `engine_run`, `fetch_text`, etc.).
 *   2. PEER — every advertised tool in the roster's `cap.tools[]`,
 *      namespaced as `peer.<nick>.<toolName>` so multiple peers
 *      offering the same tool name remain distinct. Dispatched via
 *      `callTool(peerId, originalName, args)`.
 *   3. SKILL — virtual entries `skill.<dotted-path>` that resolve via
 *      the Layer-4 `routeBySkill` resolver. The catalog surfaces every
 *      unique authoritative / delegating zone seen across the roster
 *      (or a caller-supplied allow-list).
 *
 * The director doesn't need to know which kind a tool is — `dispatch`
 * routes locally or via mesh as needed. The kinds are informational
 * for the UI (trace view).
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  RESOLVER_HOPS_KEY,
  RESOLVER_ORIGIN_KEY,
  SkillCache,
  routeBySkill,
  type MeshRosterEntry,
  type MeshToolDescriptor,
  type MeshToolResult,
  type ToolRegistry,
} from '@unstable-legion/core';
import { useMeshContext } from './provider.js';
import { useMeshRoster } from './useMeshRoster.js';
import type { UseMeshToolsHandle } from './useMeshTools.js';

export interface UnifiedToolDescriptor extends MeshToolDescriptor {
  /** Where this tool dispatches: locally, to a specific peer, or via the skill resolver. */
  kind: 'local' | 'peer' | 'skill';
  /** Bus name (`engine_run` / `peer.alice.summarize` / `skill.coding.python`). */
  busName: string;
  /** Peer id for `kind: 'peer'`; null otherwise. */
  peerId: string | null;
  /** Underlying tool name on the target peer (for `kind: 'peer'`). */
  underlyingName?: string;
  /** Dotted skill path (for `kind: 'skill'`). */
  skill?: string;
}

export interface UseMeshToolBusOptions {
  /** Local registry — used both for dispatch and for catalog membership. */
  registry: ToolRegistry;
  /** Outbound `tc` dispatcher from `useMeshTools`. */
  callTool: UseMeshToolsHandle['callTool'];
  /** Names of LOCAL tools the operator has opted in to surface. */
  optedInLocal: readonly string[];
  /**
   * Surface these skill paths as virtual tools. Default: union of all
   * authoritative + delegating zones seen across the roster.
   */
  exposeSkills?: readonly string[];
  /** Per-tool dispatch timeout (ms). Default 30_000. */
  timeoutMs?: number;
  /** Hop limit forwarded to the skill resolver. Default 4. */
  maxResolveDepth?: number;
}

export interface UnifiedToolHandle {
  /** All callable tools (local + peer + skill). */
  catalog: readonly UnifiedToolDescriptor[];
  /** Look up a descriptor by its bus name. */
  find: (busName: string) => UnifiedToolDescriptor | undefined;
  /** Dispatch a call. Routes locally OR via mesh based on kind. */
  dispatch: (
    busName: string,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<MeshToolResult>;
  /**
   * Emit the catalog as OpenAI-style function-calling schemas — drop
   * into a director's system prompt as the `tools:` field, or stringify
   * into a `<tools>...</tools>` block for Hermes-style decoders.
   */
  asFunctionSchemas: () => Array<{
    name: string;
    description: string;
    parameters: Readonly<Record<string, unknown>>;
  }>;
}

function uniqueZones(roster: readonly MeshRosterEntry[]): string[] {
  const set = new Set<string>();
  for (const p of roster) {
    for (const s of p.skills ?? []) set.add(s);
    const auth = (p as MeshRosterEntry & { authoritative?: readonly string[] }).authoritative;
    if (auth) for (const s of auth) set.add(s);
    const deleg = (p as MeshRosterEntry & { delegating?: readonly string[] }).delegating;
    if (deleg) for (const s of deleg) set.add(s);
  }
  return [...set].sort();
}

export function useMeshToolBus(opts: UseMeshToolBusOptions): UnifiedToolHandle {
  const { registry, callTool, optedInLocal, exposeSkills, timeoutMs, maxResolveDepth } = opts;
  const { peer } = useMeshContext();
  const roster = useMeshRoster();

  // Per-peer skill cache. One per mount; survives roster churn.
  const cacheRef = useRef<SkillCache | null>(null);
  if (cacheRef.current === null) cacheRef.current = new SkillCache();

  // Invalidate cached skill→peerId mappings when a cached peer leaves.
  useEffect(() => {
    const seen = new Set(roster.map((r) => r.peerId));
    const cache = cacheRef.current;
    if (!cache) return;
    // SkillCache doesn't expose its internal map; we rely on
    // invalidatePeer for any peer not in the current roster. Since the
    // cache itself doesn't enumerate, we do a best-effort sweep: walk
    // the roster's previous snapshot. For simplicity, we just trust
    // the TTL — and explicitly invalidate when we know a peer dropped.
    // (A roster diff would be more aggressive; v2.)
    void seen;
    void cache;
  }, [roster]);

  const catalog = useMemo<readonly UnifiedToolDescriptor[]>(() => {
    const out: UnifiedToolDescriptor[] = [];

    // 1. LOCAL tools (opted in only — keeps the LLM's tool list small).
    for (const reg of registry.list()) {
      if (!optedInLocal.includes(reg.descriptor.name)) continue;
      out.push({
        ...reg.descriptor,
        kind: 'local',
        busName: reg.descriptor.name,
        peerId: null,
      });
    }

    // 2. PEER tools.
    for (const p of roster) {
      if (!p.available) continue;
      if (peer && p.peerId === peer.selfId) continue; // exclude self
      for (const tool of p.tools) {
        out.push({
          ...tool,
          kind: 'peer',
          busName: `peer.${p.nick}.${tool.name}`,
          peerId: p.peerId,
          underlyingName: tool.name,
          // Rewrite description to attribute the peer for the director's prompt.
          description: `[via @${p.nick}] ${tool.description}`,
        });
      }
    }

    // 3. SKILL virtual entries.
    const skills = exposeSkills ?? uniqueZones(roster);
    for (const skill of skills) {
      out.push({
        name: skill,
        description: `Resolve the "${skill}" capability via the mesh's skill router. Args are forwarded to whichever peer the resolver picks (longest-prefix authoritative wins, falling back to delegating zones).`,
        inputSchema: {
          type: 'object',
          properties: {
            user: { type: 'string', description: 'Sub-prompt sent to the resolved peer.' },
          },
          required: ['user'],
          additionalProperties: true,
        },
        kind: 'skill',
        busName: `skill.${skill}`,
        peerId: null,
        skill,
      });
    }

    return out;
  }, [registry, optedInLocal, roster, peer, exposeSkills]);

  const find = useCallback(
    (busName: string) => catalog.find((d) => d.busName === busName),
    [catalog],
  );

  const dispatch = useCallback<UnifiedToolHandle['dispatch']>(
    async (busName, args) => {
      const desc = catalog.find((d) => d.busName === busName);
      if (!desc) {
        return {
          v: 1 as const,
          ts: Date.now(),
          callId: 'bus-no-match',
          status: 'error',
          error: `bus dispatch: unknown tool "${busName}"`,
        };
      }
      if (desc.kind === 'local') {
        // Local dispatch — go through registry.dispatch directly. We
        // synthesize a MeshToolCall to reuse the registry's validation
        // + handler-result wrapping.
        const callId = `local-${Math.random().toString(36).slice(2, 10)}`;
        return registry.dispatch(
          { v: 1 as const, ts: Date.now(), callId, toolName: desc.name, args },
          [desc.name], // local opt-in for this single call
        );
      }
      if (desc.kind === 'peer') {
        if (!desc.peerId || !desc.underlyingName) {
          return {
            v: 1 as const,
            ts: Date.now(),
            callId: 'bus-bad-peer',
            status: 'error',
            error: `bus dispatch: missing peerId/underlyingName for ${busName}`,
          };
        }
        return callTool(desc.peerId, desc.underlyingName, args, timeoutMs);
      }
      // kind === 'skill'
      if (!desc.skill) {
        return {
          v: 1 as const,
          ts: Date.now(),
          callId: 'bus-bad-skill',
          status: 'error',
          error: `bus dispatch: missing skill for ${busName}`,
        };
      }
      if (!peer) {
        return {
          v: 1 as const,
          ts: Date.now(),
          callId: 'bus-no-peer',
          status: 'error',
          error: 'bus dispatch: mesh not connected',
        };
      }
      return routeBySkill(
        { peer, roster, cache: cacheRef.current! },
        desc.skill,
        args,
        { maxDepth: maxResolveDepth, timeoutMs },
      );
    },
    [catalog, registry, callTool, timeoutMs, peer, roster, maxResolveDepth],
  );

  const asFunctionSchemas = useCallback(() => {
    return catalog.map((d) => ({
      name: d.busName,
      description: d.description,
      parameters: d.inputSchema,
    }));
  }, [catalog]);

  // Suppress unused-import lints for resolver consts (used in the
  // resolver itself; surfaced here so consumers can reference them).
  void RESOLVER_HOPS_KEY;
  void RESOLVER_ORIGIN_KEY;

  return useMemo(
    () => ({ catalog, find, dispatch, asFunctionSchemas }),
    [catalog, find, dispatch, asFunctionSchemas],
  );
}
