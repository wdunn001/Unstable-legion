/**
 * telemetry — a small, pure wrapper around the fleet RUM beacon, the ONE
 * analytics stack this project uses (self-hosted; see docs/TELEMETRY.md).
 *
 * Events are POSTed to `/rum` on the app's own origin. nginx-proxy forwards
 * that path into VictoriaLogs, so there is no CORS preflight, no third-party
 * script, no npm SDK and no CDN. The whole module is a strict no-op unless a
 * real site id is configured, so the app can never break because analytics is
 * down, unconfigured or offline.
 *
 * This replaced OpenPanel's `window.op` command queue. The queue only existed
 * to buffer calls until a remote tracker script arrived; with a same-origin
 * beacon there is nothing to wait for, so the queue, the injected `<script>`
 * and the double-load hazard it carried all go away. That hazard was real: an
 * edge-injected copy plus the bundled copy ran `site.js` twice and threw on
 * the second bootstrap.
 *
 * Privacy is unchanged and is the reason `sanitizeProps` exists: only counts,
 * states and reasons are ever sent. Nested objects and arrays are dropped and
 * strings truncated, so message content and raw tokens cannot leak into an
 * event even by accident.
 *
 * The transport is injectable (`createTelemetry`'s second arg) so this module
 * is unit-testable with no DOM — see test/telemetry.test.ts.
 */
import type { MeshTelemetryEvent } from '@unstable-legion/react';

export interface TelemetryConfig {
  /** Site id, and the enable gate. Build-time env `VITE_RUM_SITE_ID`.
   * Absent/placeholder → telemetry is a hard no-op. */
  clientId?: string;
  /** Ingest path. Defaults to the same-origin `/rum` that nginx forwards into
   * VictoriaLogs. Same origin is what removes CORS from the picture. */
  apiUrl?: string;
  /** Automatic pageview tracking. Default true. */
  trackScreenViews?: boolean;
}

/** Same origin on purpose: no preflight, no certificate, no public log host. */
export const DEFAULT_API_URL = '/rum';

/** Values that are clearly not a real, operator-provided site id. */
const PLACEHOLDER_IDS = new Set(['', 'REPLACE_ME', 'YOUR_CLIENT_ID', 'CHANGEME', 'TODO', 'undefined', 'null']);

const MAX_STRING_LEN = 256;

/** Shared with the nginx-injected beacon so both halves of a visit join up. */
const SESSION_KEY = '_rv';

/** True iff `cfg` carries a real (non-placeholder) site id. */
export function isConfigured(cfg: TelemetryConfig): boolean {
  const id = (cfg.clientId ?? '').trim();
  return id.length > 0 && !PLACEHOLDER_IDS.has(id);
}

/**
 * Scalars only. Nested objects, arrays, functions and null are dropped rather
 * than serialised, and strings are truncated, so message content cannot ride
 * along inside an event.
 */
export function sanitizeProps(props?: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!props) return out;
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === 'string') out[k] = v.length > MAX_STRING_LEN ? v.slice(0, MAX_STRING_LEN) : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** One serialised event, exactly as it goes on the wire. */
export type RumPayload = Record<string, string | number | boolean>;

/** The transport. Tests pass a spy; the default posts to `/rum`. */
export type SendFn = (url: string, payload: RumPayload) => void;

export interface Telemetry {
  /** True when a real site id is configured and tracking is live. */
  readonly enabled: boolean;
  /** Fire a custom event (props sanitized). No-op when disabled. */
  track(name: string, props?: Record<string, unknown>): void;
  /** Fire a typed mesh telemetry event (from the hooks). No-op when disabled. */
  trackEvent(event: MeshTelemetryEvent): void;
}

export interface TelemetryDeps {
  /** The transport — defaults to a real `sendBeacon` POST. Tests pass a spy. */
  send?: SendFn;
}

const NOOP_TELEMETRY: Telemetry = {
  enabled: false,
  track() {},
  trackEvent() {},
};

/**
 * Read, or lazily create, the session id the nginx beacon also uses.
 *
 * sessionStorage dies with the tab, so this follows nobody between visits.
 * Sharing the key is what lets an event from this module land on the same
 * session as the page views the edge beacon recorded.
 */
function sessionId(): string {
  try {
    let v = sessionStorage.getItem(SESSION_KEY);
    if (!v) {
      v = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem(SESSION_KEY, v);
    }
    return v;
  } catch {
    return 'na';
  }
}

/** Fire and forget. Never blocks navigation, never throws into the app. */
function defaultSend(url: string, payload: RumPayload): void {
  try {
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/stream+json' });
    navigator.sendBeacon(url, blob);
  } catch {
    // analytics is best-effort — never surface a transport error to the app
  }
}

export function createTelemetry(cfg: TelemetryConfig, deps: TelemetryDeps = {}): Telemetry {
  if (!isConfigured(cfg)) return NOOP_TELEMETRY;

  const apiUrl = cfg.apiUrl ?? DEFAULT_API_URL;
  const hasWindow = typeof window !== 'undefined';
  const send = deps.send ?? (hasWindow ? defaultSend : undefined);

  if (!send) return NOOP_TELEMETRY; // no window and no injected sink → nothing to do

  const emit = (name: string, props: RumPayload): void => {
    try {
      // Caller props go FIRST so the envelope always wins. Spreading them last
      // would let an event prop named `site` or `event` overwrite the real one,
      // and those are the fields the log store indexes on. A caller cannot
      // rename its own events or file them against another site.
      send(apiUrl, {
        ...props,
        ts: new Date().toISOString(),
        site: cfg.clientId as string,
        event: name,
        path: hasWindow ? window.location.pathname : '',
        vid: hasWindow ? sessionId() : 'na',
      });
    } catch {
      // never surface a telemetry error to the app
    }
  };

  if (cfg.trackScreenViews ?? true) emit('pageview', {});

  return {
    enabled: true,
    track(name: string, props?: Record<string, unknown>): void {
      emit(name, sanitizeProps(props));
    },
    trackEvent(event: MeshTelemetryEvent): void {
      emit(event.name, sanitizeProps(event.props as Record<string, unknown>));
    },
  };
}

/** Read the build-time RUM config from Vite env. */
export function telemetryConfigFromEnv(env: ImportMetaEnv): TelemetryConfig {
  return {
    clientId: env.VITE_RUM_SITE_ID,
    apiUrl: env.VITE_RUM_API_URL || DEFAULT_API_URL,
    // Stated rather than left to createTelemetry's default, so changing that
    // default cannot silently turn pageviews off for the deployed app.
    trackScreenViews: true,
  };
}
