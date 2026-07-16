# Unstable Legion

**Browser-to-browser AI mesh on the Codec wire.** Peers run a local LLM
in a tab, broadcast their capabilities over a serverless WebRTC mesh,
and exchange token streams in Codec binary frames — no detokenize
on the relay path, no UTF-8 on the wire, prefiltered by the v0.4
client-side safety stack before transmission so doomed asks never
leave the browser.

Two consumption modes:

- **`npm install @unstable-legion/core @unstable-legion/react`** — framework-aware,
  for React sites that want full control of the UI.
- **Module Federation remote** at `https://cdn.../unstable-legion/remoteEntry.js`
  for sites that want a pre-built `<MeshChat />` / `<MeshRoster />` to
  drop in without rebuilding.

Both modes share the same `@unstable-legion/core` core: framework-free
TypeScript that owns the Trystero peer + Codec wire framing + safety
prefilter + WebGPU LLM lifecycle.

## What ships in v0.0.1

- **Peer mesh.** Trystero room joined via deployment-configured BitTorrent /
  IPFS / Nostr / MQTT relays — no Codec-side server. Each peer broadcasts
  `MeshPeerCap` describing its model, skills, tools, availability.
- **Roster.** Observable peer list. React binding via `useMeshRoster()`.
- **Chat over Codec wire.** Messages framed as Codec `msgpack` payloads
  (`@codecai/web`'s encoder). Wire stays binary; detokenize happens at
  the receiving peer's edge for display, or never if the next hop wants
  raw IDs.
- **Safety prefilter.** All outbound messages run through
  `@codecai/web-safety`'s `scanText` before encoding. Inbound messages
  optionally run through a classifier (`prompt-guard-86m` default tier)
  so doomed peer-to-peer traffic is filtered on receive too.
- **Local LLM.** Wraps `@mlc-ai/web-llm` with a `BroadcastChannel`-based
  leader election so one tab hosts the engine and other tabs talk to
  it. Avoids loading the model multiple times per browser.
- **No central server.** No tracker beyond the Trystero relay
  (configurable). No server-side state. No accounts.

## Anti-goals for v0.0.1

- Federated identity. Peers are anonymous; nick is operator-chosen.
- Persistent rooms. Mesh rebuilds each session. State syncs only
  between currently-connected peers.
- Server-side moderation. The whole point is client-side enforcement
  via the v0.4 safety prefilter + (opt-in) classifier.

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  apps/demo               Vite + React  (npm consumption mode)  │
│  ├── @unstable-legion/react (hooks, providers)                    │
│  └── @unstable-legion/core       (core: peer, wire, safety, engine)    │
│        ├── trystero      (WebRTC over BitTorrent / IPFS / ...) │
│        ├── @codecai/web  (Codec msgpack frames, tokenize)      │
│        ├── @codecai/web-safety (prefilter, classifier registry)│
│        └── @mlc-ai/web-llm  (browser LLM, WebGPU)              │
└────────────────────────────────────────────────────────────────┘
                            ▲
                            │  same @unstable-legion/core under the hood
                            ▼
┌────────────────────────────────────────────────────────────────┐
│  Any site, no rebuild   Module Federation  remoteEntry.js      │
│  └── @unstable-legion/mf   exposes <MeshChat />, <MeshRoster />,  │
│                          <SafetyBadge />, <MeshApp /> remotes  │
└────────────────────────────────────────────────────────────────┘
```

## Repo layout

```
unstable-legion/
├── packages/
│   ├── mesh-core/    @unstable-legion/core         framework-free TS lib
│   ├── mesh-react/   @unstable-legion/react   React hooks + providers
│   └── mesh-mf/      @unstable-legion/mf      Module Federation remote
└── apps/
    ├── demo/         @unstable-legion/demo      Vite + React workstream showcase/debug surface
    └── chat/         @unstable-legion/chat      Vite + React — the flagship product: an
                                                  Open-WebUI-style chat app where opening it
                                                  makes you part of the communal mesh serving
                                                  Qwen3-8B (docs/COMMUNAL.md, docs/TRUST.md)
```

## Quick start (npm)

```bash
npm install @unstable-legion/core @unstable-legion/react @codecai/web @codecai/web-safety
```

```tsx
import { MeshProvider, useMeshRoster, useMeshChat } from "@unstable-legion/react";

export function App() {
  return (
    <MeshProvider
      room="my-public-room"
      nick="alice"
      modelId="Qwen2.5-0.5B-Instruct-q4f16_1-MLC"
    >
      <MeshUi />
    </MeshProvider>
  );
}

function MeshUi() {
  const roster = useMeshRoster();
  const { send, messages } = useMeshChat();
  // ...
}
```

## Quick start (Module Federation)

In your Webpack 5 / Vite consumer:

```js
// vite.config.ts (or webpack.config.js, with @originjs/vite-plugin-federation)
federation({
  name: "host",
  remotes: {
    unstable_legion: "https://cdn.jsdelivr.net/npm/@unstable-legion/mf@latest/dist/assets/remoteEntry.js",
  },
  shared: ["react", "react-dom"],
});
```

In your code:

```jsx
const MeshApp = React.lazy(() => import("unstable_legion/MeshApp"));
// or pull individual components: import("unstable_legion/MeshChat"),
//                                import("unstable_legion/MeshRoster"),
//                                import("unstable_legion/SafetyBadge")

<Suspense fallback="loading mesh...">
  <MeshApp room="my-public-room" nick="alice" />
</Suspense>
```

## Wire shape (peer-to-peer)

Four Trystero actions:

| Action | Payload                                         | When                           |
|--------|-------------------------------------------------|--------------------------------|
| `cap`  | `MeshPeerCap` (model, skills, tools, available) | on join, 30s heartbeat, change |
| `cm`   | `MeshChatMessage` (chat metadata, small)        | each chat send                 |
| `cf`   | `Uint8Array` — Codec msgpack frame bytes        | each generation chunk          |
| `tc`   | `MeshToolCall` / `MeshToolResult`               | tool invocation                |

`cf` is the bandwidth-critical path. A peer's local LLM (wrapped via
[`@codecai/web-llm`](https://www.npmjs.com/package/@codecai/web-llm))
emits Codec msgpack frames, which travel the WebRTC data channel
as-is — same byte format vLLM / sglang / llama.cpp produce over HTTP.
Receiving peers consume via `@codecai/web`'s `decodeMsgpackStream`
byte-identically to a remote HTTP source. Relays and forwarding peers
pass frames through without detokenizing.

Bandwidth on a 500-token completion:

| Format             | Size  |
|--------------------|-------|
| JSON-SSE text      | ~75 KB |
| Codec msgpack      | ~5 KB  |
| Codec + dict-zstd  | ~500 B |

Over Trystero relays with ≤100 KB/s sustained throughput per peer,
that's the difference between a usable mesh and a stalling one.

## CI + deploy (workstream C4)

CI: `.forgejo/workflows/ci.yml`, runs on the Forgejo mirror's sync
pushes (this repo's Forgejo copy is a read-only pull mirror of
GitHub — commit workflow/source changes to GitHub `main`, they show up
on Forgejo within its mirror-sync interval). Builds `@unstable-legion/core`
+ `@unstable-legion/react` and runs their unit suites, after materializing
the two sibling-repo `file:` dependencies (Codec's `web`/`web-safety`/`web-llm`
and legion-stage-runtime's `stage-runtime`) at the same absolute paths the
dev machine's `/mnt/h/dev` layout uses. `apps/demo`'s Playwright e2e /
WebGPU chaos suite is a `workflow_dispatch`-only stub — no GPU on the
runner yet.

Deploy: **`legion.codecai.net` root-swapped to `apps/chat` as of M6
(2026-07-15)** — the flagship product now owns `/`; `apps/demo` (the
original workstream showcase) moved to `/classic/`. Both are built by
`docker-compose.yml`'s ONE `legion-chat` service (`apps/chat/Dockerfile`)
on the `.198` public-edge host (behind the existing `nginx-proxy` +
`acme-companion` stack). This is a single container/single nginx by
necessity, not preference: `nginx-proxy` routes by **hostname**, not
path, so "chat at `/` and demo at `/classic` on the same
`legion.codecai.net`" can't be two separate `VIRTUAL_HOST` services —
`apps/chat/Dockerfile` builds `apps/demo` too (with `vite build
--base=/classic/` so its own asset URLs resolve under that prefix
instead of colliding with the chat bundle's `/assets/`), and
`apps/chat/nginx.conf` serves the demo's `dist/` under `/classic/` from
the same nginx that serves the chat bundle at `/`. Shared root-absolute
paths (`/webllm/`, `/wasm/`, `/mcp-proxy/`, `/.well-known/`) work
identically for both — see the Dockerfile's and nginx.conf's comments
for exactly which app needs which and why `/.well-known/codec/` (demo's
MLC tokenizer-map fetch, not used by chat's own stage-runtime detokenize
path) is mirrored to both the root and `/classic/`. The old `legion-demo`
service / `unstable-legion-demo` container is retired by this change.

Before `docker compose build`:

1. `scripts/prepare-deploy-context.sh [legion-stage-runtime-dir] [codec-dir]`
   — materializes `codec-local/` and `.deploy-context/legion-stage-runtime/`
   as real files (Docker's build-context tar doesn't dereference symlinks
   pointing outside the context) from built sibling checkouts, and copies
   the wasm glue/binary into **both** `apps/demo/public/wasm/` and
   `apps/chat/public/wasm/` (M6: the image builds both apps now).
2. The model weights (`full.gguf` + the per-layer package, for both
   `apps/demo`'s MLC models and `apps/chat`'s fixed `qwen3-8b-q4` target)
   are NOT part of the image — they live on the host's `webllm-mirror`
   volume under a `stages/<model-id>/` subpath, same mount `/webllm/`
   already reads from.

This isn't wired to CD yet (no Forgejo Actions secret grants deploy SSH
access to `.198` — that's a deliberate gap, not an oversight: minting a
new persistent credential onto a shared production edge host needs an
explicit go-ahead first). Until then, deploy is: rsync/tar a prepared
checkout to `.198:/storage/unstable-legion` (keep a timestamped backup of
the previous checkout first — `cp -a` the whole directory — for
rollback), `docker compose build legion-chat`,
`scripts/verify-turn-baked.sh`, then cut over: stop + remove the old
`unstable-legion-demo` container (if present) so `nginx-proxy` doesn't
see two containers claiming the same `VIRTUAL_HOST`, then
`docker compose up -d legion-chat`.

**GOTCHA (Windows dev machines):** `codec-local/packages/{web,web-safety,web-llm}`
are git-tracked **symlinks** to a sibling Codec checkout. A Windows `git`
checkout without symlink privileges materializes these as tiny text
files containing the link target, not real directories — rsyncing a
Windows checkout's `codec-local/` (or `.deploy-context/`, gitignored but
easy to have stale/partial locally) over a deploy host's already-correctly-materialized
copies silently breaks the next build. Exclude both `codec-local/` and
`.deploy-context/` from the rsync when the deploy host already has good
copies from a prior `prepare-deploy-context.sh` run; only re-run that
script (from a machine with real sibling checkouts, or directly on a
Linux host) if those need refreshing.

**TURN config gotcha (M0.5 reliability spike, 2026-07-15):** `docker
compose build` reads `VITE_TURN_URLS` / `VITE_TURN_USERNAME` /
`VITE_TURN_CREDENTIAL` / `VITE_TURN_USE_DEFAULT` from a `.env` file next
to `docker-compose.yml` on the deploy host (see `.env.example`). If that
`.env` is missing, the build **succeeds silently** with a STUN-only
bundle — no self-hosted coturn, no error, no warning. This is exactly
what happened in production for the first several days: `legion-coturn`
ran healthy the whole time while the deployed demo never used it. Always:
1. Confirm `.198:/storage/unstable-legion/.env` has real values (credential
   from `.198:/storage/coturn/turnserver.conf`, never commit it).
2. After `docker compose build legion-chat`, run
   `scripts/verify-turn-baked.sh` before `up -d` — it fails loud if the
   TURN URL isn't actually in the built bundle. Both apps/chat and the
   `/classic` apps/demo build share the same build-time args, so one
   check (against the chat bundle) covers both.

See `docs/TURN-RELIABILITY.md` for the full M0.5 reliability findings and
verdict (verdict: YELLOW — self-hosted TURN is correctly configured and
wired in, but true cross-NAT reachability from a genuinely external
network is still unverified; this lab has no vantage point outside its
own NAT to test it from, and M6 did not change that).

## Status

**M6 shipped (2026-07-15): the chat pivot is complete.** `apps/chat` —
the flagship Open-WebUI-style product where opening the page makes you
part of the communal mesh serving a fixed Qwen3-8B — is live at the root
of `legion.codecai.net`. `apps/demo` (the original workstream
showcase/debug surface) moved to `legion.codecai.net/classic`. Tool calls
(`tc`), classifier-on-receive, and the Module Federation remote build
remain in progress/pre-release for the underlying `@unstable-legion/core`
+ `@unstable-legion/react` packages.

## Related

- [Codec](https://github.com/wdunn001/Codec) — the wire format
- [`@codecai/web`](https://www.npmjs.com/package/@codecai/web) — JS client
- [`@codecai/web-safety`](https://www.npmjs.com/package/@codecai/web-safety) — prefilter + classifiers
- [`@codecai/web-llm`](https://www.npmjs.com/package/@codecai/web-llm) — wraps `@mlc-ai/web-llm` as a Codec source
- [`@mlc-ai/web-llm`](https://github.com/mlc-ai/web-llm) — upstream WebGPU browser LLM runtime

## License

[BSL-1.1](LICENSE). Source-available, free for non-production use,
commercial production use requires a license (matches Codec's posture).
