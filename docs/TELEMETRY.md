# Telemetry (OpenPanel) — apps/chat

`apps/chat` (the flagship product at `legion.codecai.net`) reports
pageview/RUM plus a small set of custom **failure/lifecycle** events to
**OpenPanel**, which is the project's ONLY analytics stack. This exists so
the live app is *observable* — when a user's hosting or chat fails, we get
a report instead of a silent spinner.

## Where it goes

| Purpose | Host | Auth |
|---|---|---|
| Ingest (tracker script + `/api/*`) | your OpenPanel ingest host (`VITE_OPENPANEL_API_URL` / `VITE_OPENPANEL_SCRIPT_URL`) | ungated (expose only the tracker asset + `/v1/*`; 403 everything else) |
| Dashboard | your OpenPanel dashboard host | put it behind your own SSO |

The tracker (`op1.js`) is **self-served by our own OpenPanel instance** — no
CDN, no third-party host. `apps/chat` loads it via OpenPanel's standard
`window.op` command-queue snippet (no npm SDK dependency), pointed at the
camouflaged, tracker-list-resistant paths above.

## How it's wired

- `apps/chat/src/telemetry.ts` — a small, **pure** wrapper: `createTelemetry(config)`
  installs the `window.op` queue, calls `op('init', { clientId, apiUrl, … })`,
  injects the tracker `<script>`, and exposes `track(name, props)` /
  `trackEvent(event)`. **Unit-tested** (`test/telemetry.test.ts`): correct
  event shapes, and a **hard no-op** when no client id is configured (so the
  app never breaks if analytics is unconfigured/down/offline).
- `packages/mesh-react` emits vendor-neutral `MeshTelemetryEvent`s (see
  `meshResilience.ts`) from the same points its hooks surface an error/
  lifecycle change. `App.tsx` passes `telemetry.trackEvent` as the sink —
  the mesh library never knows the analytics vendor.

## Events

| Event | Props | Fired when |
|---|---|---|
| *(pageview / RUM)* | — (automatic) | every page load |
| `host_load_failed` | `{ modelId, layerRange, reason, httpStatus? }` | a communal host's preload/shard fetch/worker load fails |
| `host_load_succeeded` | `{ modelId, layerRange }` | a communal host's claimed stage loads + warms |
| `communal_coverage` | `{ coveragePct, seats, hostCount }` | the mesh's coverage picture changes (deduped) |
| `chat_started` | `{ modelId }` | a driver begins a communal chat (leader-elected) |
| `chat_failed` | `{ reason }` | a chat errors or aborts involuntarily (not a user stop) |
| `chat_replan` | `{ restartCount }` | the driver replans after losing a host mid-reply |
| `stage_worker_crashed` | `{ where, reason }` | a stage worker process fires an `error` event |

## Privacy — no PII

Only **counts / states / reasons** are ever sent. `sanitizeProps` (enforced
inside the wrapper) keeps `string`/`number`/`boolean` scalars, **drops** any
nested object/array/function/null, and hard-truncates strings — so message
content or raw token ids can never ride along in an event, even by accident.
No message text, no tokens, no user identifiers.

## CSP / connect-src

`apps/chat/nginx.conf` ships **no Content-Security-Policy header**, so there
is nothing to allow-list — the tracker script load and the XHR/beacon to your
ingest host are not blocked. **If a CSP is ever added**, it must include that
host in both `script-src` (the tracker) and `connect-src` (event ingest).

## USER ACTION REQUIRED to turn it on

Tracking is a no-op until a real client id is set. To enable it:

1. In your OpenPanel dashboard, create a project and copy its **public client
   id**.
2. Add your deployment's origin to that project's **CORS allow-list**
   (OpenPanel matches origins EXACTLY — no subdomain wildcards).
3. Set `VITE_OPENPANEL_CLIENT_ID=<that id>` in your build `.env` (see
   `.env.example`) and rebuild `legion-chat`.

Until then the app ships and runs normally with analytics disabled.
