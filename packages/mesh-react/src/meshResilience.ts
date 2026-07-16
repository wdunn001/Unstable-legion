/**
 * meshResilience — pure, framework-free helpers the communal hooks use to
 * (a) back off instead of hammering a failing host/preload/load in a tight
 * per-tick loop, (b) turn a raw failure into a human, model-named message
 * for the UI, and (c) emit vendor-neutral telemetry events at the same
 * failure/lifecycle points (the app maps these onto whatever analytics
 * stack it wants — OpenPanel today, see apps/chat/src/telemetry.ts).
 *
 * Everything here is intentionally DOM-free / React-free / mesh-free so it
 * can be unit-tested directly (test/meshResilience.test.ts) with a mock
 * clock + deterministic RNG — the same "keep the decision logic pure and
 * testable" discipline `resolveCommunalShardPlan` already follows.
 */

// ── Exponential backoff (with jitter) ───────────────────────────────────

export interface BackoffOptions {
  /** First retry delay (attempt 0). Default 2000ms. */
  baseMs?: number;
  /** Ceiling — never wait longer than this between attempts. Default 60000ms. */
  capMs?: number;
  /** Growth factor per attempt. Default 2 (2s → 4s → 8s → …). */
  factor?: number;
  /** ± fraction of jitter applied to each computed delay (0..1). Default
   * 0.25 — spreads retries so N peers that all failed the same fetch at
   * the same roster tick don't re-stampede it in lockstep. */
  jitter?: number;
}

const DEFAULT_BACKOFF: Required<BackoffOptions> = { baseMs: 2000, capMs: 60_000, factor: 2, jitter: 0.25 };

/**
 * Delay before retry `attempt` (0-based): `min(capMs, baseMs * factor^attempt)`
 * with `±jitter` applied. `rand` is injectable (defaults to `Math.random`)
 * so tests can pin it — `rand: () => 0.5` yields the exact un-jittered
 * schedule (2000, 4000, 8000, …, capped at capMs).
 */
export function computeBackoffMs(attempt: number, opts: BackoffOptions = {}, rand: () => number = Math.random): number {
  const { baseMs, capMs, factor, jitter } = { ...DEFAULT_BACKOFF, ...opts };
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const raw = Math.min(capMs, baseMs * Math.pow(factor, safeAttempt));
  const jittered = raw * (1 + (rand() * 2 - 1) * jitter);
  return Math.max(0, Math.round(Math.min(capMs, jittered)));
}

// ── Failure → human message ─────────────────────────────────────────────

/** Pull an HTTP status code (100–599) out of a raw error/reason string, if
 * one is present ("…failed to fetch shard …: 404", "server returned 404",
 * "… 503 Service Unavailable"). Undefined when the message carries no
 * recognizable status (a non-HTTP failure — worker crash, timeout, etc.). */
export function extractHttpStatus(message: string): number | undefined {
  // Only 4xx/5xx — the actual failure codes (404/403/500/503/…). A stray
  // 1xx/2xx/3xx in an error string (e.g. a model-shape number) is almost
  // never a real status and would just produce a misleading "server
  // returned 127"; better to fall back to the raw reason in that case.
  const match = message.match(/\b([45]\d{2})\b/);
  if (!match) return undefined;
  const n = Number(match[1]);
  return n >= 400 && n <= 599 ? n : undefined;
}

export interface HostErrorInput {
  reason: string;
  layerStart: number;
  layerEnd: number;
  httpStatus?: number;
  /** True while a bounded retry is scheduled (transient); false once we've
   * exhausted the transient window and are only retrying at the cap (the
   * "give up on a fast recovery, keep a slow heartbeat" state). */
  retrying: boolean;
  /** Whole seconds until the next scheduled attempt, when known. */
  nextAttemptInSec?: number;
}

/**
 * Human, model-named error copy for the host panel / capacity meter —
 * never a silent spinner. Examples:
 *   "Couldn't load model layers 2–13: server returned 404 — retrying in 8s"
 *   "Couldn't load model layers 2–13: worker crashed — retrying in 4s"
 *   "Hosting layers 2–13 keeps failing (server returned 404) — still retrying periodically"
 */
/** First line of a raw error, stripped of stack frames and capped — a
 * worker error often arrives as a multi-line string with an `Error: … at …`
 * stack, which must not be dumped verbatim into a UI card. */
export function cleanReason(reason: string, maxLen = 160): string {
  const firstLine = (reason.split('\n')[0] ?? '').trim();
  return firstLine.length > maxLen ? `${firstLine.slice(0, maxLen)}…` : firstLine;
}

export function describeHostError(input: HostErrorInput): string {
  const range = `${input.layerStart}–${input.layerEnd}`;
  const cause = input.httpStatus !== undefined ? `server returned ${input.httpStatus}` : cleanReason(input.reason) || 'unknown error';
  if (input.retrying) {
    const when = input.nextAttemptInSec !== undefined ? ` — retrying in ${Math.max(0, input.nextAttemptInSec)}s` : ' — retrying shortly';
    return `Couldn't load model layers ${range}: ${cause}${when}`;
  }
  return `Hosting layers ${range} keeps failing (${cause}) — still retrying periodically`;
}

/** Whole seconds until `nextAttemptAtMs`, clamped ≥ 0 — for a countdown. */
export function retryCountdownSec(nextAttemptAtMs: number | undefined, now: number): number | undefined {
  if (nextAttemptAtMs === undefined) return undefined;
  return Math.max(0, Math.ceil((nextAttemptAtMs - now) / 1000));
}

// ── Claim-decision dedup (kill the log storm) ───────────────────────────

export interface ClaimLike {
  layerStart: number;
  layerEnd: number;
  includeOutput?: boolean;
}

/** Stable string key for a claim range — used to detect whether the
 * assembly loop's DECISION actually changed between roster ticks (so it
 * only logs/acts on change, instead of re-logging an identical
 * "keeping as-is" decision dozens of times). */
export function claimKey(claim: ClaimLike | null | undefined): string {
  if (!claim) return 'none';
  return `${claim.layerStart}:${claim.layerEnd}:${claim.includeOutput ? 1 : 0}`;
}

export function claimsEqual(a: ClaimLike | null | undefined, b: ClaimLike | null | undefined): boolean {
  return claimKey(a) === claimKey(b);
}

// ── Vendor-neutral telemetry events ─────────────────────────────────────
//
// The hooks emit these at the SAME points they surface an error/lifecycle
// change; the app supplies a sink that forwards them to its analytics
// stack. Deliberately carries ONLY counts/states/reasons — no message
// content, no tokens, no PII (the app-side wrapper enforces this too).

export type MeshTelemetryEvent =
  | { name: 'host_load_failed'; props: { modelId: string; layerRange: string; reason: string; httpStatus?: number } }
  | { name: 'host_load_succeeded'; props: { modelId: string; layerRange: string } }
  | { name: 'communal_coverage'; props: { coveragePct: number; seats: number; hostCount: number } }
  | { name: 'chat_started'; props: { modelId: string } }
  | { name: 'chat_failed'; props: { reason: string } }
  | { name: 'chat_replan'; props: { restartCount: number } }
  | { name: 'stage_worker_crashed'; props: { where: string; reason: string } }
  // TOOL-NODES: one per tool round-trip the chat driver ran — status only
  // (`ok`/`error`/`timeout`/`no-provider`), never the args or result.
  | { name: 'tool_round_trip'; props: { tool: string; status: string; tried: number } };

export type MeshTelemetryEventName = MeshTelemetryEvent['name'];

/** A consumer of telemetry events. Supplied by the app (mapped onto
 * OpenPanel etc.); the hooks never see the analytics vendor. Always
 * called defensively — a throwing/absent sink must never break the mesh. */
export type MeshTelemetrySink = (event: MeshTelemetryEvent) => void;

/** Invoke a (possibly undefined, possibly throwing) sink without ever
 * letting an analytics failure propagate into mesh logic. */
export function emitTelemetry(sink: MeshTelemetrySink | undefined, event: MeshTelemetryEvent): void {
  if (!sink) return;
  try {
    sink(event);
  } catch {
    // analytics is best-effort — never break the app because a sink threw
  }
}

// ── Stage-host lifecycle events (host loop ↔ stage host) ────────────────
//
// `useStageHost` reports these UP to `useCommunalHost` (which owns the
// backoff state machine + the telemetry sink) instead of emitting
// telemetry itself — keeps `useStageHost` vendor-neutral and gives the
// host loop the exact signals it needs to drive backoff (preload-failed →
// schedule a retry; load-succeeded → reset).

export type StageHostLifecycleEvent =
  | { type: 'preload-failed'; modelId: string; layerStart: number; layerEnd: number; reason: string; httpStatus?: number }
  | { type: 'load-succeeded'; modelId: string; layerStart: number; layerEnd: number }
  | { type: 'worker-crashed'; reason: string };
