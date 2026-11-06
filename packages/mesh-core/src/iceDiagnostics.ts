/**
 * iceDiagnostics — observability for WebRTC connection attempts.
 *
 * WHY A GLOBAL CONSTRUCTOR WRAP: trystero owns its RTCPeerConnections
 * internally and constructs them from the GLOBAL constructor
 * (`new (rtcPolyfill ?? RTCPeerConnection)(…)`). Its `room.getPeers()`
 * only exposes peers that already CONNECTED — a peer stuck in ICE
 * `checking` (the exact signature of a broken TURN path: a cellular
 * phone that joins MQTT signaling but can never punch through) is
 * invisible to every public API. Subclassing the global before
 * `joinRoom` runs is the only way to observe those attempts.
 *
 * What it records per connection: iceConnectionState transition history,
 * `icecandidateerror` events (code/url/text — a 701 against the turn:
 * URL is the direct "TURN unreachable" signal), and on connected/failed
 * a getStats() snapshot of the nominated candidate pair (local/remote
 * candidateType — `relay` means the TURN path carried it).
 *
 * Surfaces:
 *   - console lines through the same `__legion_debug` gate peer.ts uses
 *     (default ON; `window.__legion_debug = false` silences).
 *   - `window.__legionIce.snapshot()` → { total, connecting, connected,
 *     failed, lastError } — the chat app's mesh pill reads this to show
 *     "connecting…" instead of a silent "0 remote".
 *
 * Installed by `joinMesh()` (idempotent, browser-only). Never throws —
 * diagnostics must not be able to break the mesh.
 */

export interface IceConnectionRecord {
  createdAt: number;
  /** Updated on every observed state change — the staleness clock for
   * `summarize`. A record whose last activity is far in the past and never
   * reached a terminal state is an abandoned attempt, not a live one. */
  lastActivityAt: number;
  states: { state: string; at: number }[];
  errors: { at: number; errorCode?: number; url?: string; errorText?: string }[];
  /** Set once on 'connected'/'failed' — nominated pair candidate types. */
  selectedPair?: { local?: string; remote?: string; localProtocol?: string; relayProtocol?: string };
  /** Weak handle to the live pc so `summarize` can read its CURRENT
   * `connectionState` — the only reliable close signal, because `pc.close()`
   * does NOT dispatch an `iceconnectionstatechange` event, so a closed
   * connection's ICE-state history freezes at `checking`/`new` and would
   * otherwise count as "connecting" forever (the accumulating-ghost bug).
   * A `deref()` of `undefined` (the pc was GC'd) likewise means "no longer
   * a live attempt." Shaped as a minimal interface so unit tests can inject
   * a fake without a real WeakRef/RTCPeerConnection. */
  pcRef?: { deref: () => { connectionState?: string } | undefined };
}

/** An in-flight attempt older than this with no terminal state is treated
 * as abandoned (counted as failed, not connecting). A real ICE handshake
 * completes in well under 10s; 30s is a generous ceiling. */
export const ICE_STALE_MS = 30_000;
/** Hard cap on retained connection records so a long, churny session can't
 * grow `connections` without bound. Oldest terminal records drop first. */
const MAX_ICE_RECORDS = 256;

export interface IceDiagSummary {
  total: number;
  /** new/checking — in-flight attempts (the "phone trying to reach us" state). */
  connecting: number;
  connected: number;
  failed: number;
  lastError?: string;
}

interface IceDiagGlobal {
  connections: IceConnectionRecord[];
  snapshot: () => IceDiagSummary;
}

function debugLog(...args: unknown[]): void {
  const flag = (globalThis as { __legion_debug?: unknown }).__legion_debug;
  if (flag === false) return;
  // eslint-disable-next-line no-console
  console.info('[legion-ice]', ...args);
}

function lastState(rec: IceConnectionRecord): string {
  return rec.states[rec.states.length - 1]?.state ?? 'new';
}

/** Bucket one record. `now` is injected so this stays deterministic for
 * tests. Precedence: the pc's LIVE `connectionState` wins (the only
 * reliable close/connect signal), then the ICE-state history, then a
 * staleness check that retires an attempt stuck non-terminal past
 * `ICE_STALE_MS`. */
export function classifyIceRecord(rec: IceConnectionRecord, now: number): 'connecting' | 'connected' | 'failed' {
  const live = rec.pcRef?.deref();
  if (rec.pcRef && !live) return 'failed'; // pc GC'd — not a live attempt
  const cs = live?.connectionState;
  if (cs === 'connected') return 'connected';
  if (cs === 'closed' || cs === 'failed') return 'failed';

  const state = lastState(rec);
  if (state === 'connected' || state === 'completed') return 'connected';
  if (state === 'failed' || state === 'closed' || state === 'disconnected') return 'failed';

  // Non-terminal (new/checking). Live only if it is still RECENT — an
  // attempt frozen here past the window was closed/abandoned without an
  // event (pc.close() dispatches none) and must not read as "joining".
  return now - rec.lastActivityAt > ICE_STALE_MS ? 'failed' : 'connecting';
}

export function summarizeIceConnections(connections: IceConnectionRecord[], now: number): IceDiagSummary {
  let connecting = 0;
  let connected = 0;
  let failed = 0;
  let lastError: string | undefined;
  for (const rec of connections) {
    const bucket = classifyIceRecord(rec, now);
    if (bucket === 'connected') connected += 1;
    else if (bucket === 'failed') failed += 1;
    else connecting += 1;
    const err = rec.errors[rec.errors.length - 1];
    if (err) lastError = `${err.errorCode ?? '?'} ${err.url ?? ''} ${err.errorText ?? ''}`.trim();
  }
  return { total: connections.length, connecting, connected, failed, ...(lastError ? { lastError } : {}) };
}

async function captureSelectedPair(pc: RTCPeerConnection, rec: IceConnectionRecord): Promise<void> {
  try {
    // RTCStatsReport IS a maplike at runtime, but older lib.dom typings
    // (the container's tsc) don't declare `.get` — go through a Map view.
    const stats = (await pc.getStats()) as unknown as Map<string, Record<string, unknown>>;
    stats.forEach((report) => {
      if (report.type === 'candidate-pair' && (report as { nominated?: boolean }).nominated) {
        const r = report as { localCandidateId?: string; remoteCandidateId?: string };
        const local = r.localCandidateId ? stats.get(r.localCandidateId) : undefined;
        const remote = r.remoteCandidateId ? stats.get(r.remoteCandidateId) : undefined;
        rec.selectedPair = {
          local: local?.candidateType as string | undefined,
          remote: remote?.candidateType as string | undefined,
          localProtocol: local?.protocol as string | undefined,
          relayProtocol: local?.relayProtocol as string | undefined,
        };
        debugLog(
          'selected pair:',
          rec.selectedPair.local,
          `(${rec.selectedPair.localProtocol ?? '?'}${rec.selectedPair.relayProtocol ? `/${rec.selectedPair.relayProtocol}` : ''})`,
          '->',
          rec.selectedPair.remote,
        );
      }
    });
  } catch {
    // stats are best-effort
  }
}

let installed = false;

/**
 * Wrap the global RTCPeerConnection so every trystero connection attempt
 * is observed. Idempotent; no-op outside a browser (Node bridge) or when
 * RTCPeerConnection is absent.
 */
export function installIceDiagnostics(): void {
  if (installed) return;
  const g = globalThis as {
    RTCPeerConnection?: typeof RTCPeerConnection;
    __legionIce?: IceDiagGlobal;
  };
  if (typeof g.RTCPeerConnection !== 'function') return;
  installed = true;

  const connections: IceConnectionRecord[] = [];
  g.__legionIce = { connections, snapshot: () => summarizeIceConnections(connections, Date.now()) };

  const Original = g.RTCPeerConnection;
  class InstrumentedRTCPeerConnection extends Original {
    constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
      super(...args);
      try {
        const now = Date.now();
        const rec: IceConnectionRecord = {
          createdAt: now,
          lastActivityAt: now,
          states: [],
          errors: [],
          pcRef: typeof WeakRef === 'function' ? new WeakRef(this) : undefined,
        };
        // Bound retained records. Drop the oldest ones that have reached a
        // terminal connectionState (closed/failed) first; never evict a
        // still-live attempt just because the session is long.
        if (connections.length >= MAX_ICE_RECORDS) {
          const dropAt = connections.findIndex((r) => {
            const s = r.pcRef?.deref()?.connectionState;
            return !r.pcRef || !r.pcRef.deref() || s === 'closed' || s === 'failed';
          });
          connections.splice(dropAt >= 0 ? dropAt : 0, 1);
        }
        connections.push(rec);
        this.addEventListener('iceconnectionstatechange', () => {
          const state = this.iceConnectionState;
          rec.states.push({ state, at: Date.now() });
          rec.lastActivityAt = Date.now();
          debugLog('state:', state);
          if (state === 'connected' || state === 'completed' || state === 'failed') {
            void captureSelectedPair(this, rec);
          }
        });
        // connectionState (the aggregate) is the signal iceConnectionState
        // misses — notably it goes 'closed' on pc.close(). Tracking it keeps
        // lastActivityAt fresh through a real negotiation and gives
        // `classifyIceRecord` a live close/connect read.
        this.addEventListener('connectionstatechange', () => {
          rec.lastActivityAt = Date.now();
          debugLog('connectionState:', this.connectionState);
        });
        this.addEventListener('icecandidateerror', (ev) => {
          const e = ev as unknown as { errorCode?: number; url?: string; errorText?: string };
          rec.errors.push({ at: Date.now(), errorCode: e.errorCode, url: e.url, errorText: e.errorText });
          debugLog('candidate error:', e.errorCode, e.url, e.errorText);
        });
      } catch {
        // observability must never break the connection itself
      }
    }
  }
  g.RTCPeerConnection = InstrumentedRTCPeerConnection as typeof RTCPeerConnection;
  debugLog('diagnostics installed');
}
