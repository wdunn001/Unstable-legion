# Telemetry (RUM beacon): apps/chat

`apps/chat` (the flagship product at `legion.codecai.net`) reports pageview
plus a small set of custom **failure/lifecycle** events to the fleet RUM
beacon, the project's ONLY analytics stack. This exists so the live app is
*observable*. When a user's hosting or chat fails, we get a report.

## Where it goes

| Purpose | Host | Auth |
|---|---|---|
| Ingest | `/rum` on the app's own origin (`VITE_RUM_API_URL`, default `/rum`) | none needed; POST only, body capped, nginx forwards it |
| Storage | VictoriaLogs on the fleet metrics host | LAN only, never publicly named |
| Reading it | LogsQL, and the analytics card on `ops.quasarke.net` | behind the usual SSO |

Same origin is the design. A beacon posted to the site's own domain needs no
CORS preflight, no second certificate, and no public hostname pointing at the
log store. nginx-proxy holds the only route to VictoriaLogs, and the stream
fields are fixed server-side so a hostile client cannot invent new index
dimensions.

There is no tracker script. Nothing is fetched, so there is no CDN, no
third-party host, and no npm SDK.

## How it's wired

- `apps/chat/src/telemetry.ts` is a small, **pure** wrapper.
  `createTelemetry(config)` returns `track(name, props)` / `trackEvent(event)`,
  and each call POSTs one JSON line via `navigator.sendBeacon`. **Unit-tested**
  (`test/telemetry.test.ts`): correct payload shapes, and a **hard no-op** when
  no site id is configured, so the app never breaks if analytics is
  unconfigured, down or offline.
- The session id lives in `sessionStorage` under `_rv`, the same key the
  nginx-injected beacon writes. Sharing it is what lets an event from the app
  land on the same session as the page views the edge recorded. It dies with
  the tab and follows nobody between visits.
- `packages/mesh-react` emits vendor-neutral `MeshTelemetryEvent`s (see
  `meshResilience.ts`) from the same points its hooks surface an error or
  lifecycle change. `App.tsx` passes `telemetry.trackEvent` as the sink. The
  mesh library never knows the analytics vendor.

### History

This replaced OpenPanel in September 2026. OpenPanel needed a tracker script,
a CORS allow-list per origin, and a minted client id. An edge-injected copy of
that script plus the bundled copy once ran `site.js` twice and threw on the
second bootstrap, which is the failure the same-origin beacon makes impossible.

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

## Privacy: no PII

Only **counts / states / reasons** are ever sent. `sanitizeProps` (enforced
inside the wrapper) keeps `string`/`number`/`boolean` scalars, **drops** any
nested object/array/function/null, and hard-truncates strings. This means
message content or raw token ids can never ride along in an event, even by accident.
No message text, no tokens, no user identifiers.

## CSP / connect-src

`apps/chat/nginx.conf` ships **no Content-Security-Policy header**. There
is nothing to allow-list. The tracker script load and the XHR/beacon to your
ingest host are not blocked. **If a CSP is ever added**, it must include that
host in both `script-src` (the tracker) and `connect-src` (event ingest).

## USER ACTION REQUIRED to turn it on

Tracking is a no-op until a real site id is set. To enable it:

1. Set `VITE_RUM_SITE_ID=<this deployment's hostname>` in your build `.env`
   (see `.env.example`) and rebuild `legion-chat`. Events are grouped by that
   value, so use the public hostname.
2. Confirm the edge forwards `/rum`. nginx-proxy needs a server-level
   `vhost.d/<host>` file containing the `location /rum` block. See
   `stacks/rum-edge` in the homelab repo.

There is no dashboard project to create, no client id to mint, and no CORS
allow-list to maintain. Same origin removes all three.

Until a site id is set the app ships and runs normally with analytics disabled.
