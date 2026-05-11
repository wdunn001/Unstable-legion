/**
 * useMeshTools — wire a local `ToolRegistry` to the peer's `tc` action.
 *
 * The hook does three things:
 *   1. Subscribes `peer.onTool` and dispatches inbound `kind: "call"`
 *      frames through the registry, then ships the result back to the
 *      asker (or settles a local pending-tracker on `kind: "result"`).
 *   2. Exposes `callTool(peerId, name, args)` for the host UI — mints
 *      a `callId`, registers a tracker promise, sends the call.
 *   3. Surfaces the opted-in descriptor list (a slice of registry +
 *      `optedIn`) so the host can include it in the cap advertisement.
 *
 * The host owns the lifecycle of the `ToolRegistry` and the `optedIn`
 * list (typically persisted in localStorage per-persona). This hook
 * deliberately does NOT own that state — it's a connector.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  PendingToolCallTracker,
  newCallId,
  type MeshToolFrame,
  type MeshToolResult,
  type ToolRegistry,
} from '@unstable-legion/core';

import { useMeshContext } from './provider.js';

export interface UseMeshToolsOptions {
  /** The local tool registry. Stays the same across renders. */
  registry: ToolRegistry;
  /** Names this peer has opted in to advertise + dispatch. */
  optedIn: readonly string[];
  /** Default per-call timeout (ms). Default 30_000. */
  timeoutMs?: number;
}

export interface UseMeshToolsHandle {
  /**
   * Ask another peer to run a named tool. Resolves with the peer's
   * `MeshToolResult`; rejects on timeout or peer leaving.
   */
  callTool: (
    peerId: string,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ) => Promise<MeshToolResult>;
}

export function useMeshTools(opts: UseMeshToolsOptions): UseMeshToolsHandle {
  const { peer } = useMeshContext();
  const { registry, optedIn } = opts;
  const defaultTimeoutMs = opts.timeoutMs ?? 30_000;

  // Tracker is per-mount; cleared on unmount. We don't recreate it
  // across re-renders so pending calls survive an opt-in change.
  const trackerRef = useRef<PendingToolCallTracker | null>(null);
  if (trackerRef.current === null) {
    trackerRef.current = new PendingToolCallTracker();
  }

  // Mirror `optedIn` into a ref so the onTool handler always sees the
  // latest list without re-binding the subscription on each change.
  const optedInRef = useRef<readonly string[]>(optedIn);
  useEffect(() => {
    optedInRef.current = optedIn;
  }, [optedIn]);

  useEffect(() => {
    if (!peer) return;
    const tracker = trackerRef.current!;
    const unsub = peer.onTool(async (frame: MeshToolFrame, peerId: string) => {
      if (frame.kind === 'result') {
        tracker.settle(frame);
        return;
      }
      // call: dispatch + ship back
      const result = await registry.dispatch(frame, optedInRef.current);
      await peer.sendTool({ kind: 'result', ...result }, peerId);
    });
    return () => {
      unsub();
    };
  }, [peer, registry]);

  // Drain pending calls if the peer leaves (cleanup on unmount).
  useEffect(() => {
    return () => {
      trackerRef.current?.abortAll('mesh tools hook unmounted');
    };
  }, []);

  const callTool = useCallback<UseMeshToolsHandle['callTool']>(
    async (peerId, toolName, args, timeoutMs) => {
      if (!peer) throw new Error('mesh not connected');
      const tracker = trackerRef.current!;
      const callId = newCallId();
      const waiter = tracker.expect(callId, timeoutMs ?? defaultTimeoutMs);
      await peer.sendTool(
        {
          kind: 'call',
          v: 1 as const,
          ts: Date.now(),
          callId,
          toolName,
          args,
        },
        peerId,
      );
      return waiter;
    },
    [peer, defaultTimeoutMs],
  );

  return useMemo(() => ({ callTool }), [callTool]);
}
