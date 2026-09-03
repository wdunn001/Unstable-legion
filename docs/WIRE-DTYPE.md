# Wire dtype: shrinking the per-token activation frame

Goal: shrink the per-token hidden-state activation frame that crosses the
wire between pipeline-split stages (`sf` Trystero action), without ever
relaxing the native wasm stage's hard requirement that its prefill/decode
input be f32.

Baseline: nEmbd=4096 (Qwen3-8B) f32 activations = 16,384 B/token/hop raw
(`sendStageFrame` observed live at ~16,485 B/decode-step once msgpack +
envelope overhead is included; a full prompt prefill is one much larger
frame: `tokenCount * nEmbd * 4` bytes).

## Mechanism

The wire codec was **already fully generic** across `wireDtype` before this
work. The gap was entirely in wiring; the codec logic already worked:

- `packages/mesh-core/src/stageOrchestrator.ts` builds an
  `ActivationWireEncoder` via `@unstable-legion/stage-runtime`'s
  `createActivationWireEncoder({ ..., dtype: opts.wireDtype })`. That in
  turn constructs `@codecai/web`'s `ActivationStreamEncoder` with
  `dtype: 'fp32' | 'fp16'`: the codec already converts f32 → f16 on
  `encodeFrame` (see `node_modules/@codecai/web/src/latent-frame.ts`'s
  `f32ToF16`/`float32ArrayToTypedBytes`).
- The receiving side (`packages/mesh-react/src/useStageHost.ts`'s
  `onStageFrame` handler) builds an `ActivationWireDecoder` from the header
  bytes (`createActivationWireDecoder`) and calls
  `decoder.decodeFrameBytes(bytes)`. **`decodeFrameBytes` always
  reconstructs a `Float32Array`, regardless of what crossed the wire**:
  f16 bytes are widened back to f32 (`f16ToF32`) inside the codec itself,
  before mesh-core ever sees them. `useStageHost.ts` then explicitly
  builds `WireActivationFrame` with `dtype: 'f32'` and hands it straight
  to `StageWorkerClient.prefill`/`decode`. The native stage's hard f32
  input requirement was already satisfied for every wire dtype.
- No activation ever flows host → driver: the only reverse-direction
  traffic is the predicted token id, riding the `stage.token` **control**
  message (`tc` action). Per
  `stageOrchestrator.ts`'s own SCOPE NOTE, only the 2-total-stage topology
  (local driver stage-0 + one remote final stage) is wired end to end in
  this repo today. There is no host-to-host relay loop. There is no
  "middle-stage" activation-forwarding direction to convert either.
- `sessionId`-enveloping (`stageFrameEnvelope.ts`) wraps the header and
  every frame identically regardless of dtype: opaque bytes in, opaque
  bytes out, confirmed by `packages/mesh-core/test/activationWireDtype.test.ts`.

**What was actually missing**: `apps/chat/src/App.tsx` hardcoded
`wireDtype: 'f32'` in both `useCommunalHost` and `useCommunalChat` calls,
overriding the planner's own `'f16'` default
(`stagePlanner.ts`/`communalTopology.ts`/`stagePipelinePlanning.ts` all
default `wireDtype` to `'f16'` when the caller omits it). Fixed by:

- `apps/chat/src/chatModelSource.ts`: `resolveChatModelConfig()` now reads
  `?wireDtype=f16` from `location.search` (same query-param idiom as
  `?testModel=1`/`?badShard=1`), defaulting to `'f32'` for anything
  unset/unrecognized. Exposed on `ChatModelConfig.wireDtype`.
- `apps/chat/src/App.tsx`: both hook calls now pass
  `modelConfig.wireDtype`, replacing the hardcoded literal.
- `App.tsx`'s `__legionChat` debug snapshot now also exposes
  `chatTokens` (`chat.tokens`, the raw generated token-id sequence). The
  exactness e2e needs the exact greedy-decode token stream, beyond its
  detokenized text.

## Tests added

- `packages/mesh-core/test/activationWireDtype.test.ts` (new): f16
  header + frame round-trip through `stageFrameEnvelope`'s sessionId
  wrapping, both single-token decode frames and multi-token prefill
  chunks; asserts the decoded side is always a `Float32Array` of
  `tokenCount * nEmbd * 4` bytes; asserts f16 wire bytes are <55% of the
  f32 equivalent; asserts the round-trip tolerance matches
  legion-stage-runtime's own `frames.test.ts` bound (~2⁻¹⁰ relative error).
- `packages/mesh-core/test/stageOrchestrator.test.ts` (extended): the
  mock host gained an opt-in `decodeWire: true` mode. By default the mock
  host ignores inbound `sf` bytes. With this mode enabled, it does what a
  real `useStageHost.ts` does with them: unwrap the envelope, build a real
  `ActivationWireDecoder`, and call `decodeFrameBytes` on every frame. Two
  new tests: an f16 route delivers f32 buffers of the
  correct byte length at every step of a real `runDriverStageSession`
  session (not just at the codec unit level), and an f16-vs-f32 A/B at the
  orchestrator level confirming the wire-byte reduction while the decoded
  byte length stays identical.
- `apps/chat/e2e/wire-dtype.spec.ts` (new, `chromium-webgpu` project): a
  **solo self-hosting tab** (`?testModel=1&wireDtype=<f32|f16>`, this same
  tab both drives and hosts every remaining layer: the small
  qwen3-0.6b-q8_0 test model's ~26 communal layers fit comfortably in one
  tab's WebGPU weight budget) runs 5 prompts of varying length/shape twice
  (f32 control, f16 test), capturing the raw generated token-id sequence
  (`chatTokens`) via the debug surface and diffing. The suite asserts
  completion (every run produces a non-empty token stream). It does NOT
  hard-fail on divergence; per-prompt exactness is a report only.

## Measured results (this machine, real WebGPU, qwen3-0.6b-q8_0 test model, nEmbd=1024)

Wire bytes per decode-step frame (post sessionId-envelope, msgpack framing
included): orchestrator-level unit test and the live e2e both agree:

| dtype | decode-step frame bytes | vs f32 |
|-------|--------------------------|--------|
| f32   | ~4,195 B                 | —      |
| f16   | ~2,147 B                 | 48.8% smaller |

Extrapolated to production (Qwen3-8B, nEmbd=4096, confirmed directly by
`activationWireDtype.test.ts`'s `ramp(1)` at nEmbd=4096):

| dtype | decode-step frame bytes | vs f32 |
|-------|--------------------------|--------|
| f32   | 16,441–16,483 B           | —      |
| f16   | 8,249–8,291 B              | ~49.7% smaller |

(The task brief's live observation of "~16,485 B/decode-step" for f32
matches this within a few bytes of msgpack-encoding variance.)

### Token-exactness A/B (5 prompts, solo self-host, greedy decode)

| # | prompt (truncated) | f32 tokens | f16 tokens | result |
|---|---|---|---|---|
| 0 | "hello" | 9 | 9 | **TOKEN-EXACT** |
| 1 | "what is 2+2?" | 8 | 8 | **TOKEN-EXACT** |
| 2 | "…describe what makes a good cup of coffee…" (~50 words) | 47 | 49 | DIVERGED at index 35 |
| 3 | "Write a JavaScript function that returns the nth Fibonacci number…" | 36 | 36 | **TOKEN-EXACT** |
| 4 | "We are planning a small team offsite…" (multi-part, longest) | 162 | 167 | DIVERGED at index 16 |

3/5 short-to-medium prompts were bit-for-bit token-exact; the two longest
generations (47+ and 162+ tokens) diverged partway through. This is expected for
a lossy 10-bit-mantissa wire format feeding a greedy (argmax) sampler:
enough accumulated rounding error across ~15-35 decode steps eventually
flips one token's argmax decision, and every token after that point
diverges (the KV-cache/generation state on each side has diverged
outright, well beyond numerical closeness).

## Recommendation

**f16 is safe to enable as an opt-in / bandwidth-constrained-peer mode,
NOT yet safe as the default.** It halves the dominant per-decode-step wire
cost with zero risk of protocol/shape errors (the native stage always
receives correctly-shaped f32 input, proven by both the unit and e2e
tests). Greedy decode is nonetheless a knife-edge sampler, and this run directly
observed real generations diverging after a few dozen tokens. For a
product where "the model's continuation" is user-visible content, a
silent output change traveling with a bandwidth optimization is a real
UX/trust cost. Suggested rollout: ship
`?wireDtype=f16` as an operator/power-user opt-in (already wired), gather
real-mesh bandwidth-pressure signal, and reconsider the default once
there's a story for either (a) accepting divergence as a documented
tradeoff communicated in-product, or (b) a tighter dtype (see Phase 2)
that measurement shows preserves exactness better in practice.

---

# Phase 2: int8 activation wire (experimental)

See the section below once Phase 2 lands. This file only receives appended
sections. Phase 1's mechanism/results stay intact as a reference for
the f16 numbers above.
