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
    └── demo/         @unstable-legion/demo      Vite + React demo
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

## Status

Pre-release. The v0.0.1 cut is the cap-announce + roster + chat slice
described above. Tool calls (`tc`), classifier-on-receive, and the
Module Federation remote build are in progress.

## Related

- [Codec](https://github.com/wdunn001/Codec) — the wire format
- [`@codecai/web`](https://www.npmjs.com/package/@codecai/web) — JS client
- [`@codecai/web-safety`](https://www.npmjs.com/package/@codecai/web-safety) — prefilter + classifiers
- [`@codecai/web-llm`](https://www.npmjs.com/package/@codecai/web-llm) — wraps `@mlc-ai/web-llm` as a Codec source
- [`@mlc-ai/web-llm`](https://github.com/mlc-ai/web-llm) — upstream WebGPU browser LLM runtime

## License

[BSL-1.1](LICENSE). Source-available, free for non-production use,
commercial production use requires a license (matches Codec's posture).
