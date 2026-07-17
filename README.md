# Unstable Legion

**A browser mesh that runs one LLM across many tabs.** Open
[legion.codecai.net](https://legion.codecai.net) and your tab becomes part of
the model: there is no server running Qwen3-8B somewhere — the people in the
room are. The model's transformer layers are **split across peers** (pipeline
parallelism over WebRTC), so no single browser has to hold all 8B parameters.
Contributors host layer ranges and keep it fast for everyone; nobody is ever
cut off.

This is not "each peer runs its own chatbot." It is **one distributed model**:
a prompt is tokenized locally, its hidden-state **activations** are streamed
stage-to-stage across the mesh, and the final stage streams tokens back.

## How it works

**Pipeline-split inference.** Qwen3-8B is 36 transformer layers. They're sliced
into a per-layer GGUF package (sha256-addressed shards, fetched from Hugging
Face → `cdn.codecai.net` fallback, cached in OPFS). Each peer loads a
**contiguous range** of layers into WebGPU and serves it as a *stage*:

```
  your tab (driver)        communal host A        communal host B      final
  ┌───────────────┐  sf   ┌───────────────┐  sf  ┌───────────────┐  tokens
  │ embed + [0,k)  │─────▶│   [k, m)       │────▶│   [m, 36) +    │──────▶ you
  │ (or thin: none)│ act. │                │ act.│   lm_head      │
  └───────────────┘       └───────────────┘      └───────────────┘
```

- A **capable driver** hosts the embeddings + first few layers `[0, driverLayers)`
  locally; a **thin driver** (no usable WebGPU) hosts nothing and leans on a
  remote `isFirst` host (see `docs/OPTIONAL-STAGE0.md`).
- **Communal hosts** each claim a layer range via a self-assembly loop
  (`packages/mesh-core/src/communalAssembly.ts`) so the mesh collectively covers
  `[0, 36)`. The driver plans a route through the available hosts, and **re-plans
  on churn** — a host dropping/stalling triggers continue-from-history recovery
  (`docs/COMMUNAL.md`).
- Only the boundary **activations** cross the wire (f16 by default —
  `docs/WIRE-DTYPE.md`), one header per stream then one frame per token; the KV
  cache stays on each host.

## The mesh (serverless WebRTC)

Peers find each other and connect with **no application server** — but two
pieces of shared infrastructure make that reliable, both self-hosted off-ISP on
a VPS (public infrastructure proved unreliable — see the docs):

- **Signaling** (WebRTC offer/answer exchange, peer discovery): an
  **MQTT-over-WSS** broker, configured via `VITE_RELAY_URLS`. Run your own —
  public MQTT brokers stalled discovery outright here (peers never exchanged
  SDP), which is a silent failure: without a data channel a peer never enters
  the roster at all, so it looks like "nobody is home" rather than an error.
- **NAT traversal** (STUN/TURN): a **coturn** relay, configured via
  `VITE_TURN_*`. Host it OFF your own ISP if you can — a home router that won't
  hairpin can't serve a peer sitting beside it, and a relay that only offers
  UDP will strand mobile carriers. `scripts/verify-turn-baked.sh` guards the
  build against silently shipping a STUN-only bundle.

Under the hood the transport is [trystero](https://github.com/dmotz/trystero)
(`@trystero-p2p/mqtt`) with a self-hosted `rtcConfig.iceServers`; discovery
brokers and ICE servers are both configurable (`VITE_RELAY_URLS`, `VITE_TURN_*`).

## Contributing capability

- **Host a stage.** Consent to hosting and your tab claims a layer range and
  serves it to other drivers — the "contributors keep it fast" loop. Standing /
  economy (who's pulling their weight) is tracked in `docs/ECONOMY.md`.
- **Contribute tools.** A peer can advertise **MCP tools** to the network; the
  model can then call them mid-generation and any peer can serve them
  (`docs/TOOL-NODES.md`).
- **Safety + trust.** Outbound prompts run a client-side safety prefilter before
  they ever leave the browser; trust posture and the (opt-in) receive-side
  classifier are in `docs/TRUST.md`.

## Repo layout

```
unstable-legion/
├── packages/
│   ├── mesh-core/    @unstable-legion/core   framework-free TS: peer/wire/roster,
│   │                                         stage planner, communal assembly,
│   │                                         orchestrator, guards
│   ├── mesh-react/   @unstable-legion/react  React hooks (useCommunalChat,
│   │                                         useCommunalHost, useStageHost, …)
│   └── mesh-mf/      @unstable-legion/mf      Module Federation remote (pre-release)
└── apps/
    ├── chat/         @unstable-legion/chat    THE product — the communal chat app
    │                                          at legion.codecai.net/
    └── demo/         @unstable-legion/demo    the original workstream showcase,
                                               now at legion.codecai.net/classic/
```

The stage runtime itself (llama.cpp sliced to serve one layer range in WebGPU,
compiled to wasm) lives in the sibling **legion-stage-runtime** repo and is
materialized into the deploy context at build time.

## Wire shape (peer-to-peer)

Trystero actions on the data channel:

| Action | Payload | Role |
|--------|---------|------|
| `cap`  | `MeshPeerCap` — model, layer host capacity, tools, standing | advertise on join / 30s heartbeat / change |
| `sf`   | `Uint8Array` — activation-wire frames (hidden states between stages) | **the bandwidth-critical path** |
| `tc`   | `MeshToolFrame` — stage session control (ping/open/token/stop) + tool calls | drive a pipeline + invoke tools |
| `cm` / `cf` | `MeshChatMessage` / Codec msgpack frame | chat metadata + token frames for display |

The activation path (`sf`) is why the mesh is viable at trystero relay
throughput: an f16 hidden-state frame is `nEmbd × 2` bytes per token per hop,
and only crosses at stage boundaries — no detokenize, no JSON on the wire.

## Build it yourself

One image serves both apps: `apps/chat` at `/` (the flagship) and the older
`apps/demo` at `/classic/` (built with `--base=/classic/`). See
`apps/chat/Dockerfile`.

    npm install
    npm run build -w @unstable-legion/core
    npm run build -w @unstable-legion/react
    npm run build -w @unstable-legion/chat
    docker compose build legion-chat        # both apps, one nginx

### The wasm stage runtime

`@unstable-legion/stage-runtime` needs its emscripten artifact
(`legion-stage.{js,wasm}`), which is **not** published or checked in — build it
from that repo with `scripts/build-wasm.sh` inside an activated emsdk
environment (`source $EMSDK/emsdk_env.sh`), then copy the output into
`packages/stage-runtime/wasm/`. `scripts/prepare-llama.sh` prepares the patched
llama.cpp it compiles against.

`scripts/prepare-deploy-context.sh` materializes `codec-local/` and
`.deploy-context/legion-stage-runtime/` as real files first — Docker's
build-context tar doesn't dereference the sibling-repo symlinks, and on Windows
checkouts those symlinks materialize as text stubs.

### Build-time config (`.env`, see `.env.example`)

- `VITE_TURN_URLS` / `VITE_TURN_USERNAME` / `VITE_TURN_CREDENTIAL` — your TURN
  relay. **A missing `.env` silently ships a STUN-only bundle**, which strands
  every cross-NAT peer — run `scripts/verify-turn-baked.sh` after the build to
  fail loudly instead.
- `VITE_RELAY_URLS` — signaling brokers (MQTT-over-WSS).
- `VITE_OPENPANEL_CLIENT_ID` — analytics; a hard no-op when absent
  (`docs/TELEMETRY.md`).

Model weights are **not** in the image. Point the deployment at a per-layer
package served under `/webllm/stages/<model-id>/` (see `SLICING.md`).

## Status

The chat pivot is complete: `apps/chat` is live at the root of
`legion.codecai.net`, running the communal pipeline-split Qwen3-8B. Self-hosted
TURN and MQTT signaling are deployed and validated (two peers discover + connect
through the self-hosted broker). Communal self-assembly, thin drivers, the f16
activation wire, and tool nodes are wired end-to-end. In progress: host-health
demotion + non-contiguous-gap re-partition (churn resilience), the Module
Federation remote, and larger-model "channels."

## Related

- [Codec](https://github.com/wdunn001/Codec) — the wire format
- [`@codecai/web`](https://www.npmjs.com/package/@codecai/web) — JS client + framing
- [`@codecai/web-safety`](https://www.npmjs.com/package/@codecai/web-safety) — prefilter + classifiers
- **legion-stage-runtime** — the sliced llama.cpp WebGPU stage runtime (sibling repo)

## License

[BSL-1.1](LICENSE). Source-available, free for non-production use; commercial
production use requires a license (matches Codec's posture).
