# colibri + mesh-llm → Legion: state mobility and expert placement

Companion to [mesh-llm-assessment.md](mesh-llm-assessment.md). That document
digested Skippy's splitting. This one covers a correction to what we believed
about recurrent families, a review of colibrì's current codebase, and a build
ladder that folds both into Legion alongside our own expert slicer.

Reviewed 2026-09-01 against mesh-llm `main`, colibrì `main`, and
`H:/dev/expert-slicer-proto`.

## The correction

We have been repeating that hybrid attention plus state-space models "do not
slice for a mesh" because their state swamps the wire. The first half is
false. The second half is false. A real constraint sits underneath both. It
is sharper than the claim it replaces.

Every recurrent and hybrid family in mesh-llm is certified **Supported** and
ships with concrete stage splits.

| Family | Layers | Splits | Cache payload |
|---|---|---|---|
| Jamba | 28 | 9, 18 | `KvRecurrent` |
| Mamba2 | 64 | 21, 42 | `KvRecurrent` |
| Qwen3Next | 48 | 16, 32 | `KvRecurrent` |
| Granite-Hybrid | 32 | 10, 21 | `KvRecurrent` |
| Falcon-H1 | 24 | 8, 16 | `KvRecurrent` |
| RWKV6 | 24 | 8, 16 | `KvRecurrent` |

In `crates/skippy-topology/src/family_capability.rs` the `recurrent_or_hybrid`
flag does not gate splitting. `family_policy.rs:282` routes those families to
`kv_recurrent_policy()`. That **enables** prefix caching at `max_entries: 16`
against 512 for dense. A disable path exists and catches exactly one thing,
non-causal diffusion, with the reason string "non-causal diffusion family has
no resident KV state to cache".

The wire is not swamped either. Falcon-H1's note reads "Recurrent state is too
large to move. Keep recurrent range `0..24` sticky and **transfer activation
frames only**." Per-token traffic stays the hidden state. RWKV7 is the single
exception and needs a layer-0 `v_first` sideband at 2x hidden width.

The number we were quoting is real and was attached to the wrong thing. The
mobility table gives Falcon-H1 at 663.5x and RWKV6 at 112.5x the Qwen
recurrent state. That measures the **resident state a stage holds**. It is
the analogue of a KV cache. Phi2, an ordinary dense transformer, carries the
same verdict in that table: "Full-state rejected as too large."

## The constraint that actually binds

mesh-llm solves state mobility by refusing to move state. Ownership is sticky
and its peers are servers. Stickiness costs nothing there.

Legion's premise is the opposite. Peers arrive and leave. The mesh
re-plans around the gap. A stage whose state cannot be handed off cannot be
re-planned.

Legion already detects and recovers from churn. It does so correctly.
`onPeerLeave` feeds the roster, `stageOrchestrator.ts` aborts on host death,
graceful leave or stall, and the driver recovers with a continue-from-history
replan against a fresh session. `hostStabilityScore` in `stagePlanner.ts`
biases planning toward pinned, keepalive, visible, non-battery peers, which
lowers how often that path runs. A conversation survives a peer dropping
today. This was built from operating the thing, not from theory.

The gap is cost, not correctness. Continue-from-history rebuilds the lost
stage's KV cache by re-prefilling the whole conversation. Every churn event
pays a full prefill and the bill grows with the context. State mobility
turns that into a bounded byte transfer plus a short replay, for the cases
where the transfer is the cheaper of the two.

Recurrent families sit on the same mechanism at 100x to 660x the state size,
which is what makes them look like a special case. They are not. Dense
transformers get the same win first, and the numbers there decide whether the
recurrent version is ever worth the bytes.

## What each codebase offers

### mesh-llm

- **Family capability table.** `STAGE_RUNTIME_LLAMA_FAMILY_EXPECTATIONS` keys
  off the llama.cpp architecture string. A new release reusing an existing
  architecture classifies correctly without a new literal. Certification runs
  off architecture identity.
- **Two cache payload classes.** `ResidentKv` and `KvRecurrent`, with the
  entry budget as the tuning surface.
- **An explicit disable path** carrying a human-readable reason.
- **Activation transport at f32, f16, and q8.** Legion already got here
  first and I misread it. On `main`, `wireDtype` is
  `'f32' | 'f16' | 'i8'`, `activationWireCodec.ts` dispatches between the
  upstream f32/f16 codec and Legion's own int8 one in
  `activationWireI8.ts`, and `chatModelSource.ts:309` defaults to `'i8'`
  because "production default is the quantized wire route". There is a
  `docs/WIRE-DTYPE.md` and a `wire-dtype.spec.ts` e2e A/B. The int8 codec
  is purpose-built with a per-token-row abs-max scale and a delta pre-pass
  for decode-step frames, precisely because the upstream pipeline's int8 is
  a naive round-and-clamp with no scale factor. Nothing to adopt here.
- **Per-family wire budget.** RWKV7's 2x sideband is precedent for carrying an
  activation width multiplier in family metadata.

### colibrì

The July assessment predates most of this. Colibrì has since shipped an ABI
that does the thing we said we would have to build.

- **`c/segment_runtime.h`.** An engine-neutral C ABI for executing a
  contiguous half-open layer range, `begin <= layer < end`. It carries
  `state_schema` and `numeric_class` as a compatibility identity.
  `COLI_SEGMENT_CAP_RANGE_NATIVE` is a strong promise that the adapter loaded
  no weights outside the range. Callers must not publish range-native
  residency without that bit.
- **Streaming snapshot and restore.** "Snapshot callbacks stream bytes so
  neither side needs a second full-state allocation." Restore is gated on
  model identity, `state_schema`, numeric class, and segment range matching.
  The doc explicitly directs callers that need interruption to "terminate or
  migrate the worker and retry from the last published snapshot." That is a
  churn protocol.
- **Seven family adapters**, including recurrent state. Qwen3.6 carries
  "attention KV, DeltaNet recurrent and conv state". Qwen3.8-Flash-Next
  carries "QSA KV/indexer, GDN recurrent/conv and PLE hash history".
- **`c/edge_runtime.h`** supplies the model-owned tokenizer, embedding, and
  final head. Those are Legion's stage 0 and final stage.
- **`CACHE_ROUTE`.** Cache-aware max-rank routing after arXiv:2412.00099.
  Keep the true top-`J` always, then fill remaining slots from experts already
  resident that still rank inside top-`M`. Defaults are `ROUTE_J=2`,
  `ROUTE_M=12`. `ROUTE_ALPHA` scales the gate mass of substituted experts
  before renormalization. Telemetry reports `swap_pct`, `route_agree` as
  overlap with the true top-K, and `route_kl` as mass divergence.
- **`PILOT`.** Router-lookahead prefetch of the next layer's weights. It does
  not change expert IDs. It composes with `CACHE_ROUTE` and can be A/B'd
  against it.
- **`.coli_usage`.** A persistent, append-friendly expert usage history with a
  backward-compatible header trick, feeding `PIN=auto` learned pinning.
  `--repin N` re-places hot experts every N emitted tokens.
- **`coli plan` and `coli tune`.** Placement reports the hot, warm, and cold
  tier, the reason for each placement, and the expected bottleneck, plus a
  machine-readable `next_actions` list. A missing measurement is marked
  `required`. The tool refuses to silently enable an unmeasured optimization.
- **`int4-rans256-g0`.** Lossless rANS entropy coding of packed int4 expert
  weights at roughly 0.76 of original size, byte-exact, laid out as 256
  interleaved streams so SIMD lanes and GPU threadgroups decode coalesced.

### expert-slicer-proto (ours)

- Expert-axis slicing is lossless with no dequantization. GGUF exposes
  experts as the outermost axis and quant super-blocks never span an expert.
  Arbitrary non-contiguous subsets work.
- The router tensor is kept whole. A peer scores all experts and then masks
  to its subset.
- The gather-sum contract is proven at K=4 shards, with partial sums matching
  the monolith to 4.9e-4 in bf16 noise. Dropping a shard degrades gracefully.
- **Which** experts are hosted dominates **how many**. At 50% hosted, random
  subsets span perplexity 3.3 to 346. Usable envelope is roughly 75%.
- Forcing top-k weights to sum to 1 on a `norm_topk_prob=False` model destroys
  quality even at 56 of 64 experts. Match the model's own normalization.
- Placement policy was left as the open problem. `CACHE_ROUTE` is a candidate
  answer we did not have in July.

## Build ladder

Each rung is independently shippable and gated on the one before it.

### P1. Session snapshot envelope, dense only

Define a snapshot envelope in `packages/mesh-core` carrying model identity,
state schema, numeric class, and layer range, following colibrì's restore
gate. Hang it off the existing abort path in `stageOrchestrator.ts` so a
departing peer can stream its session state to its replacement, with the
continue-from-history replan staying as the fallback whenever the transfer is
not worth it.

Gate: a three-stage Qwen3-8B conversation survives killing the middle peer
with output matching the uninterrupted run, which it already does, AND
measurably fewer prefill tokens than the replan path spends on the same kill.
The second half is the whole point; the first half is a regression check.

### P2. Family capability table

Port the shape of `STAGE_RUNTIME_LLAMA_FAMILY_EXPECTATIONS` into
`mesh-core`, keyed off the architecture string in the layer package. Each
family carries a cache class, an activation width multiplier (RWKV7 is 2x),
and an optional disable reason. Legion refuses to plan a
pipeline for an uncertified family, and it raises that refusal at plan time.

The wire-dtype work is done and shipped, so this rung is only the family
table. One piece of housekeeping belongs with it. A stash on
`feat/optional-stage0-and-tool-nodes`, labelled "wire-agent int8 WIP (killed
mid-typecheck)", predates what landed on `main` and looks superseded by it.
Confirm that and drop it, so the next person reading the stash list does not
re-derive a solved problem.

Gate: planning a diffusion or uncertified family returns a reasoned refusal.

### P3. Expert-subset fragments in the manifest

`layerFragmentId(layerIndex)` in `stagePlanner.ts` expresses whole layers
only. Extend the manifest to address an expert subset within a layer. Port
the slicer from Python into the packaging path.

Gate: a Qwen3-235B layer packages into expert-subset fragments that re-read
byte-identical and reassemble to the original.

### P4. Resident-preferring router

Implement `CACHE_ROUTE` in `legion-stage-runtime` as the partial-hosting
fallback, replacing the "drop" behaviour R2 settled on. Keep true top-J,
substitute only within top-M from resident experts, and honour the model's own
`norm_topk_prob`. Forcing a sum to 1 is the bug R1 isolated.

Ship the telemetry with it. `route_agree` and `route_kl` give a per-token
quality signal that R2 lacked. That turns placement policy from an offline
perplexity study into something measurable in a live mesh.

Gate: at 75% hosting on Qwen3-235B, `route_agree` and generation quality both
beat the drop fallback on the same prompts. Re-measure here. 235B is 128
experts at top-8 and likely `norm_topk_prob=True`. Both the ratio and the
normalization differ from OLMoE.

### P5. rANS tier on the wire

Adopt `int4-rans256-g0` for expert fragments. Roughly 24% fewer bytes to store
and stream, byte-exact, with a layout already designed for threadgroup decode.
A WebGPU compute-shader decoder is the browser-side work.

It also bears on our published claim that compression is not the lever. That
claim was measured on trained dictionaries. A static rANS
table per shard is a different technique and it pays.

Gate: WebGPU decode throughput exceeds the network fetch rate it replaces.
The codec never becomes the bottleneck.

### P6. colibrì as a native heavy peer

Track 2 from the July assessment, now with a shipped ABI underneath it. Wrap
`coli_segment_run` behind Legion's stage protocol using `edge_runtime.h` for
the terminal stages. Native peers escape the WebGPU buffer ceiling that keeps
browsers out of GLM-5.2 class models.

Note the adapter build advertises CPU only today. That is deliberate
capability truthfulness on colibrì's part. It caps throughput until the
GPU flags land per engine.

Gate: one native colibrì peer serves a layer range to a browser-hosted
pipeline and the conversation completes.

## What this corrects outside the code

`docs/mesh-llm-assessment.md` was right. It already said "sticky recurrent-state
owners" and deferred the recurrent sidebands for later inheritance.

The published article overstated it into a dead end. The paragraph beginning
"There is one genuine dead end" in
`themildtake/src/content/articles/2026-07-17-unstable-legion-p2p-chatgpt.mdx`
needs rewriting against the numbers above. The honest version is a better
story. The limitation is mobility under churn. Churn is Legion's own defining
condition.

## Sources

- [mesh-llm](https://github.com/Mesh-LLM/mesh-llm): `docs/skippy/FAMILY_STATUS.md`,
  `crates/skippy-topology/src/family_capability.rs`,
  `crates/mesh-llm-host-runtime/src/inference/skippy/family_policy.rs`,
  `crates/skippy-server/src/kv_integration/config.rs`
- [colibrì](https://github.com/JustVugg/colibri): `docs/segment-runtime.md`,
  `docs/CACHE_ROUTE.md`, `docs/routing-telemetry.md`, `docs/tuning.md`,
  `docs/int4-rans256-g0.md`, `c/segment_runtime.h`, `c/edge_runtime.h`
- expert-slicer-proto: `README.md`, `expert-slicer.py`, `r2-firm-and-scaffold.py`
- Cache-aware routing: arXiv:2412.00099
