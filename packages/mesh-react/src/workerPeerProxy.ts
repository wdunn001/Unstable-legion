/**
 * WorkerPeerProxy — main-thread façade that implements `@unstable-legion/core`'s
 * Peer interface by proxying every call through a DedicatedWorker.
 *
 * Why: the rest of the library (useMeshChat, useMeshRoster, useMeshTools,
 * the chat panel, the director loop) reads a `Peer` from MeshContext.
 * If the proxy satisfies that interface, none of those callers need
 * to know the actual Trystero peer lives in a worker.
 *
 * What this owns vs. delegates:
 * - Owns: a local Roster cache (kept in sync via `rosterUpdate`
 *   events), listener Sets for chat/frame/tool/envelope callbacks,
 *   request-id correlation for ack'd requests.
 * - Delegates everything else to the worker: cap broadcast,
 *   heartbeat, MQTT signaling, WebRTC data-channel wire-up, message
 *   guard checks, tool dispatch, MCP attachments.
 *
 * Construction: use `createWorkerMeshPeer(worker, initConfig)` which
 * awaits the worker's `ready` event and returns the proxy bound to
 * the worker's reported selfId.
 */
import {
  Roster,
  type CodecMsgpackFrame,
  type MeshChatMessage,
  type MeshPeerCap,
  type MeshRosterEntry,
  type MeshToolFrame,
  type Peer,
  type WebRtcEnvelope,
} from '@unstable-legion/core';

import {
  isWorkerEvent,
  type WorkerEvent,
  type WorkerInitConfig,
  type WorkerRequest,
} from './workerMeshProtocol.js';

/** Resolver pair for an in-flight requestId. */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

export interface CreateWorkerMeshPeerResult {
  peer: Peer;
  /**
   * Same worker passed in; returned for convenience so hosts can
   * forward it to `useLocalLlm({ worker })` etc.
   */
  worker: Worker;
}

export async function createWorkerMeshPeer(
  worker: Worker,
  config: WorkerInitConfig,
): Promise<CreateWorkerMeshPeerResult> {
  // ── State the proxy keeps locally ──────────────────────────────
  const roster = new Roster({
    isPaused: () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden',
  });
  const chatListeners = new Set<(msg: MeshChatMessage, peerId: string) => void>();
  const frameListeners = new Set<(frame: CodecMsgpackFrame, peerId: string) => void>();
  const toolListeners = new Set<(frame: MeshToolFrame, peerId: string) => void>();
  const envListeners = new Set<(env: WebRtcEnvelope, peerId: string) => void>();
  const pending = new Map<string, PendingRequest>();

  let selfId: string | null = null;

  const newRequestId = (): string =>
    `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  function send(req: WorkerRequest): void {
    worker.postMessage(req);
  }

  function request<T = unknown>(
    builder: (requestId: string) => WorkerRequest & { requestId: string },
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = newRequestId();
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      send(builder(id));
    });
  }

  // ── Inbound event dispatch ─────────────────────────────────────
  worker.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (!isWorkerEvent(event.data)) return;
    const evt = event.data as WorkerEvent;
    switch (evt.kind) {
      case 'response': {
        const p = pending.get(evt.requestId);
        if (!p) return;
        pending.delete(evt.requestId);
        if (evt.ok) p.resolve(evt.result);
        else p.reject(new Error(evt.error ?? 'request failed'));
        return;
      }
      case 'ready':
        selfId = evt.selfId;
        return;
      case 'rosterUpdate':
        // Replace the cached roster's contents with the worker's
        // authoritative snapshot. The Roster class doesn't expose a
        // bulk-replace, so we upsert each entry and remove peers no
        // longer present.
        applyRosterSnapshot(roster, evt.snapshot);
        return;
      case 'chatRecv':
        for (const cb of chatListeners) cb(evt.msg, evt.peerId);
        return;
      case 'frameRecv':
        for (const cb of frameListeners) cb(evt.frame, evt.peerId);
        return;
      case 'toolRecv':
        for (const cb of toolListeners) cb(evt.frame, evt.peerId);
        return;
      case 'envelopeRecv':
        for (const cb of envListeners) cb(evt.env, evt.peerId);
        return;
      default:
        // llmStatus / llmFrame / llmStreamDone / mcpStatus / toolCatalog /
        // error — these are consumed by sibling hooks (useLocalLlm,
        // useMcpAttachments, useMeshToolBus) that subscribe to the
        // same worker. The proxy doesn't have to do anything.
        return;
    }
  });

  // ── Boot ───────────────────────────────────────────────────────
  await request<void>((requestId) => ({ kind: 'init', requestId, config }));
  if (!selfId) {
    throw new Error('mesh worker did not report selfId on ready');
  }

  // ── Peer-shaped façade returned to the host ────────────────────
  const peer: Peer = {
    get selfId() {
      // selfId is set during init above; once it's set it never changes.
      return selfId!;
    },
    roster,
    setCap(cap) {
      send({ kind: 'setCap', cap });
    },
    async sendChat(msg, peers) {
      send({ kind: 'sendChat', msg, peers });
    },
    onChat(cb) {
      chatListeners.add(cb);
      return () => {
        chatListeners.delete(cb);
      };
    },
    async sendFrame(frame, peers) {
      send({ kind: 'sendFrame', frame, peers });
    },
    onFrame(cb) {
      frameListeners.add(cb);
      return () => {
        frameListeners.delete(cb);
      };
    },
    async sendEnvelope(env, peers) {
      send({ kind: 'sendEnvelope', env, peers });
    },
    onEnvelope(cb) {
      envListeners.add(cb);
      return () => {
        envListeners.delete(cb);
      };
    },
    async sendTool(frame, peers) {
      send({ kind: 'sendTool', frame, peers });
    },
    onTool(cb) {
      toolListeners.add(cb);
      return () => {
        toolListeners.delete(cb);
      };
    },
    leave() {
      send({ kind: 'leave' });
      // The pending requests are dead — reject anything still in flight.
      for (const [, p] of pending) p.reject(new Error('peer left'));
      pending.clear();
      roster.dispose();
    },
  };

  return { peer, worker };
}

function applyRosterSnapshot(
  roster: Roster,
  snapshot: readonly MeshRosterEntry[],
): void {
  const seen = new Set<string>();
  for (const entry of snapshot) {
    seen.add(entry.peerId);
    // Roster.upsert wants (peerId, cap); we have the full
    // MeshRosterEntry. Strip lastSeen + peerId for the cap.
    const { peerId, lastSeen: _lastSeen, ...cap } = entry;
    void _lastSeen;
    roster.upsert(peerId, cap as MeshPeerCap);
  }
  // Remove peers that no longer appear in the worker snapshot.
  for (const entry of roster.snapshot()) {
    if (!seen.has(entry.peerId)) {
      roster.remove(entry.peerId);
    }
  }
}
