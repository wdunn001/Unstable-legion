# mesh-llm → Legion: pattern-merge assessment

**Date:** 2026-07-14
**Subject:** [Mesh-LLM/mesh-llm](https://github.com/Mesh-LLM/mesh-llm) (Apache-2.0, Rust + iroh QUIC + vendored llama.cpp, v0.73.1, shipping near-daily). Mirrored at `legion-ref/mesh-llm` on Forgejo, working clone at `H:\dev\mesh-llm`.
**Question:** can mesh-llm's concepts (above all its **Skippy pipeline layer-splits**) be merged with web-llm + Trystero so that a large model runs *split across browser peers*? Browser-side pipeline-parallel inference has never been shipped by anyone.

---

## Verdict

**The concept survives contact with the code.** Skippy's mechanism is cleanly layered and most of it is transport-agnostic policy + a small binary frame format. All of it is portable to Legion's existing Codec-frame wire almost verbatim. The activation traffic is tiny (8 KiB/token/boundary at f32 for an 8B model, half that at f16, and Skippy already treats f16 as the default wire dtype). That is *exactly* the small-frames-over-cheap-P2P regime Legion's wire was designed for. Prior-art search found **no shipped project doing WebGPU pipeline-parallel across browser peers**. Petals is the server-side ancestor (Python/hivemind); "AI Grid"/peerd.ai do not split layers; mesh-llm's own roadmap has zero browser/WASM plans. The intersection is genuinely open.

**One load-bearing gap decides everything:** no browser runtime today exposes *partial-layer forward with activation injection*. Load layers N..M only, accept a hidden-state tensor as input, emit the boundary hidden-state. Skippy gets this from a patched llama.cpp "stage ABI." Until a browser equivalent exists, every other portable piece (frame format, planner, failure model, routing) has nothing to run on. That runtime shim is the critical path, and it is real but scoped engineering.

Realistic performance envelope: pipeline decode is serial per token. Each stage boundary therefore adds one WebRTC hop RTT to every token. On LAN/homelab RTTs (1 to 5 ms) a 2-to-3-stage split is comfortably usable; over the public internet (~60 to 100 ms/hop) a 4-stage split eats 180 to 300 ms/token in pure network before any compute: low single-digit tok/s, Petals territory. **Target the LAN/community case first** (several browsers on one network pooling into one bigger model); the public-internet swarm is a later, harder story.

---

## 1. The headline: Skippy splits across browser peers

### 1.1 What Skippy actually does (mechanism digest)

Source ground truth (paths in the mirror): `crates/skippy-protocol/src/binary/{types,codec,activation}.rs`, `crates/skippy-runtime/src/lib.rs`, `crates/skippy-server/src/binary_transport.rs` (+ `direct_return.rs`), `crates/skippy-topology/src/lib.rs`, `docs/SKIPPY.md`, `docs/skippy/DATA_FLOW.md`, `docs/LAYER_PACKAGE_REPOS.md`.

- **Stage contract.** A model is cut into contiguous layer ranges. Stage 0 owns tokenizer + embedding table; the final stage owns final-norm + `lm_head` and **does the sampling**; every stage owns the KV cache for its own layers only. Sampling params (temp/top_p/penalties/grammar) ride inside the frame so the final stage samples with the request's config.
- **Token loop.** Prefill flows downstream in chunks (one frame per prefill chunk, ≈2 MiB max at f32/256 tokens); decode sends **one activation frame per token per boundary** (`token_count × n_embd`, f32=4B/elem, f16=2B/elem, q8 opt-in). The final stage samples and, in protocol generation 3, returns the predicted token id **directly to the stage-0 driver** on a dedicated return stream keyed by `(request_id, session_id)`, bypassing intermediate hops.
- **Frame format.** 76-byte fixed little-endian header (kind, positions, token counts, a 10×i32 state header incl. seq/phase/flags/decode_step, request+session u64s) + optional sampling section + sideband token/position arrays + activation payload. Some model families need sideband multipliers (RWKV7 ×2, Gemma3N-AltUp ×4).
- **Packaging.** Models ship as **layer-package repos**: `shared/{metadata,embeddings,output}.gguf` + `layers/layer-NNNNN.gguf` fragments, each with size + SHA-256, manifest `model-package.json`. A stage loads only its slice's tensors (`layer_start..layer_end`, `include_embeddings`, `include_output` flags into the llama.cpp stage ABI).
- **Planning.** `skippy-topology`: weight-proportional contiguous splits by per-node VRAM (`layers × node.vram / total`), package-aware ordering by cached-slice residency + RTT + availability, **minimize physical stage count** because each hop adds serialized decode latency (their TPOT model: `hops×RTT + max(stage_compute) + overhead`; their own numbers: 2 stages ≈ 50 tok/s ceiling, 4 ≈ 25, on datacenter RTTs). Per-family boundary capability gating (some families reject q8 wire dtype or have sticky recurrent-state owners).
- **Startup & failure.** Downstream stages load **first** and must signal ready before upstream sends anything; stage 0 becomes routable only when the whole chain is ready. On any stage loss: **abort in-flight generations, tear down, replan a fresh topology with a new run id**: no mid-generation resume, by explicit design (distributed KV makes resume not worth it). A term-fenced coordinator lease prevents split-brain replans.

### 1.2 Why this maps onto Legion better than it first looks

Legion already has the hard parts of the *mesh* half:

| Skippy needs | Legion already has |
|---|---|
| Peer discovery + capability advertisement | `cap` action, 30s heartbeat, roster with staleness (`packages/mesh-core/src/peer.ts`, `types.ts`) |
| Binary frame transport between specific peers | Codec msgpack frames over Trystero data channels (`wire.ts`, `webrtc-codec.ts`) — the "never detokenize on the relay path" design generalizes directly to "never *detokenize-or-decode* activations on the relay path" |
| Direct-return stream to the driver | Trystero unicast to a known peerId — same shape as the `/ai @nick` path |
| Stage readiness / role negotiation | `tc` tool-call action gives request/response with correlation ids — stage control (LoadStage/StageReady/Stop) fits it as-is |
| NAT traversal | Self-hosted coturn at legion.codecai.net:3478 (already deployed) |
| Model artifact distribution | The same-origin `/webllm/` model mirror — extend to serve layer-shard artifacts with SHA-256 manifests, mirroring the layer-package repo idea |

What Legion lacks is exactly one thing: **a runtime that executes a layer range.**

### 1.3 The runtime gap: options ranked

Research verdicts (full citations in §4):

1. **llama.cpp WebGPU via wllama (recommended path).** llama.cpp now has an actively developed upstream WebGPU backend, exposed in wllama ≥3.1 (PR #215). This is the *same ggml/GGUF stack Skippy patches*. mesh-llm's stage ABI patch queue (`third_party/llama.cpp` patches in the mirror) is therefore a direct reference implementation of the exact capability we need: tensor-filtered partial load + activation-in/activation-out forward. The work: port/apply that stage-ABI concept in a wasm+WebGPU llama.cpp build and expose `loadStage(fragments, layerStart, layerEnd, flags)` / `forward(activation, positions) → activation` / `sampleFinal(activation, samplingCfg) → tokenId` to JS. Bonus: **Skippy's GGUF layer-package format can be reused byte-for-byte**: same fragments, same manifests, same certification story. Measured WebGPU decode (LlamaWeb study, arXiv 2605.20706): ~100 tok/s for 1 to 3B on high-end discrete GPUs, 30 to 50 on mid integrated. Per *stage* that's plenty. Compute won't be the bottleneck, hops will.
2. **MLC/web-llm custom compile (fallback).** MLC's native pipeline parallelism is hard-wired to the TVM Disco multi-process runtime: a dead end for WebGPU. But MLC compiles models to named Relax entry points (`embed`/`prefill`/`decode`) callable from JS via tvmjs with raw NDArrays, and supports bring-your-own-architecture. A truncated model class (layers N..M, `forward(hidden) → hidden`) compiled through the normal single-device WebGPU path is plausible. Weight format is MLC-proprietary (no GGUF ingestion). Every model therefore needs a per-stage re-conversion pipeline, and cross-runtime numerics vs GGUF peers won't match. Use only if the wllama path stalls.
3. **ONNX Runtime Web (niche).** Exporting a layer-range subgraph with hidden-state I/O is standard torch.onnx machinery, and the WebGPU EP has real transformer kernels + KV buffer sharing. But there's no existing mid-model-slice tooling and it's a third weight ecosystem. Not worth opening unless 1 and 2 both fail.

**Key format decision:** standardize Legion stages on **GGUF layer packages** (Skippy's format). That keeps one conversion pipeline, inherits mesh-llm's per-family split certifications, and (later) makes a native mesh-llm node and a browser peer able to serve *the same shards*. Existing whole-model web-llm peers keep working unchanged; stage-hosting adds a new peer capability alongside the existing one.

### 1.4 Proposed protocol extension (sketch)

New Trystero action `sf` (stage frame) + `cap` additions, staying inside the existing versioning discipline (`MESH_PROTOCOL_VERSION` bump or, better, adopt mesh-llm's generation+subprotocol pattern, see §2.1):

```ts
// cap additions
interface MeshPeerCap {
  // ...existing...
  stageHost?: {
    vramBytes: number;          // feature-detected WebGPU limits, not assumed
    maxLayerBytes: number;      // maxStorageBufferBindingSize — the real per-buffer ceiling
    cachedSlices: string[];     // layer-package fragment hashes already in OPFS/Cache API
    families: string[];         // model families this runtime certifies for splits
  };
}

// sf payload — direct port of StageWireMessage, msgpack-framed like everything else
interface StageFrame {
  kind: 'prefill' | 'prefillFinal' | 'decode' | 'stop' | 'ready' | 'predictedToken';
  requestId: string; sessionId: string;
  posStart: number; tokenCount: number;
  dtype: 'f32' | 'f16' | 'q8';
  sampling?: SamplingConfig;    // present on frames headed to the final stage
  tokens?: Uint32Array;         // driver-origin sideband
  activation?: Uint8Array;      // token-major [tokens × n_embd], absent on driver-origin frames
}
```

Policies to copy verbatim from Skippy (all transport-agnostic):
- **f16 default wire dtype, q8 per-family opt-in.** 4 KiB/token/hop for an 8B model.
- **Downstream-first startup + explicit readiness before routability.**
- **Direct predicted-token return** from final stage to driver peer.
- **Abort-and-replan on peer loss, never mid-generation resume.** This is the single most important adoption: mesh-llm chose it for *datacenter* nodes; browser tabs churn 100× worse. Legion was therefore never going to do better than "fail the generation, replan, retry." Add Legion-specific mitigations: prefer stage-hosting peers with the audio-keepalive active (already built for engine-hosting tabs), require a "pinned tab" gesture in the UI, and cap generation length on wide splits.
- **Planner math** (weight-proportional by VRAM, minimize stages, TPOT scoring with *measured* per-link RTT; Trystero gives us per-peer RTT cheaply). Bias even harder toward few stages than mesh-llm does, since our hop cost is 10 to 50× theirs.

### 1.5 Feasibility numbers

| Quantity | Value |
|---|---|
| Activation/token/hop, 8B (hidden 4096) | 8 KiB f32 / **4 KiB f16** |
| Activation/token/hop, ~30B (hidden 5120–7168) | ~10–14 KiB f16 |
| Prefill frame (chunked, 256 tok, f32) | ≤ 2 MiB per chunk per hop |
| WebRTC RTT: same LAN | 1–5 ms |
| WebRTC RTT: public internet | ~60–100 ms typical |
| Per-token network overhead, 3-stage LAN split | ~4–10 ms → negligible |
| Per-token network overhead, 4-stage internet split | 180–300 ms → ~3–5 tok/s ceiling before compute |
| WebGPU decode, 1–3B slice, discrete GPU | ~100 tok/s (LlamaWeb measurements) |
| WebGPU per-buffer floor / typical desktop | 128 MiB spec minimum / ~2–4 GB on discrete GPUs — **feature-detect, never assume**; this bounds layers-per-tab on mobile |

Bottom line: a 2-to-3-stage LAN split of a model class that no single browser could host (e.g. 13B to 30B q4 across two or three desktops with discrete GPUs) is the sweet spot where this is both novel and *usable*.

### 1.6 Build ladder (when we pick this up)

1. **PoC 0: runtime shim only, no mesh.** Two workers in one page: wllama/llama.cpp-WebGPU built with stage-ABI patches; worker A runs layers 0..N/2 of a small GGUF, worker B the rest; hidden state passed via postMessage. Success = identical logits to the unsplit model. This de-risks the entire concept and touches zero Legion code.
2. **PoC 1: two browsers, Trystero transport.** Same split, `sf` action over the data channel, f16 wire dtype, direct-return. Measure real tok/s LAN vs TURN-relayed.
3. **PoC 2: mesh integration.** `stageHost` caps, planner, downstream-first startup, abort-and-replan, layer-shard serving from the `/webllm/` mirror with SHA-256 manifests.
4. **Then** the secondary patterns below make the mesh around it robust.

Effort honesty: PoC 0 is the hard one (wasm build of a patched llama.cpp + WebGPU backend + a JS stage API), on the order of weeks. It's the gate for everything else. PoC 1 and PoC 2 are mostly Legion-native TypeScript on existing rails.

---

## 2. Secondary patterns worth merging into Legion (independent of splits)

Ranked by payoff/effort. All are pure logic, verified portable (no platform deps), with exact reference implementations in the mirror.

| # | Pattern | Source | What Legion does today | Adopt |
|---|---|---|---|---|
| 1 | **Local-only node reputation**: per-target `{failures, cool_until}` + residual penalty (cap 16), exponential cooldown 30s→300s, success clears cooldown, 2 successes per penalty point, 20min TTL; cooling targets filtered unless that empties the candidate list; never gossiped | `network/target_health.rs`, `docs/NODE_REP.md` | `pickBestPeer` = freshest `lastSeen` only | **Yes — first.** Direct TS port into `routing.ts`; biggest routing-quality win per line of code |
| 2 | **`last_seen` vs `last_mentioned` split**: direct proof-of-life vs transitive hearsay as separate timestamps; only directly-verified peers are rebroadcast; `PeerDown` honored only absent fresh direct proof | `mesh/gossip.rs`, `PeerInfo` | single `lastSeen` conflates both | **Yes.** Solves rumor-amplification before Legion ever federates rooms |
| 3 | **Prefix-affinity sticky routing**: hash the request scaffold (system prompt + tools, order-independent) → LRU-cache `{model,prefixHash} → peer` (20min/4096) so multi-turn agent threads hit the same peer's **warm KV cache**; session-hint stickiness above it, round-robin below | `network/affinity.rs` | fan-out or freshest-peer per ask | **Yes.** Turns the mesh cache-coherent with no coordinator; also exactly what makes stage-split sessions stable |
| 4 | **Generation + subprotocol versioning**: one monotonic `gen` int validated on *every* frame (hard breaks) + named subprotocols with `{name, major, features[]}` in the cap (soft additive features) | `protocol/mod.rs` | single `MESH_PROTOCOL_VERSION` const | **Yes, cheap.** Adopt before the `sf` action ships so splits land as a subprotocol, not a version bump |
| 5 | **Deterministic fan-out arbitration**: code-not-model arbitration — negation-aware token-subset clustering, majority cluster ≥2 with confidence ≥0.5, strong-tier gate (small-model consensus held until the big model lands or patience expires), grace timers, sole-survivor rule | `crates/mesh-mixture-of-agents/{fanout,arbiter}.rs` | `fanOut.ts` + simple `aggregators.ts` | **Yes.** Drop-in upgrade spec for `aggregators.ts`; their `"mesh"` model ≈ Legion's fan-out ask formalized |
| 6 | **Heartbeat: 60s to a random subset + immediate out-of-band urgent events** (peer-down pushed now, not on the tick) | `mesh/heartbeat.rs` | 30s cap broadcast to all | **Yes when rooms grow.** O(N²) chatter bound; trivial change |
| 7 | **Nostr rendezvous with replaceable events**: kind-31990 listing, `expiration` tag = 2× publish interval (self-expiring), non-publisher watchdog takes over publishing if the listing vanishes, mesh scoring/stickiness | `network/nostr.rs`, `docs/MESHES.md` | Trystero already supports a Nostr signaling strategy; rooms are static names | **Yes for public rooms.** Gives Legion *discoverable* rooms ("find a legion mesh serving model X") instead of hardcoded room ids; nostr-tools over WSS, browser-native |
| 8 | **Signed bootstrap tokens**: base64url envelope, ed25519-signed `{addrs, mesh_id = hash(policy), policy, expires_at (24h)}`; mesh requirements immutable (change policy ⇒ new mesh id) | `mesh/mod.rs` | open rooms, no admission | **Later.** Needed the day Legion has private meshes worth gating; WebCrypto/noble covers it. Note: WebRTC lacks intrinsic peer crypto-identity, so this brings its own keypair layer |
| 9 | **Blackboard (mesh-scoped agent coordination MCP tools)** | external repo `github.com/Mesh-LLM/blackboard` (implementation NOT in the mirror — only the contract docs are) | `mcp.ts` bridges external MCP servers | **Maybe.** Legion-native `blackboard.*` tools over a namespaced action would give mesh agents shared state; clone the external repo first if pursued |

**Skip / not applicable:** mDNS + raw-UDP LAN beacon (no browser sockets; Trystero signaling covers the role) · control-plane as a second ALPN (Legion has no owner/admin RPC yet; the *lane separation idea* is subsumed by #4's subprotocols) · coordinator term-fencing in full (needed for datacenter split-brain; a Trystero room's driver-peer-owns-the-run convention + replan-on-driver-loss is enough at Legion's scale) · Skippy's recurrent-family sidebands and q8 certifications (inherit them later via the GGUF package format).

---

## 3. Footnote: runtime interop with mesh-llm itself

Not the goal (per project direction), recorded for completeness: a mesh-llm node exposes plain OpenAI JSON-SSE `/v1`. `legion-server-bridge` deliberately does not support that (Codec-msgpack backends only). If ever wanted, the cheap unlock is an SSE→retokenize→Codec-frame adapter in the bridge (breaks the no-detokenize purity once, at the bridge). The far more interesting convergence is the one §1.3 sets up implicitly: if Legion adopts GGUF layer packages and the stage frame contract, a **native mesh-llm/Skippy stage and a browser stage could eventually serve slices of the same model in one pipeline**. The bridge would then speak `sf` frames. Park it until PoC 2 exists.

## 4. Sources

- Mirror: Forgejo `legion-ref/mesh-llm` (pull-mirror of github.com/Mesh-LLM/mesh-llm), working clone `H:\dev\mesh-llm`. Key paths cited in §1.1 and §2 tables.
- Legion ground truth: `packages/mesh-core/src/{types,peer,routing,fanOut,mcp}.ts`; bridge contract `legion-server-bridge/src/bridge.ts`.
- MLC Disco dead-end: `mlc-llm/python/mlc_llm/compiler_pass/pipeline_parallel_rewrite.py` (emits `runtime.disco.*`: a multi-process runtime, no WebGPU impl).
- llama.cpp WebGPU in browser: wllama PR #215 (v3.1+), upstream ggml WebGPU backend.
- WebGPU LLM perf: "Llamas on the Web" (arXiv 2605.20706): llama.cpp-WebGPU across 16 devices; prefill ≈ 49% of WebLLM's, safety-check overhead up to 42%.
- Prior art: Petals (bigscience-workshop/petals, ~6 tok/s Llama-2-70B public swarm): server-side only; peerd.ai (no layer splits, confirmed); "AI Grid" (unverifiable, likely whole-model); mesh-llm ROADMAP.md: zero browser plans.
- WebRTC RTT: webrtcforthecurious.com; webrtchacks latency measurements. WebGPU limits: W3C spec `maxStorageBufferBindingSize` 128 MiB floor; MDN GPUSupportedLimits.
