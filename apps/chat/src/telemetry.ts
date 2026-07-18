/**
 * telemetry — a small, pure wrapper around OpenPanel's web tracker
 * (`op1.js`), the ONE analytics stack this project uses (self-hosted;
 * ingest + dashboard are both self-hosted (see docs/TELEMETRY.md)
 * behind Authentik). The tracker is loaded via OpenPanel's standard
 * `window.op` command-queue snippet — NO npm SDK dependency, NO CDN: the
 * script is self-served by our own instance, and the whole thing is a
 * strict no-op unless a real client id is configured, so the app can never
 * break because analytics is down / unconfigured / offline.
 *
 * Privacy: only counts / states / reasons are ever sent — `sanitizeProps`
 * drops any nested object/array and truncates strings, so message content
 * or raw tokens can't leak into an event even by accident. See the
 * `analytics-openpanel-flipt` memory + docs/TELEMETRY.md.
 *
 * The concrete tracker (`window.op`) and the script-injector are injectable
 * (`createTelemetry`'s second arg) so this module is unit-testable with no
 * DOM — see test/telemetry.test.ts.
 */
import type { MeshTelemetryEvent } from '@unstable-legion/react';

export interface TelemetryConfig {
  /** OpenPanel "Legion Chat" project client id (public). Build-time env
   * `VITE_OPENPANEL_CLIENT_ID`. Absent/placeholder → telemetry is a no-op. */
  clientId?: string;
  /** Ingest endpoint. Default the camouflaged tracker-list-resistant path
   * on the public edge (`/v1/*` → op-api `/api/*`), per the deployed
   * OpenPanel setup. */
  apiUrl?: string;
  /** URL of the self-served tracker script. Default the camouflaged
   * `/assets/site.js` (→ op1.js) on the same edge. */
  scriptUrl?: string;
  /** Automatic pageview/RUM tracking. Default true. */
  trackScreenViews?: boolean;
}

export const DEFAULT_API_URL = 'https://telemetry.quasarke.net/v1';
export const DEFAULT_SCRIPT_URL = 'https://telemetry.quasarke.net/assets/site.js';

/** Values that are clearly not a real, operator-provided client id. */
const PLACEHOLDER_IDS = new Set(['', 'REPLACE_ME', 'YOUR_CLIENT_ID', 'CHANGEME', 'TODO', 'undefined', 'null']);

const MAX_STRING_LEN = 256;

/** True iff `cfg` carries a real (non-placeholder) client id. */
export function isConfigured(cfg: TelemetryConfig): boolean {
  const id = (cfg.clientId ?? '').trim();
  return id.length > 0 && !PLACEHOLDER_IDS.has(id);
}

/**
 * Reduce arbitrary props to analytics-safe scalars: keep string / number /
 * boolean, DROP everything else (nested objects, arrays, functions,
 * null/undefined), and hard-truncate strings. This is the PII guard — even
 * if a caller mistakenly passes message text or a token array, it can't
 * reach the wire as-is.
 */
export function sanitizeProps(props?: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!props) return out;
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string') out[key] = value.length > MAX_STRING_LEN ? `${value.slice(0, MAX_STRING_LEN)}…` : value;
    // everything else (object/array/function/null/undefined) is intentionally dropped
  }
  return out;
}

/** The `window.op` command function OpenPanel's snippet installs. */
export type OpCommand = (...args: unknown[]) => void;

export interface Telemetry {
  /** True when a real client id is configured and tracking is live. */
  readonly enabled: boolean;
  /** Fire a custom event (props sanitized). No-op when disabled. */
  track(name: string, props?: Record<string, unknown>): void;
  /** Fire a typed mesh telemetry event (from the hooks). No-op when disabled. */
  trackEvent(event: MeshTelemetryEvent): void;
}

export interface TelemetryDeps {
  /** The command sink — defaults to the real `window.op` (installing the
   * proxy-queue snippet + injecting the script on first use). Tests pass a
   * spy. */
  op?: OpCommand;
  /** Injects the tracker `<script>` — defaults to a real DOM injection;
   * tests pass a no-op/spy. */
  loadScript?: (url: string) => void;
}

/**
 * Install OpenPanel's proxy command-queue (idempotent) and return the
 * `window.op` function. Mirrors the official snippet verbatim so a real
 * op1.js drains the queue once it loads. Browser-only — callers must guard.
 */
function ensureWindowOp(): OpCommand {
  const w = window as unknown as { op?: OpCommand & { q?: unknown[] } };
  if (!w.op) {
    const queue: unknown[][] = [];
    w.op = new Proxy(
      function (this: unknown, ...args: unknown[]) {
        if (args.length) queue.push(args);
      } as OpCommand,
      {
        get(target, prop) {
          if (prop === 'q') return queue;
          return (...args: unknown[]) => queue.push([prop as string, ...args]);
        },
        has(_target, prop) {
          return prop === 'q';
        },
      },
    ) as OpCommand;
  }
  return w.op;
}

/**
 * Install one-time global listeners that swallow uncaught errors originating
 * from the tracker, so a bug inside OpenPanel's script (e.g. its self-init
 * reading `document.currentScript`, null for a dynamically-inserted async
 * script — the observed `Cannot read properties of undefined (reading '1')`)
 * can never surface as an app-level "Uncaught" error or trip a framework error
 * overlay. Closes the one hole in "analytics can never break the app":
 * `safeCall` contains errors from OUR calls into `op`, but an error thrown
 * while the browser EVALUATES the async script runs off our stack.
 *
 * Matched by tracker ORIGIN, not the exact URL: the script we inject
 * (`.../site.js`) itself loads a SECOND file (`op1.js`) from the same host, and
 * the real throw comes from THAT filename — an exact-URL match misses it (the
 * bug this widening fixes). Origin scoping stays narrow: the telemetry host
 * serves only the tracker, so no unrelated app error is ever suppressed. Also
 * nets the same error arriving as an unhandled promise rejection. Idempotent.
 */
function installTrackerErrorGuard(url: string): void {
  const w = window as unknown as { __opTrackerGuardOrigins?: Set<string> };
  const matches = (s: string | undefined): boolean =>
    !!s && !!w.__opTrackerGuardOrigins && [...w.__opTrackerGuardOrigins].some((o) => s.startsWith(o) || s.includes(o));
  if (!w.__opTrackerGuardOrigins) {
    w.__opTrackerGuardOrigins = new Set<string>();
    window.addEventListener(
      'error',
      (event) => {
        // `filename` is the script URL the error was thrown from — suppress any
        // error whose source is on a registered tracker origin (site.js OR the
        // op1.js it loads).
        if (matches(event.filename)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason as { stack?: string } | undefined;
      if (matches(reason?.stack)) event.preventDefault();
    });
  }
  try {
    w.__opTrackerGuardOrigins.add(new URL(url, typeof location !== 'undefined' ? location.href : undefined).origin);
  } catch {
    // Non-absolute/opaque URL — fall back to guarding by the raw string.
    w.__opTrackerGuardOrigins.add(url);
  }
}

function defaultLoadScript(url: string): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector(`script[data-op-tracker="${url}"]`)) return;
  installTrackerErrorGuard(url);
  const el = document.createElement('script');
  el.src = url;
  el.async = true;
  el.defer = true;
  el.setAttribute('data-op-tracker', url);
  // A load/parse failure of best-effort analytics must also stay silent.
  el.onerror = () => undefined;
  document.head.appendChild(el);
}

const NOOP_TELEMETRY: Telemetry = {
  enabled: false,
  track: () => undefined,
  trackEvent: () => undefined,
};

/**
 * Build a telemetry handle. When `cfg` has no real client id (the common
 * case in dev / when the OpenPanel project hasn't been created yet) this
 * returns a hard no-op — the tracker script is never loaded, `track` does
 * nothing, and nothing ever throws.
 */
export function createTelemetry(cfg: TelemetryConfig, deps: TelemetryDeps = {}): Telemetry {
  if (!isConfigured(cfg)) return NOOP_TELEMETRY;

  const apiUrl = cfg.apiUrl ?? DEFAULT_API_URL;
  const scriptUrl = cfg.scriptUrl ?? DEFAULT_SCRIPT_URL;
  const hasWindow = typeof window !== 'undefined';
  const op = deps.op ?? (hasWindow ? ensureWindowOp() : undefined);
  const loadScript = deps.loadScript ?? defaultLoadScript;

  if (!op) return NOOP_TELEMETRY; // no window and no injected sink → nothing to do

  const safeCall = (...args: unknown[]): void => {
    try {
      op(...args);
    } catch {
      // analytics is best-effort — never surface a tracker error to the app
    }
  };

  safeCall('init', {
    clientId: cfg.clientId,
    apiUrl,
    trackScreenViews: cfg.trackScreenViews ?? true,
    trackOutgoingLinks: false,
    trackAttributes: false,
  });
  // Only inject the real script when we're driving the actual window.op
  // (in tests, `deps.op` is supplied and we skip the DOM entirely).
  if (!deps.op) loadScript(scriptUrl);

  return {
    enabled: true,
    track(name: string, props?: Record<string, unknown>): void {
      safeCall('track', name, sanitizeProps(props));
    },
    trackEvent(event: MeshTelemetryEvent): void {
      safeCall('track', event.name, sanitizeProps(event.props as Record<string, unknown>));
    },
  };
}

/** Read the build-time OpenPanel config from Vite env. */
export function telemetryConfigFromEnv(env: ImportMetaEnv): TelemetryConfig {
  return {
    clientId: env.VITE_OPENPANEL_CLIENT_ID,
    apiUrl: env.VITE_OPENPANEL_API_URL || DEFAULT_API_URL,
    scriptUrl: env.VITE_OPENPANEL_SCRIPT_URL || DEFAULT_SCRIPT_URL,
    trackScreenViews: true,
  };
}
