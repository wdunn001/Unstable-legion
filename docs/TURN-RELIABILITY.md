# TURN reliability spike (M0.5) — findings and verdict

Date: 2026-07-15. Scope: is WebRTC relay (coturn) reliable enough to build
the "operate over the open internet" premise on, before committing M1-M6
to that architecture.

## VERDICT: YELLOW

coturn itself is correctly configured and functionally sound. A real,
previously-undiagnosed **P0 bug was found and fixed**: the production demo
had **never** actually used the self-hosted TURN server — it shipped
STUN-only for its entire deployed lifetime while coturn ran healthy and
unused. That fix is deployed and verified live. What remains unverified —
and it's the load-bearing question — is whether a genuinely external
client (different network than the coturn host) can complete the TURN
relay data path. This environment has no network vantage point outside
the lab's own NAT, so that specific test could not be run. Recommendation
below is the fast, cheap way to close that gap and turn this YELLOW into
GREEN or RED with real evidence.

## 1. coturn deployment audit

- Container: `legion-coturn` (`coturn/coturn:4.6`), `network_mode: host`,
  running on **`.198`** (the public edge host), NOT `.88`. Confirmed via
  `docker ps` on both hosts. Up 3+ days at test time, no restarts.
- Compose: `deploy/coturn/docker-compose.yml`. Config:
  `/storage/coturn/turnserver.conf` on `.198`, byte-identical to the
  repo's `deploy/coturn/turnserver.conf.example` (no drift).
- Config summary:
  - `listening-ip=0.0.0.0`, `listening-port=3478`, `external-ip=96.38.108.201`
    (matches the lab's real public IP — Spectrum, no CDN in front, per
    [[public-edge-exposure]]).
  - `lt-cred-mech` (static long-term credential), `realm=legion.codecai.net`.
    Not the REST/HMAC time-limited scheme — acceptable for this
    single-tenant deploy per the config's own comment.
  - Relay port range `min-port=49152` / `max-port=49200` (49 ports).
  - `no-tls` / `no-dtls` / `no-tcp-relay` — UDP-only relay, plain `turn:`
    (no `turns:`). Browsers accept plain `turn:` from an HTTPS page
    (the demo is HTTPS), so this is fine.
  - `denied-peer-ip` blocks all RFC1918 ranges + loopback + link-local +
    CGNAT (100.64/10) — correct SSRF/LAN-scan protection. Side effect:
    this makes it **impossible to functionally test relay-to-relay data
    forwarding from inside the LAN** (see §2) — the deny-list is doing
    exactly what it's supposed to.
- Client-side wiring (`apps/demo`): `VITE_TURN_URLS` /
  `VITE_TURN_USERNAME` / `VITE_TURN_CREDENTIAL` / `VITE_TURN_USE_DEFAULT`
  are Vite build-time-only args (`apps/demo/Dockerfile`, `App.tsx`,
  `packages/mesh-core/src/iceServers.ts`). `defaultTurnConfig()` is
  STUN-only by default and does **not** fall back to the bundled OpenRelay
  public TURN entries unless `VITE_TURN_USE_DEFAULT=1` — good, since
  OpenRelay's TLS endpoint is confirmed dead (per the helper's own
  comment) and a dead TURN URL actively breaks ICE gathering.
- `relayConfig.urls` vs `relayUrls` gotcha (documented in `App.tsx`):
  correct key is in use. Not a live bug.

## 2. THE BUG: TURN was never wired into the deployed build

`docker compose config` on `.198` (before the fix) resolved:

```
VITE_TURN_CREDENTIAL: ""
VITE_TURN_URLS: ""
VITE_TURN_USE_DEFAULT: ""
VITE_TURN_USERNAME: ""
```

No `.env` file existed at `/storage/unstable-legion/`. Grepping the
**live production bundle's** JS assets confirmed it: `turn:openrelay.metered.ca:*`
string literals were present (dead code from the bundled-but-inactive
OpenRelay constant), but **`legion.codecai.net` did not appear anywhere in
the bundle**. The self-hosted coturn — running fine for at least 3 days —
was completely disconnected from the app. Every peer that needed TURN
(anyone behind symmetric NAT/CGNAT) had zero fallback and simply failed to
connect, silently, with `defaultTurnConfig()` returning `[]`.

This is deploy-runbook drift, not a code bug: the repo's own
`docker-compose.yml` comments and `README.md` already documented the
`VITE_TURN_*` build args — nobody had actually populated them on a real
deploy since coturn was stood up. Given the ticket's framing
("recurring historical pain... over TURN/coturn/ICE"), this plausibly
explains most or all of it: it isn't that TURN didn't work, it's that TURN
was never engaged at all.

**Fix applied and verified live:**
1. Wrote `/storage/unstable-legion/.env` on `.198` with
   `VITE_TURN_URLS=turn:legion.codecai.net:3478`, `VITE_TURN_USERNAME=legion`,
   `VITE_TURN_CREDENTIAL=<coturn's static password>`, `VITE_TURN_USE_DEFAULT=0`
   (left OpenRelay off — it's dead).
2. `docker compose build legion-demo && docker compose up -d legion-demo`.
3. Verified post-deploy: `docker exec unstable-legion-demo grep -o
   'turn:legion.codecai.net:3478' assets/*.js` now matches (it didn't
   before the fix); `https://legion.codecai.net/` returns `200`.

**Persisted to IaC** (commit on `main`, this doc's own PR):
- `.env.example` — documents the 4 required vars + the exact failure mode,
  so a missing `.env` is discoverable instead of silently degrading.
- `scripts/verify-turn-baked.sh` — greps a built image's bundle for the
  expected `turn:<host>` string and **fails the build** if it's missing.
  Not wired to CD yet (deploy is still manual per the existing CD gap
  documented in `README.md`), but the manual runbook now calls it out as
  a required post-build step.
- `README.md` CI+deploy section amended with the gotcha + the two-step
  checklist.

## 3. Reachability from outside the LAN — NOT VERIFIED (the open gap)

This is the most important unresolved item and the reason the verdict is
YELLOW, not GREEN.

**No external network vantage point was available in this environment.**
Checked: this workstation, `.88`, and `.198` all share the same public
egress IP (`96.38.108.201` — verified via `curl ifconfig.me` / `api.ipify.org`
from the workstation matching coturn's configured `external-ip`). There is
no cloud VM, remote shell, or off-LAN host reachable from here. A true
"outside the NAT" test (the standard way to validate a home-hosted TURN
server) could not be performed.

What WAS tested, from the LAN:

- **`turnutils_uclient` against `127.0.0.1` (on `.198` itself):**
  allocate + refresh **succeed** repeatedly, relay address correctly
  reported as `96.38.108.201:<port in 49152-49200>`. `channel bind` to the
  default self-target then fails with `403 Forbidden IP` — expected and
  correct, since `denied-peer-ip` blocks `127.0.0.0/8` by design. This
  confirms coturn's core allocate/refresh protocol handling is correct,
  but does not exercise real peer-to-peer data relay (nothing else in the
  LAN is a legal peer target either — the deny-list blocks all of
  `192.168.0.0/16` too, on purpose).
- **`turnutils_uclient` from `.88` against the public IP
  `96.38.108.201:3478`** (the "hairpin" path — LAN host dialing the
  router's own public address): TCP got an immediate `Connection refused`;
  UDP got **total silence**, confirmed via a `tcpdump` capture running on
  `.198` during the attempt — **zero packets** matching `udp port 3478`
  arrived at the host, across two independent attempts. This means the
  packets never got back to `.198` via the router at all.
- **Real ICE test via the app's own stack** (`@trystero-p2p/mqtt` 0.24.0,
  pinned to the exact version the app's lockfile uses, `rtcConfig:
  {iceTransportPolicy:'relay'}`, real coturn credentials, `werift` as the
  Node WebRTC polyfill so both "peers" could run without a browser):
  MQTT signaling + offer/answer exchange completed normally (~2.5s,
  comparable to the ~1.6-2.7s connect time of a STUN-only control run
  using the identical harness). ICE gathering completed in under a
  second. But `iceConnectionState` sat in `checking` for ~23 seconds, then
  the connection **closed and retried** — it never reached `connected`.
  This is the same wall as the `turnutils_uclient` hairpin test: the relay
  candidate coturn hands out is always addressed at `external-ip`
  (`96.38.108.201:<port>`) regardless of which address the client dialed
  to reach the control channel, so the actual STUN connectivity-check
  traffic between the two relay candidates has to make the same
  LAN→router→public-IP→router→LAN hairpin round trip that the raw UDP
  test already showed produces zero replies. There is no way to route
  around this from the LAN: dialing the LAN IP for signaling doesn't
  change what address the DATA candidate gets advertised at.

**What this does and doesn't prove:** it conclusively shows this specific
network (client + coturn behind the same consumer router) cannot hairpin
NAT loopback traffic to its own public IP — a very common consumer-router
limitation, and largely irrelevant to real users (two strangers on
different networks don't need hairpin; only "testing from the same LAN as
the server" does). It does **not** prove or disprove that the port-forward
(`UDP 3478` + `UDP 49152-49200` → `.198`, called out as a manual one-time
step in `deploy/coturn/docker-compose.yml`'s own header comment) was ever
actually completed on the router — hairpin failure and "forward rule
missing" are indistinguishable from inside this LAN. Router admin access
was not available to check the forwarding table directly.

## 4. Forced-relay datachannel / sustained-traffic test

**Could not be completed** — every available run configuration (LAN
control address, public hostname, same-machine peers) funnels through the
identical hairpin wall in §3: ICE gathering and MQTT signaling succeed,
the connectivity check against the relay candidate never completes, the
connection cycles `connecting → checking → closed → retry` indefinitely.
No datachannel ever opened, so no throughput/stability numbers could be
collected in this environment.

The harness itself is real and reusable once an external vantage exists:
`@trystero-p2p/mqtt@0.24.0` (version-pinned to match the app's lockfile
exactly — the latest `0.25.3` has a **breaking API change** in
`room.makeAction()`, tuple → object shape; worth flagging as an upgrade
risk since `package.json` currently uses a caret range `^0.24.0` against a
lockfile pinned to `0.24.0` exactly) + `werift` as `rtcPolyfill`, forcing
`iceTransportPolicy: 'relay'`, sending 4KB payloads at 30/s with sequence
numbers for drop detection and inter-arrival gap tracking for stall
detection. Not committed to the repo (it's a diagnostic scratch tool, not
product code) but the design is documented here for reuse: run one peer
process from a real external host (cloud VM, phone hotspot) and one from
the lab, both pointed at `turn:legion.codecai.net:3478` with
`iceTransportPolicy:'relay'`, for 3-5 minutes, and read each side's
`sent`/`received`/`stallCount`/`maxStallMs` summary.

## 5. Incident: credential exposure during diagnosis

A diagnostic script (not committed, scratch-only) `JSON.stringify()`'d the
full ICE `rtcConfiguration` — including the TURN `username`/`credential`
— into a log line that was then read back into the operator's tool
context. The static coturn credential in `/storage/coturn/turnserver.conf`
on `.198` should be treated as **compromised** and rotated
(`openssl rand -hex 24`, update the `user=legion:...` line, restart
`legion-coturn`, then rebuild the demo with the new `VITE_TURN_CREDENTIAL`
and re-run `scripts/verify-turn-baked.sh`). This rotation was attempted
during the same session and blocked by the auto-mode permission
classifier (secret-store write to a shared host) — it was **not** forced
through. It needs to happen as a follow-up, ideally before the next
production traffic through coturn.

## 6. Root-caused issues summary

| Issue | Root cause | Status |
|---|---|---|
| TURN never engaged in production | `.env` with `VITE_TURN_*` never created on the deploy host; build silently defaults to STUN-only | **Fixed + deployed + verified** |
| No guard against the above regressing | Nothing checked the built bundle actually contained the TURN URL | **Fixed**: `scripts/verify-turn-baked.sh` + `.env.example` + README callout |
| Bundled OpenRelay public TURN is dead | Upstream OpenRelay TLS endpoint ECONNREFUSED, credentials deprecated | Already handled — `useDefault` opt-in, off by default (pre-existing, confirmed still correct) |
| External TURN reachability unverified | No off-LAN test vantage available in this environment; LAN-based hairpin test is structurally inconclusive | **Open** — needs an external vantage point (see recommendation) |
| Router UDP port-forward for 3478 / 49152-49200 unconfirmed | No router admin access from this environment | **Open** — needs direct router check or a successful external test (either would resolve it) |
| `@trystero-p2p/mqtt` semver risk | `package.json` uses `^0.24.0`; `0.25.x` changed `makeAction()`'s return shape (array → object), which would silently break `mesh-core`'s destructuring if a future install floats forward without the lockfile | **Open, minor** — recommend pinning exactly or adding a CI check that the installed version matches the lockfile major.minor |

## 7. Recommendation — how to close the YELLOW gap

Cheapest fast path: spin up a $5/month-tier cloud VM (or even a hosted
free-tier instance) for under an hour, or have a human tether a laptop to
a phone hotspot, and from that genuinely external network run:

```
turnutils_uclient -v -y -u legion -w <credential> legion.codecai.net
```

Success (allocate + refresh + a real cross-network data exchange) turns
this GREEN. Silence or refusal turns it RED and points straight at the
router's port-forward rule as the next thing to fix (a 5-minute router
config change, not an architecture problem). Either outcome is
actionable and cheap to obtain — this is the single highest-leverage next
step before committing further M1-M6 work to the internet-relay premise.

Until that test runs, treat the mesh's internet-relay path as
**unconfirmed in production topology**, even though the demo is now
correctly configured to use it.
