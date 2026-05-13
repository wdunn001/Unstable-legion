/**
 * MeshProvider — owns the Trystero peer + roster lifecycle for a subtree.
 *
 * Mounts a single `Peer` from `@unstable-legion/core`'s `joinMesh()` on
 * first render, tears it down on unmount. Children pull the peer handle
 * via `useMeshContext()`; hooks (`useMeshRoster`, `useMeshChat`)
 * subscribe to the underlying event sources.
 *
 * The host app picks the Trystero strategy by importing `joinRoom`
 * from `'trystero/torrent'` (or `/ipfs`, `/nostr`, `/mqtt`) and passing
 * it in. We don't bundle a strategy because the relay choice depends
 * on the deployment context.
 */
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  joinMesh,
  type JoinRoomFn,
  type MeshPeerCap,
  type Peer,
} from '@unstable-legion/core';
import { createWorkerMeshPeer } from './workerPeerProxy.js';
import type { WorkerInitConfig } from './workerMeshProtocol.js';

export interface MeshContextValue {
  /** Concrete peer handle; null until the room has joined. */
  peer: Peer | null;
}

const MeshContext = createContext<MeshContextValue>({ peer: null });

export interface MeshProviderProps {
  /**
   * Trystero strategy's `joinRoom` function — supplied by host app.
   * Required for main-thread mode; ignored when `worker` is set
   * (the worker imports its own Trystero strategy at build time).
   */
  joinRoom?: JoinRoomFn;
  /**
   * Trystero strategy's per-tab `selfId`. Required for main-thread
   * mode; ignored in worker mode (the worker's own selfId is reported
   * back via the `ready` event).
   */
  selfId?: string;
  /**
   * Trystero strategy config. At minimum `{ appId: string }`. Note that
   * for `@trystero-p2p/*` 0.24+ custom relays go under
   * `relayConfig: { urls: [...] }` — NOT `relayUrls` (a common typo).
   */
  trysteroConfig: Record<string, unknown>;
  /** Room id (per-room key passed to Trystero). */
  roomId: string;
  /** Initial cap. `ts` is auto-stamped if omitted. */
  cap: Omit<MeshPeerCap, 'ts'> & { ts?: number };
  /** Heartbeat interval for re-broadcasting cap. Default 30_000 ms. */
  heartbeatMs?: number;
  /**
   * Optional DedicatedWorker hosting the mesh peer + LLM engine. When
   * provided, the provider uses `createWorkerMeshPeer` to construct a
   * proxy that delegates every call into the worker; `joinRoom` and
   * `selfId` are not needed in that case (the worker imports its own
   * strategy and reports its selfId via the `ready` event). The
   * worker must speak the protocol defined in `workerMeshProtocol.ts`
   * — see `apps/demo/src/workers/meshWorker.ts` for the reference
   * implementation.
   */
  worker?: Worker;
  /**
   * Worker-mode-only extra config. Forwarded inside the `init`
   * message. Carries LLM config + the mcpProxyBaseUrl.
   */
  workerInitExtras?: Pick<WorkerInitConfig, 'llm' | 'mcpProxyBaseUrl'>;
  children?: ReactNode;
}

/**
 * Wrap the part of the tree that needs mesh access. One provider per
 * room — nesting providers gives each subtree its own mesh.
 */
export function MeshProvider(props: MeshProviderProps) {
  const {
    joinRoom,
    selfId,
    trysteroConfig,
    roomId,
    cap,
    heartbeatMs,
    worker,
    workerInitExtras,
    children,
  } = props;
  const [peer, setPeer] = useState<Peer | null>(null);
  const peerRef = useRef<Peer | null>(null);

  useEffect(() => {
    const initialCap: MeshPeerCap = { ...cap, ts: cap.ts ?? Date.now() };
    if (worker) {
      // Worker mode: hand off to the proxy. We can't synchronously
      // produce a Peer because createWorkerMeshPeer awaits the
      // worker's `ready` event.
      let disposed = false;
      let createdPeer: Peer | null = null;
      void createWorkerMeshPeer(worker, {
        roomId,
        trysteroConfig,
        cap: initialCap,
        heartbeatMs,
        ...(workerInitExtras ?? {}),
      }).then(({ peer: p }) => {
        if (disposed) {
          p.leave();
          return;
        }
        createdPeer = p;
        peerRef.current = p;
        setPeer(p);
      });
      return () => {
        disposed = true;
        if (createdPeer) {
          createdPeer.leave();
        }
        peerRef.current = null;
        setPeer(null);
      };
    }
    if (!joinRoom || !selfId) {
      throw new Error(
        'MeshProvider: either { worker } or { joinRoom, selfId } must be provided',
      );
    }
    const p = joinMesh({
      joinRoom,
      selfId,
      trysteroConfig,
      roomId,
      cap: initialCap,
      heartbeatMs,
    });
    peerRef.current = p;
    setPeer(p);
    return () => {
      p.leave();
      peerRef.current = null;
      setPeer(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    joinRoom,
    selfId,
    roomId,
    heartbeatMs,
    worker,
    JSON.stringify(trysteroConfig),
    JSON.stringify(workerInitExtras),
  ]);

  // Re-broadcast on cap change (without recreating the peer).
  const stableCapKey = JSON.stringify(cap);
  useEffect(() => {
    if (!peerRef.current) return;
    peerRef.current.setCap({ ...cap, ts: cap.ts ?? Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stableCapKey]);

  const value = useMemo<MeshContextValue>(() => ({ peer }), [peer]);
  return createElement(MeshContext.Provider, { value }, children);
}

/**
 * Pull the current mesh context. Returns `{ peer: null }` until the
 * Trystero room has connected; downstream hooks tolerate that null.
 */
export function useMeshContext(): MeshContextValue {
  return useContext(MeshContext);
}
