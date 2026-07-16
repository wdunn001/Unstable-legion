/**
 * Trystero peer wrapper — joins a Trystero room and exposes the four
 * mesh actions (cap, cm, cf, tc) as typed send/receive methods.
 *
 * Codec frame transport (`cf`) goes over a separate Trystero action
 * with binary payloads — bytes pass through the WebRTC data channel
 * as-is, no JSON wrapping, no base64. That's the bandwidth-critical
 * path for cross-peer LLM streaming.
 */
import { decodeFrameBytes, encodeFrameBytes, type CodecMsgpackFrame } from './wire.js';
import {
  decodeEnvelope,
  encodeEnvelope,
  type WebRtcEnvelope,
} from './webrtc-codec.js';
import {
  isMeshChatMessage,
  isMeshPeerCap,
  isMeshToolFrame,
} from './guards.js';
import { Roster } from './roster.js';
import { installIceDiagnostics } from './iceDiagnostics.js';
import {
  type MeshChatMessage,
  type MeshPeerCap,
  type MeshToolFrame,
  type MeshRosterEntry,
} from './types.js';

// ── Trystero shape (kept as a structural type so we don't bind to a
//    specific Trystero strategy at build time — joinRoom comes from
//    '@trystero-p2p/mqtt', '@trystero-p2p/nostr', '@trystero-p2p/ipfs',
//    or upstream `trystero/torrent` etc. The consumer picks). ─────────

export interface TrysteroRoom {
  makeAction<T = unknown>(
    name: string,
  ): [
    (payload: T, peers?: string | string[]) => Promise<unknown>,
    (cb: (payload: T, peerId: string) => void) => void,
    (cb: (progress: number, peerId: string) => void) => void,
  ];
  onPeerJoin(cb: (peerId: string) => void): void;
  onPeerLeave(cb: (peerId: string) => void): void;
  leave(): void;
}

export type JoinRoomFn = (
  config: Record<string, unknown>,
  roomId: string,
  callbacks?: {
    onJoinError?: (data: { error: string; appId: string; roomId: string }) => void;
  },
) => TrysteroRoom;

// ── Peer options ──────────────────────────────────────────────────────────

export interface PeerOptions {
  /** Trystero `joinRoom` function — caller imports from their chosen strategy. */
  joinRoom: JoinRoomFn;
  /**
   * The Trystero `selfId` for this tab. In `@trystero-p2p/*` 0.24+ this
   * is a module-level export (e.g. `import { selfId } from
   * '@trystero-p2p/mqtt'`), NOT a property of the room. Consumers pass
   * it through so mesh-core can attribute outbound messages without
   * binding to any specific strategy at build time.
   */
  selfId: string;
  /**
   * Trystero strategy config object (appId, optional relayConfig.urls,
   * password, etc.). Shape is per-strategy.
   */
  trysteroConfig: Record<string, unknown>;
  /** Room id (per-room key passed to Trystero). */
  roomId: string;
  /** Initial capability advertisement. */
  cap: MeshPeerCap;
  /** Heartbeat interval (ms) for re-announcing the cap. Default 30_000. */
  heartbeatMs?: number;
}

// ── Peer handle ───────────────────────────────────────────────────────────

export interface Peer {
  selfId: string;
  roster: Roster;
  /** Update local cap and immediately re-broadcast. */
  setCap(cap: MeshPeerCap): void;
  /** Send a chat message; empty `to` = broadcast. */
  sendChat(msg: Omit<MeshChatMessage, 'v' | 'ts' | 'from'>, peers?: string | string[]): Promise<void>;
  /** Subscribe to inbound chat. Unsub fn returned. */
  onChat(cb: (msg: MeshChatMessage, peerId: string) => void): () => void;
  /** Send a Codec frame (binary) to one or more peers. */
  sendFrame(frame: CodecMsgpackFrame, peers?: string | string[]): Promise<void>;
  /** Subscribe to inbound Codec frames. */
  onFrame(cb: (frame: CodecMsgpackFrame, peerId: string) => void): () => void;
  /** Send a raw Codec-over-WebRTC envelope (HELLO / READY / DATA / END). */
  sendEnvelope(env: WebRtcEnvelope, peers?: string | string[]): Promise<void>;
  /** Subscribe to inbound envelopes — wraps the same `cf` action. */
  onEnvelope(cb: (env: WebRtcEnvelope, peerId: string) => void): () => void;
  /** Send a tool-call or tool-result. */
  sendTool(frame: MeshToolFrame, peers?: string | string[]): Promise<void>;
  /** Subscribe to inbound tool frames. */
  onTool(cb: (frame: MeshToolFrame, peerId: string) => void): () => void;
  /**
   * Send a pipeline-split stage-activation frame (Phase C). Bytes are
   * opaque here — the wire format is `@unstable-legion/stage-runtime`'s
   * activation-wire encoding (see `stageOrchestrator.ts` /
   * `createActivationWireEncoder`), a header once per stream then one
   * frame per prefill chunk / decode token. Unlike `cf`, there's no
   * envelope/backward-compat fallback to try — `sf` is a Phase C-only
   * action, so a v1 peer without stage support simply never registers a
   * handler for it (Trystero actions are per-name; unknown actions on
   * the sender side are a no-op for receivers that never called
   * `makeAction('sf')`).
   */
  sendStageFrame(bytes: Uint8Array, peers?: string | string[]): Promise<void>;
  /** Subscribe to inbound stage-activation frames. */
  onStageFrame(cb: (bytes: Uint8Array, peerId: string) => void): () => void;
  /** Leave the room and stop the heartbeat. */
  leave(): void;
}

// ── Self-addressed sends: loopback instead of Trystero ──────────────────
//
// Trystero has no data channel to ourselves — `room.makeAction(...)[0]`
// (the sender) only knows about REMOTE peer connections, so naming our
// own `selfId` as a `sendTool`/`sendStageFrame` target throws ("no peer
// with id <selfId> found") instead of silently no-op'ing. This used to be
// purely theoretical (nothing ever addressed itself) until M3's communal
// pipeline made it real: `planCommunalRoute` can legitimately pick THIS
// peer as a segment's host — e.g. the only candidate when solo, or a
// mixed mesh where this peer covers one hop and a remote peer covers
// another — because a driver's own `useCommunalHost` contribution is a
// perfectly valid host, advertised on the very same roster remote hosts
// are. `stageOrchestrator.ts`'s `runCommunalDriverSession` has no
// special-cased "is this peerId mine" branch (by design — see that
// module's SCOPE NOTE), so it happily emits a `stage.session.open`/`sf`
// call straight at `selfId` for a self-hosted hop. The fix belongs HERE,
// not in the orchestrator: `useStageHost`'s "answer" effect already
// listens on `peer.onTool`/`peer.onStageFrame` and runs the exact
// session-open/prefill/decode machinery a self-hosted hop needs — it
// just never gets invoked because the call never arrives locally. Routing
// a self-addressed `sendTool`/`sendStageFrame` to the LOCAL listener
// registry instead of Trystero makes that existing host-answer loop
// transparently serve the driver's own communal claim, with zero
// duplicated attach/session logic and zero orchestrator changes — and it
// generalizes for free to a mixed route (self covers one segment, a real
// remote peer covers another): only the genuinely-remote portion of a
// `peers` target ever reaches Trystero.
export interface SplitPeerTarget {
  /** True when `selfId` was one of the addressed targets — the caller
   * must deliver the frame to its own local listeners. */
  loopback: boolean;
  /** What's left to actually hand to Trystero's sender. `undefined` means
   * "broadcast to every connected peer" (Trystero's own `peers` contract —
   * preserved as-is, no loopback inferred, since nothing named `selfId`
   * explicitly). An empty array means "nothing left to send over the
   * wire" — callers MUST skip the underlying Trystero send in that case;
   * an empty-array target isn't guaranteed to be a harmless no-op across
   * every Trystero strategy, and it's also just wasted work. */
  remote: string | string[] | undefined;
}

export function splitPeerTarget(peers: string | string[] | undefined, selfId: string): SplitPeerTarget {
  if (peers === undefined) return { loopback: false, remote: undefined };
  if (typeof peers === 'string') {
    return peers === selfId ? { loopback: true, remote: [] } : { loopback: false, remote: peers };
  }
  return { loopback: peers.includes(selfId), remote: peers.filter((p) => p !== selfId) };
}

// ── joinMesh ──────────────────────────────────────────────────────────────

/**
 * Connect to a Trystero room with the five mesh actions wired up.
 * Returns the `Peer` handle the consumer interacts with.
 *
 * Action mapping:
 *
 *   cap  →  MeshPeerCap (JSON, small; broadcast on join + heartbeat)
 *   cm   →  MeshChatMessage (JSON; small chat metadata + body)
 *   cf   →  Uint8Array — either a raw Codec msgpack frame OR a full
 *           WebRtcEnvelope-encoded message. Receivers try
 *           `decodeEnvelope` first; on miss, fall back to
 *           `decodeFrameBytes` for backward-compat with pre-envelope
 *           peers. New peers should always emit envelopes.
 *   tc   →  MeshToolFrame ({kind: 'call' | 'result'}) — also carries
 *           Phase C stage-control messages (stage.load/ready/stop/
 *           ping/pong/progress/token), see `stageControl.ts`.
 *   sf   →  Uint8Array — Phase C pipeline-split activation-wire frame
 *           (see `stageOrchestrator.ts`). Bytes only, no fallback
 *           decode — a v1-only peer never calls `onStageFrame` and
 *           Trystero simply has no receiver-side listener for it.
 */
export function joinMesh(opts: PeerOptions): Peer {
  const { joinRoom, selfId, trysteroConfig, roomId, cap: initialCap } = opts;
  const heartbeatMs = opts.heartbeatMs ?? 30_000;

  // Observe every WebRTC connection attempt (incl. ones that never
  // complete — invisible to trystero's own API); see iceDiagnostics.ts.
  // Must run BEFORE joinRoom constructs any RTCPeerConnection.
  installIceDiagnostics();

  const room = joinRoom(trysteroConfig, roomId, {
    onJoinError: (d) => {
      // eslint-disable-next-line no-console
      console.error('[legion-mesh] joinRoom error:', d);
    },
  });
  // Skip prune while the tab is hidden — Chrome throttles setInterval
  // to ~1/min on backgrounded tabs, heartbeats miss the prune window,
  // and you come back to an empty roster. Detect via document.visibilityState
  // when the API is available (browser), else always run (Node bridge).
  const isHidden = (): boolean =>
    typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const roster = new Roster({ isPaused: isHidden });
  let currentCap: MeshPeerCap = initialCap;

  // ── Actions ──────────────────────────────────────────────────────────
  const [sendCap, onCap] = room.makeAction<MeshPeerCap>('cap');
  const [sendChat, onChat] = room.makeAction<MeshChatMessage>('cm');
  const [sendFrameBytes, onFrameBytes] = room.makeAction<Uint8Array>('cf');
  const [sendTool, onTool] = room.makeAction<MeshToolFrame>('tc');
  const [sendStageFrameBytes, onStageFrameBytes] = room.makeAction<Uint8Array>('sf');

  // ── Local listener registries ────────────────────────────────────────
  const chatListeners = new Set<(msg: MeshChatMessage, peerId: string) => void>();
  const frameListeners = new Set<(frame: CodecMsgpackFrame, peerId: string) => void>();
  const envelopeListeners = new Set<(env: WebRtcEnvelope, peerId: string) => void>();
  const toolListeners = new Set<(frame: MeshToolFrame, peerId: string) => void>();
  const stageFrameListeners = new Set<(bytes: Uint8Array, peerId: string) => void>();

  // ── Debug logging — ON by default while we diagnose roster /
  //    chat-doesn't-work reports. To silence:
  //      window.__legion_debug = false
  //    To re-enable mid-session:
  //      window.__legion_debug = true
  //    (Default true; explicit false silences. We'll flip the default
  //    once mesh is stable.)
  const debug = (...args: unknown[]): void => {
    try {
      const flag = (globalThis as { __legion_debug?: unknown }).__legion_debug;
      if (flag === false) return;
      // eslint-disable-next-line no-console
      console.info('[legion-mesh]', ...args);
    } catch {
      /* ignore */
    }
  };

  // ── Inbound wiring ───────────────────────────────────────────────────
  onCap((raw, peerId) => {
    if (!isMeshPeerCap(raw)) {
      debug('cap REJECTED from', peerId, '— guard failed; raw:', raw);
      return;
    }
    debug('cap RECEIVED from', peerId, '· nick=', raw.nick, '· tools=', raw.tools.length);
    roster.upsert(peerId, raw);
  });

  onChat((raw, peerId) => {
    debug('chat RECEIVED from', peerId, '· text=', (raw as { text?: string })?.text);
    if (!isMeshChatMessage(raw)) {
      debug('chat REJECTED — guard failed; raw:', raw);
      return;
    }
    for (const cb of chatListeners) cb(raw, peerId);
  });

  onFrameBytes((raw, peerId) => {
    // Try envelope decode first (new format), fall back to bare-frame decode.
    const env = decodeEnvelope(raw);
    if (env) {
      for (const cb of envelopeListeners) cb(env, peerId);
      // If the envelope carries a DATA payload that's also a raw frame,
      // also surface it on the frame listener for backward-compat
      // consumers.
      if (env.k === 2 && env.b instanceof Uint8Array) {
        const frame = decodeFrameBytes(env.b);
        if (frame) {
          for (const cb of frameListeners) cb(frame, peerId);
        }
      }
      return;
    }
    // Pre-envelope peer: bare msgpack frame.
    const frame = decodeFrameBytes(raw);
    if (!frame) return;
    for (const cb of frameListeners) cb(frame, peerId);
  });

  onTool((raw, peerId) => {
    if (!isMeshToolFrame(raw)) return;
    for (const cb of toolListeners) cb(raw, peerId);
  });

  onStageFrameBytes((raw, peerId) => {
    if (!(raw instanceof Uint8Array)) return;
    for (const cb of stageFrameListeners) cb(raw, peerId);
  });

  // ── Peer join/leave: cap broadcast + roster prune ────────────────────
  room.onPeerJoin((peerId) => {
    debug('peer JOINED', peerId, '— sending our cap');
    void sendCap(currentCap, peerId);
  });
  room.onPeerLeave((peerId) => {
    debug('peer LEFT', peerId);
    roster.remove(peerId);
  });

  // ── Self in roster ───────────────────────────────────────────────────
  // Trystero's makeAction sender doesn't echo back to the local
  // receiver — sending our cap only reaches REMOTE peers. So we'd
  // never see ourselves in our own roster, which means our own tools
  // never show up in the aggregated public-tools list either. Mirror
  // leet's pattern: upsert self locally whenever we broadcast our cap.
  const upsertSelf = (): void => {
    roster.upsert(selfId, currentCap);
  };
  upsertSelf();

  // ── Initial + heartbeat cap broadcast ────────────────────────────────
  debug('joined room', roomId, '· selfId=', selfId, '· nick=', currentCap.nick);
  void sendCap(currentCap);
  const heartbeat: ReturnType<typeof setInterval> | null =
    typeof setInterval !== 'undefined'
      ? setInterval(() => {
          currentCap = { ...currentCap, ts: Date.now() };
          debug('heartbeat cap broadcast');
          void sendCap(currentCap);
          upsertSelf();
        }, heartbeatMs)
      : null;

  // On tab return-to-foreground, immediately re-broadcast our cap so
  // other peers don't prune us, and bump every roster entry's
  // `lastSeen` so we don't prune them either while waiting on their
  // next heartbeat. Browser-only; Node bridge has no document.
  let visibilityHandler: (() => void) | null = null;
  if (typeof document !== 'undefined') {
    visibilityHandler = () => {
      if (document.visibilityState !== 'visible') return;
      debug('tab visible — re-broadcasting cap');
      currentCap = { ...currentCap, ts: Date.now() };
      void sendCap(currentCap);
      upsertSelf();
      // Give peers a grace window — bump their lastSeen so the next
      // prune doesn't fire on heartbeats missed during throttling.
      const now = Date.now();
      for (const entry of roster.snapshot()) {
        roster.upsert(entry.peerId, { ...entry, ts: now } as MeshPeerCap);
      }
    };
    document.addEventListener('visibilitychange', visibilityHandler);
  }

  // ── Public API ───────────────────────────────────────────────────────
  return {
    selfId,
    roster,
    setCap(next) {
      currentCap = { ...next, ts: Date.now() };
      void sendCap(currentCap);
      upsertSelf();
    },
    async sendChat(partial, peers) {
      const msg: MeshChatMessage = {
        v: 1 as const,
        ts: Date.now(),
        from: selfId,
        ...partial,
      };
      await sendChat(msg, peers);
    },
    onChat(cb) {
      chatListeners.add(cb);
      return () => chatListeners.delete(cb);
    },
    async sendFrame(frame, peers) {
      const bytes = encodeFrameBytes(frame);
      await sendFrameBytes(bytes, peers);
    },
    onFrame(cb) {
      frameListeners.add(cb);
      return () => frameListeners.delete(cb);
    },
    async sendEnvelope(env, peers) {
      const bytes = encodeEnvelope(env);
      await sendFrameBytes(bytes, peers);
    },
    onEnvelope(cb) {
      envelopeListeners.add(cb);
      return () => envelopeListeners.delete(cb);
    },
    async sendTool(frame, peers) {
      const { loopback, remote } = splitPeerTarget(peers, selfId);
      if (loopback) {
        for (const cb of toolListeners) cb(frame, selfId);
      }
      if (remote === undefined || remote.length > 0) {
        await sendTool(frame, remote);
      }
    },
    onTool(cb) {
      toolListeners.add(cb);
      return () => toolListeners.delete(cb);
    },
    async sendStageFrame(bytes, peers) {
      const { loopback, remote } = splitPeerTarget(peers, selfId);
      if (loopback) {
        for (const cb of stageFrameListeners) cb(bytes, selfId);
      }
      if (remote === undefined || remote.length > 0) {
        await sendStageFrameBytes(bytes, remote);
      }
    },
    onStageFrame(cb) {
      stageFrameListeners.add(cb);
      return () => stageFrameListeners.delete(cb);
    },
    leave() {
      if (heartbeat) clearInterval(heartbeat);
      if (visibilityHandler && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', visibilityHandler);
      }
      roster.dispose();
      room.leave();
    },
  };
}

export type { MeshChatMessage, MeshPeerCap, MeshRosterEntry, MeshToolFrame };
