/**
 * signalingStatus — is this tab actually reachable for peer discovery?
 *
 * The mesh pill used to render only peer-derived numbers, which cannot
 * distinguish "connected and alone" from "signaling is down and nobody can
 * find me" (both read as zero peers). `@trystero-p2p/mqtt` exposes its live
 * relay sockets via `getRelaySockets()` (url → WebSocket, absent entries
 * filtered server-side in the relay manager), so the honest signal is right
 * there: an OPEN WebSocket to any MQTT relay means discovery works.
 *
 * Tri-state on purpose:
 *   'connected'  — at least one relay WebSocket is OPEN.
 *   'connecting' — none open yet, but a socket is mid-handshake, or no
 *                  socket has been registered at all (boot, or mqtt.js is
 *                  between reconnect attempts — it tears the old socket
 *                  down before the next dial, so an empty map while
 *                  retrying must not render as a hard "offline").
 *   'down'       — sockets exist and every one is CLOSING/CLOSED.
 *
 * Pure read, never throws — observability must not break the mesh (same
 * rule as mesh-core's iceDiagnostics).
 */
import { getRelaySockets } from '@trystero-p2p/mqtt';

export type SignalingStatus = 'connected' | 'connecting' | 'down';

/** WebSocket.readyState values, named locally so this module stays
 * importable in Node unit tests where the WebSocket global may not exist. */
const WS_CONNECTING = 0;
const WS_OPEN = 1;

export function readSignalingStatus(): SignalingStatus {
  try {
    const sockets = (getRelaySockets as () => Record<string, { readyState?: number } | undefined>)();
    const states = Object.values(sockets ?? {}).map((s) => s?.readyState);
    if (states.some((s) => s === WS_OPEN)) return 'connected';
    if (states.length === 0 || states.some((s) => s === WS_CONNECTING)) return 'connecting';
    return 'down';
  } catch {
    return 'connecting';
  }
}
