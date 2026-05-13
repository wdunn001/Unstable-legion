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

export interface MeshContextValue {
  /** Concrete peer handle; null until the room has joined. */
  peer: Peer | null;
}

const MeshContext = createContext<MeshContextValue>({ peer: null });

export interface MeshProviderProps {
  /** Trystero strategy's `joinRoom` function — supplied by host app. */
  joinRoom: JoinRoomFn;
  /**
   * Trystero strategy's per-tab `selfId` — in `@trystero-p2p/*` 0.24+
   * this is a module-level export, not a room property. Host imports
   * it from the same module as `joinRoom` and passes it through.
   *
   * Example: `import { joinRoom, selfId } from '@trystero-p2p/mqtt'`.
   */
  selfId: string;
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
    children,
  } = props;
  const [peer, setPeer] = useState<Peer | null>(null);
  const peerRef = useRef<Peer | null>(null);

  useEffect(() => {
    const initialCap: MeshPeerCap = { ...cap, ts: cap.ts ?? Date.now() };
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
  }, [joinRoom, selfId, roomId, heartbeatMs, JSON.stringify(trysteroConfig)]);

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
