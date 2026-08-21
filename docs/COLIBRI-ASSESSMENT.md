# colibrì × Legion — Viability Assessment & Integration Plan (v2)

*2026-07-17 · assessed against `H:/dev/colibri` @ main, the Legion stack (`unstable-legion` wt-thin, `legion-stage-runtime`, `legion-server-bridge`), `mesh-llm` (skippy-model-package), and `codec-maps`. v2 supersedes v1 after deep research into GPU residency, GLM-5.2 GGUF/llama.cpp support, and Skippy's MoE slicing.*

## Build log — Stage 0 (2026-07-17, on .88)

**Serve plumbing PROVEN. Real GLM-5.2 weights are the open long-pole.**

- **Env:** .88 (vinez@192.168.1.88) = 32-thread EPYC 8124P with **AVX-512F + AVX512-VNNI** (colibrì's high-throughput int4 tier, better than the AVX2 assumed), 2×RTX 3090 (48 GB VRAM idle), 125 GB RAM (**~22 GB free — box busy**), `/mnt/ssd2` SATA 624 GB free (model target), `/mnt/local24` 18 TB (source/build/venv). Avoid `/mnt/data` (88% full, IO-saturated).
- **Repo:** cloned to `/mnt/local24/colibri`, pinned `72d3d37`. Built CPU engine + OLMoE: `make -C c glm && make -C c olmoe` — clean with `-march=native` (AVX-512/VNNI active).
- **Python:** system has no torch; built `/mnt/local24/colibri-venv` (CPU torch 2.13.0 + transformers w/ `GlmMoeDsaConfig` + safetensors + hf_hub). `HF_HOME=/mnt/local24/hf-cache` (default `~/.cache` not writable).
- **Tiny oracle (no big download):** `make_glm_bench_model.py --fp8 --output /mnt/ssd2/glm_tiny_fp8` (0.31B, real GLM-5.2 arch, FP8 layout) → `convert_fp8_to_int4.py --indir … --outdir /mnt/ssd2/glm_tiny_i4`. Fetched the **real** GLM-5.2 `tokenizer.json` (20 MB) from `zai-org/GLM-5.2-FP8` into the model dir (gateway requires it). `coli info` → engine ready ✓.
- **Serve contract (validated):** `python3 c/coli serve --model … --host 127.0.0.1 --port 8099 --ram 4 --max-queue 2 --model-id glm-tiny` → `OpenAI-compatible API listening on http://127.0.0.1:8099/v1`. `/v1/models` OK. `/v1/chat/completions` with `stream:true` emits standard SSE `chat.completion.chunk` frames with **`delta.content`** (answer) and **`delta.reasoning_content`** (GLM thinking, separate) — the bridge must consume both. (Random-weight fixture 500s mid-gen; expected, not a plumbing fault.)
- **Ops gotchas (reusable):** `pkill -f 'coli serve'` over ssh **self-matches its own ssh shell's argv** and returns 255, silently killing the launch — never pkill a pattern that appears in the kill command's own command line. Run a persistent remote dev process as a **foreground** process inside a backgrounded ssh session (harness keeps the channel alive); plain `nohup … &`/`setsid` over ssh gets SIGHUP'd on channel teardown here.
- **OPEN — real GLM-5.2 weights:** colibrì uses its **own int4-safetensors** format (NOT the unsloth GGUF quants — those are for llama.cpp). `download_glm52.py` targets `zai-org/GLM-5.2-FP8` (**~756 GB**, engine requantizes on the fly) — this **does not fit** .88's 624 GB SSD, and RAM is tight (~22 GB free vs ~25 GB resident want). Decision pending on how to source real weights (see plan). Bridge (Stage 1) is buildable against the tiny oracle meanwhile.

## Build log — Runtime R2: CORRECTED findings + gather-sum PROVEN (2026-07-18, GPU)

**R2 revises R1's optimism DOWN and complicates the "hot placement" story. Gather-sum runtime contract PROVEN.** Ran on 2×RTX 3090 (user freed them; installed torch 2.6.0+cu124 in the venv). OLMoE bf16, hot calibrated on DIFFERENT text than eval, + a variance sweep (6 random subsets/count) + generation cliff + gather-sum scaffold.

- **GATHER-SUM CONTRACT PROVEN (the runtime core):** partition a layer's 64 experts into K=4 shards (simulated peers), sum the shards' partial outputs → **== monolith** (max_abs_err 4.9e-4 = bf16 noise). Drop a shard (peer down) → graceful change (mean rel delta 0.14), no renorm. So "partition experts across peers, sum partials = full model; missing peer = drop" is numerically confirmed.
- **WHICH experts dropped >> HOW MANY (huge variance).** At 50% hosted, 6 random subsets span ppl 3.3→346 (median 27); at 44%, 2.7→3525. Some sparse placements are near-perfect, others collapse — selection dominates count.
- **"Hot = keep most-used experts" is NOT a reliable policy — important negative result.** With honest (different-text) calibration, hot is inconsistent and sometimes WORSE than a lucky random subset: hot collapsed at 44% (ppl 253) while a random 44% subset generated coherently ("The sky is blue because the light from the sun…"). Two hot runs with slightly different calibration text disagreed 14 vs 599 at 38% — the hot set is fragile. Frequency ≠ criticality, and over-concentrating on hot experts appears to cause routing degeneration. **A real placement policy needs a smarter criterion than raw usage frequency.**
- **Usable envelope ~75% hosting (corrected with a PROPER chatbot prompt).** IMPORTANT: the earlier "looping cliff at 62%" was a PROMPTING ARTIFACT — raw string + greedy decode makes a 1B-active instruct model loop *even fully loaded*. Re-run with the model's chat template + `repetition_penalty=1.3`/`no_repeat_ngram=3` (real chatbot config): **looping GONE, model stays fluent throughout; the true degradation is FACTUAL/SEMANTIC DRIFT, not fluency collapse.** Across 3 prompts: 75% (48/64) reliably correct; 62% (40) fluent but facts slip (scattering→"refraction"); 50% (32) prompt-dependent — fine on soft prompts (programming advice coherent), confident nonsense on knowledge-heavy ones (mutex→"Multiplying Underneath the Topic"). So partial hosting = **churn resilience (drop ~10–25% safely)**; aggressive ~50% hosting yields quietly-wrong answers, not crashes. (Prompt-format lesson: for the Qwen MoE re-measure, reuse Legion's proven `apps/chat/src/chatPrompt.ts` ChatML + empty-`<think>` / `enable_thinking=False` — removes this confound.)
- **Caveats:** eval text was repeated (low baseline ppl ~2.1–2.3, somewhat degenerate metric — use a real corpus sample next); still OLMoE (64-exp/16-layer, `norm_topk_prob=False`). **Qwen3-235B (128-exp/94-layer, likely `norm_topk_prob=True`) MUST be re-measured — the norm flip could invalidate the "drop" fallback, and 94 layers may compound error / shrink the envelope further.**

Net: the distributed compute contract works; the **placement policy is the real open problem** (good sparse placements exist but "hot" doesn't find them), and the usable drop-fraction is modest. Runtime build should target churn-resilience (small drops), not aggressive partial hosting, until a better placement criterion + Qwen3 re-measurement land.

## Build log — Runtime R1: expert-drop quality GATE PASSED (2026-07-18)

**Go/no-go for partial-expert hosting: GREEN. MoE quality degrades GRACEFULLY when experts are dropped, IF you host the hot experts.** Measured on OLMoE-1B-7B bf16 (64 experts, top-8, `norm_topk_prob=False`) via `.88:/mnt/local24/r1-expert-quality.py` — patches `OlmoeSparseMoeBlock` to mask an expert subset, perplexity on a fixed 512-tok passage. Baseline ppl **3.44**.

HOT placement (keep most-used experts): 56→3.47, 48→**3.78**, 40→4.2, 32(50%)→**5.16**, 24→9.3, 16→collapse. RANDOM placement collapses far earlier (32→679 vs hot 5.16). So **~50% of experts hosted ≈ 1.5× baseline ppl; placement (hot vs cold) is the decisive lever**, not the fallback math.

Findings: (1) **Simplest fallback wins in the realistic regime** — "drop" (keep the model's own top-8 routing, lose only the unavailable picks' contributions, NO renorm) beats "reselect" (re-softmax over available) whenever most picks are hosted; reselect only helps as a sparse-hosting safety net. (2) **`norm_topk_prob` matters critically**: forcing top-k weights to sum-to-1 on a `False` model (OLMoE) detonates quality even at 56/64 experts (811 ppl) — an early implementation bug, now isolated as the `reselect_renorm` column. Match the model's own norm behavior.

**Caveats (do NOT overclaim):** hot experts were calibrated on the SAME passage used for eval → mild optimism in the exact numbers (a real system calibrates hot sets on general traffic, and a specific query may want cold experts); single short passage + ppl only (ppl 5–9 = "degraded but coherent" — generation-quality not yet checked); OLMoE is 64-expert/top-8 — **Qwen3-235B is 128-expert/top-8, a different ratio; the curve must be re-measured there**. The SHAPE (graceful, placement-dominated) is robust; the exact per-N ppl is directional.

**Next runtime steps (now justified by the green gate):** re-measure on Qwen3-235B (128 experts) with clean train/eval split + generation-quality; then build the real runtime — skippy expert-subset manifest + the cross-peer gather-sum + hot/cold placement policy.

## Build log — Slicing PROVEN at TARGET SCALE on Qwen3-235B (2026-07-18)

Qwen3-235B-A22B Q4_K_M GGUF downloaded (3 parts, ~134 GB, `.88:/mnt/local24/qwen235-gguf`). Structure confirmed via skippy inspect + gguf: `qwen3moe`, **128 experts / top-8 / 94 layers**, activation 4096, `norm_topk_prob=True`, NO shared experts, all layers MoE.

- **Expert-dimension slicer PROVEN at 128-expert scale** (`.88:/mnt/local24/qwen-expert-slice.py`): experts are the outermost axis exactly as OLMoE (`ffn_gate_exps` raw `(128,1536,2304)` Q4_K @3.54 MB/expert, `ffn_down_exps` Q6_K @5.16 MB/expert). 128→64+64 split lossless byte-exact; valid sub-fragment (748 MB, layer-0 experts 0-63) re-reads identical, shape `(4096,1536,64)`. So expert-parallel slicing works on the real target.
- **Whole-layer Skippy write-package** on all 94 layers running as durable job `qwen235-slice.service` → `/mnt/local24/qwen235-pkg` (~134 GB output, HDD I/O-bound).
- **Reminder for the quality/fallback R2:** this GGUF is for the SLICING path only. The transformers-based fallback experiment still needs Qwen3-30B-A3B **HF weights** (same arch: 128-exp/top-8/`norm_topk_prob=True`, 48 layers) — and `norm_topk_prob=True` means the OLMoE "drop" fallback likely flips to renormalize-over-available.

## Build log — Expert-dimension slicer PROVEN (2026-07-18)

**Expert-axis (dimension) slicing of a MoE works losslessly — the enabler for expert-parallel / partial-expert hosting.** Prototype at `H:/dev/expert-slicer-proto/` (+ `.88:/mnt/local24/expert-*.py`).

- **Key finding:** the `gguf` reader exposes a merged expert tensor's raw quantized bytes as `[n_expert, rows, bytes_per_row]` — **experts are the outermost axis** and quant super-blocks never span experts. So `data[subset]` extracts whole experts **byte-exact, no dequant** (Q4_K gate/up @1,179,648 B/expert, Q6_K down @1,720,320 B/expert). Arbitrary non-contiguous subsets (`[5,17,42]`) work too.
- **Proven on OLMoE-1B-7B Q4 (64 experts):** lossless slice; wrote **valid sub-GGUF fragments** (layer 0 → experts A[0-31] + B[32-63], 126 MB each) that re-read byte-identical with correct shape `(2048,1024,32)` and `expert_count=32`; A+B reassembles == original. Router (`ffn_gate_inp`) kept whole for scoring+masking.
- **gguf-writer gotcha:** for a pre-quantized tensor, `add_tensor(raw_shape=…)` wants the **numpy byte shape** (last dim = bytes/row), not the logical or reversed shape.
- **This proves the SLICE, not the RUNTIME.** Still to build (the larger step): port into skippy (Rust) + manifest support for per-expert-subset fragments; router masking + **gate renormalization** over available experts; the cross-peer gather-sum per MoE layer (LAN-only barrier); hot/cold-aware placement + quality vs colibrì's `EXPERT_BUDGET` collapse baseline. **Target model downloading:** unsloth Qwen3-235B-A22B Q4_K_M (3 parts, ~140 GB) → `.88:/mnt/local24/qwen235-gguf`.

## Build log — Track 2 slicing PROVEN (2026-07-17)

**Skippy slices a real MoE into per-layer fragments, experts bundled per layer — verified end-to-end.**

- **Built `skippy-model-package` on .88** (`mesh-llm` @ workspace, static build bundling patched llama.cpp @ pin `99f3dc32`). Three `.88`-GitHub-IPv6 fights, all worked around: (1) pinned `github.com`→IPv4 in `/etc/hosts` (only ghcr/codeload were pinned); (2) the partial-clone pack fetch still reset mid-transfer, so a shallow depth-1 checkout of the pinned commit was made on the workstation and transferred to `.deps/llama.cpp`; (3) `prepare-llama.sh` still runs `git fetch origin master` in *pinned* mode — pointed `LLAMA_UPSTREAM_URL` at a **local bare mirror** to make it fully offline. Binary: `target/release/skippy-model-package` (21 MB). Note: `write-package`/`inspect` need the native llama runtime (they read GGUF through the FFI), so the static build is required — the packaging tool is NOT pure-Rust.
- **Sliced OLMoE-1B-7B (Q4_K_M, real MoE: 64 experts, top-8)** → `write-package` produced a `layer-package`: **16 per-layer fragments** (`layer-000.gguf`…`015`, ~262 MB each), `layer_count:16`, `activation_width:2048`, `shared:{metadata,embeddings,output}`, each layer 12 tensors with sha256.
- **Experts bundle per layer — confirmed by tensor names.** `inspect layer-000.gguf` shows the three **merged 3D expert tensors** `blk.0.ffn_{gate,up,down}_exps.weight` (each holds all 64 experts) alongside attention/norms/router (`ffn_gate_inp`) — 12 tensors total, NOT 64+. Exactly the research prediction: **layer-level slicing works; experts are one merged tensor and cannot be split into their own fragments.**
- **`validate-package` PASS** — all 16 fragments' sha256/tensor-count/bytes match the manifest, no missing/duplicate layers, verified against the full GGUF. Package size 4.0 GB = source 4.0 GB (content-preserving).

**What this means for GLM-5.2 (the scaling caveat):** the *mechanism* is proven on any llama.cpp-supported MoE. OLMoE's 262 MB layer fragments would actually fit a browser WebGPU buffer — so OLMoE could run on browser peers. **GLM-5.2's layers are ~4–5 GB each** (256 experts vs OLMoE's 64) and a layer can't be subdivided (experts = one merged tensor) → GLM-5.2 exceeds the browser buffer ceiling and is **native-peer-only**, plus needs DSA/MTP runtime support. Slicing GLM-5.2 itself needs a GLM-5.2 GGUF (unsloth's, or llama.cpp convert) — not colibrì's int4-safetensors.

## Build log — generic bridge PROVEN + Track 2 kickoff (2026-07-17)

- **Generic server bridge — DONE & PROVEN** (`399d001`). The text bridge is not colibrì-specific: `--engine=openai` drives any OpenAI `/v1/chat/completions` SSE server; `colibri` is a preset; configurable `--tool-name`. **Proven end-to-end against ollama `qwen2.5:0.5b`** (a non-colibrì server) through the adapter — exact output "mesh bridge works", 3 deltas, finish=stop, 458 ms. Parser unit test 9/9. This satisfies the "generic, proven server bridge" goal; the full mesh demo is deferred (user not ready to demo).
- **GLM-5.2 FP8 download** — running as durable systemd unit `glm52-dl.service` (linger on) → `/mnt/local24/glm52-fp8`, ~756 GB, resumable. (User: defer demo but still stage the model; a second box will offload .88.)
- **Track 2 kickoff (prove Skippy MoE slicing)** — mesh-llm source transferred to `.88:/mnt/local24/mesh-llm`; `skippy-build.service` installs rustup (cargo 1.97.1) + builds `skippy-model-package` (release); `olmoe-dl.service` fetching an OLMoE-1B-7B GGUF (real MoE, 64 experts/top-8) as the small de-risk slice target. Next: `inspect` → `write-package` → `validate-package`, confirm experts bundle per-layer + manifest `layer_count`/`activation_width`; then document GLM-5.2-specific deltas (DSA/MTP/4–5 GB layer vs browser buffer ceiling). Reminder: colibrì's own format is int4-safetensors, NOT GGUF — the mesh slicing path is GLM-5.2→GGUF→skippy.

## Build log — Stage 1 (2026-07-17, bridge shim) — DONE (code+tests)

Committed `39b5621` on `feat/colibri-deep-answer-bridge` in `legion-server-bridge` (not yet merged/deployed — gated on Stage 2/3 E2E).

- **`src/colibri.ts`** — the OpenAI-SSE sibling of the Codec `bridge.ts`. `streamColibri()` POSTs to colibrì `/v1/chat/completions` (`stream:true`), parses JSON-SSE, keeps GLM **`delta.reasoning_content`** (thinking) separate from **`delta.content`** (answer), with an **idle timeout** (default 120 s of silence = dead; a slow deep model keeps resetting it). `createColibriBridge()` registers a **`deep_answer`** tool (returns text as the tool result — no browser tokenizer needed) plus an **`/ai @nick`** chat responder that streams throttled `sendChat` text updates.
- **`src/cli.ts`** — `--engine=codec|colibri` selector; colibrì needs **no `--map-id`** (text, not token-ids); `--colibri-url` / `LEGION_COLIBRI_URL` alias.
- **Zero mesh-core wire change** — text delivery rides the existing `MeshChatMessage.bodyKind:'text'`. The v1 "text-frame additive guard" turned out unnecessary.
- **Validation:** typechecks + builds against the built mesh-core types; `test/colibri-parse.test.mjs` (deterministic in-process mock gateway) 9/9 — content/reasoning split, token count, `[DONE]`, cumulative `onDelta`, idle-timeout graceful partial. Real gateway protocol confirmed by curl in Stage 0; the two compose.
- **Remaining for Track 1:** Stage 2 (apps/chat "Ask the deep model" UX + run bridge as .88 compose service joining the prod room) and Stage 3 (E2E kill/rejoin, deploy). Both buildable against the tiny oracle; a *real* 744B demo is gated on the GLM-5.2-weights decision (Stage 0 OPEN item).

## What changed from v1

v1 treated this as "port colibrì onto the mesh (no) / shard experts across peers (no) / bridge colibrì as one heavy peer (yes)." Deeper research reframes the middle option. The real, buildable version of "adapt colibrì's concept to Legion" is **native pipeline-parallel by layer range with per-peer memory tiering** — which needs neither a colibrì-in-WASM port nor per-expert sharding, and is not blocked by the recurrent-SSM dead-end that killed qwen3.5.

## Verdict (TL;DR)

| Interpretation | Verdict |
|---|---|
| **A. Port colibrì's C engine into browser peers** | ❌ Not viable — native-C/io_uring vs WASM, 370 GB/peer, custom format |
| **B. Shard individual experts across peers** | ❌ Un-buildable today AND unnecessary — no per-expert fragment exists; goal is met without it |
| **C. Native pipeline-parallel GLM-5.2 across mesh peers** (layer ranges + per-peer colibrì-style tiering) | 🟡 Viable as R&D — the genuine "concept adaptation"; blockers are known and bounded |
| **D. colibrì as one native heavy-peer tool node** | ✅ Viable now — the fast proof-of-concept |

**Recommendation: two tracks. Track 1 = D (days, proves the mesh reaches a big model). Track 2 = C, de-risked by proving the chain on a *small* MoE first, then scaling to GLM-5.2.**

---

## The four questions answered

### 1. Hardware — ideal, and can we run it in VRAM?

**No pure-VRAM path exists, and none is needed.** colibrì always clamps its VRAM tier to physically-free VRAM (minus a 2 GB/device reserve), then spills to RAM, then disk (`glm.c:5487-5494`). What eliminates the disk bottleneck is **full residency across VRAM+RAM combined**:

- **~380 GB of aggregate fast memory** (≈370 GB experts int4 + ~10 GB dense) holds the entire model resident → **6.3–6.8 tok/s** single-request decode, vs **0.12 tok/s** when disk is still in the loop (a ~50× jump). Proven on 6×RTX 5090: 176.7 GB VRAM + 191.3 GB RAM, 0 s disk wait (`docs/experiments/glm52-6x5090-2026-07-12.md`).
- Experts aggregate **additively across GPUs on one host** (6 cards held 9,343 experts collectively) via `cudaMemcpyPeer` — **single-host only, no networked multi-node** in colibrì.
- After disk is gone, the limiter is the **int4 expert matmul** (84.9% of CPU samples). AVX-512/VNNI or Tensor-Core int4 GEMM is the multiplier toward the 20–30 tok/s that 2×RTX PRO 6000 (96 GB each) reaches in vLLM.

**Ideal single box:** ~380+ GB fast memory in as few large-VRAM islands as possible (fewer, bigger cards beat many small ones — six 32 GB islands ≠ two 96 GB) + fast int4 kernels. **Smaller quants lower the bar:** IQ2_M ≈ 240 GB, IQ1_S ≈ 223 GB (unsloth Dynamic 2.0) fit residency on far less memory, at a measured quality cost.

**.88 as-is cannot do full residency:** 2×3090 (48 GB) + 125 GB RAM ≈ 173 GB, well short of 380 GB → it would stream from SATA at colibrì's floor. **This memory gap is exactly what Track 2 aggregates across peers.**

### 2. Codec GLM map — producible?

**Yes.** GLM-5.2's tokenizer is byte-level BPE in the tiktoken lineage (`colibri/c/tok.h:1-3`), the same family as Codec's existing qwen2/llama-3/deepseek-v3 maps. There is no GLM map today, but:

- **Detokenization-only map = trivial now.** `codecai-maps build <glm> --id=zai-org/glm-5` produces vocab + `byte_level` through `codec-maps/scripts/convert.ts` with zero special handling. **This is all the mesh bridge needs** (browser detokenizes token-ids at the edge).
- **Round-trip-exact encode = bounded work.** GLM uses `ignore_merges=true` (tiktoken-rank encoding); Codec's client BPE applies merges in priority order, so exact tokenization needs a tiktoken-rank code path (or an `ignore_merges` schema flag) plus verification that the single-regex pretokenizer capture covers GLM's multi-step pretokenizer, plus a GLM tool-calling convention. Validate with `codecai-maps preview … --text=… → "exact match: YES"`.

### 3. Can Skippy slice GLM-5.2 today?

**The slicer: yes. Browser execution: no. Native execution: yes, with two features disabled.**

- `skippy-model-package write-package` cuts any GGUF into **whole-layer fragments**, MoE experts bundled inside each layer (`mesh-llm/crates/skippy-model-package/src/main.rs:590-617`). MLA is a solved runtime path (GLM-4.7 Flash / GLM4-MoE certified, `FAMILY_STATUS.md:24-26`). So slicing GLM-5.2 by layer works today.
- **Browser peers are blocked, unavoidably:** a 256-expert GLM-5.2 layer is ~4–5 GB int4 — over the WebGPU per-buffer ceiling — and the format **cannot subdivide a layer** (no expert fragment; `stagePlanner.ts:324-332`). No quant gets a layer reliably under ~2 GB. Browsers are out for GLM-5.2 period.
- **Native stage hosts are the answer** and remove the buffer ceiling. Two features still need handling: **DSA** (no mesh certification yet; only an in-progress "GLM DSA stale shard" commit; serve with DSA off initially — colibrì supports `DSA=0`) and **native MTP** (the browser glue explicitly skips it, `native/stage_glue.cpp:9-10`; mesh-llm's native-MTP work targets GLM-4.7 Flash first — run MTP off initially).

### 4. Distributing / parallelizing the 19 MB chunks

The instinct is sound — top-8 experts per token are summed, so independent — but the buildable form is **not** per-expert cross-peer sharding:

- **Intra-peer, it already exists.** colibrì parallelizes expert compute within a peer via OpenMP, async readahead, and a grouped-expert CUDA kernel (8 experts per launch). No mesh needed for that.
- **Cross-peer, the unit must be the layer range, not the expert.** Per-expert fragments don't exist in GGUF/Skippy/Legion's manifest, and building them would still cost a network barrier *per MoE layer* — 75 barriers/token. On internet browser peers (~30 ms RTT) that's 2–6 s/token (dead); on **LAN native peers (<1 ms RTT)** it's ~75 ms (negligible) — but it's moot because layer-range splitting achieves the goal without it.
- **Pipeline-parallel by layer range** gives each native peer a contiguous slice of the 75 layers, all experts of those layers resident via colibrì-style RAM+VRAM+disk tiering. Cross-peer traffic = a few small MLA-compressed activation hops per token. This is what aggregates ~380 GB of residency across boxes **without** the un-buildable format change or the latency tax.

---

## The two tracks

### Track 1 — colibrì as a native heavy-peer tool node (fast PoC, days)

Goal: a browser peer on legion.codecai.net escalates a hard question to a colibrì peer via a mesh tool call and streams back a 744B-model answer, over existing self-hosted signaling/TURN.

- **Stage 0 — colibrì standalone on .88.** Pin a colibrì commit; build (AVX2/EPYC). Validate plumbing with the small **OLMoE** engine first, then fetch a GLM-5.2 quant sized to .88 (IQ2_M ~240 GB fits `/mnt/ssd2`'s 624 GB free with margin; expect ~0.2–0.5 tok/s warm — demo-grade). `coli serve` (OpenAI gateway, localhost, `--max-queue 2`). **Gate:** warm < ~0.15 tok/s ⇒ ship the PoC on OLMoE and park GLM-5.2 until better disk/memory.
- **Stage 1 — bridge shim.** Extend `legion-server-bridge` with an **OpenAI-SSE upstream adapter + text-frame tool results**: a `deep_answer` `tc` tool call → colibrì `/v1/chat/completions` stream → chunked text back to the asker. No token-ids, no GLM tokenizer in browser. Additive guard/type in `mesh-core` (`guards.ts`, `tools.ts`).
- **Stage 2 — mesh + UX.** Bridge as a compose service on .88 (IaC in homelab-compose), joining the prod room via `wss://signal.quasarke.net/mqtt`, `cap.tools=[deep_answer, ping]`. An explicit "Ask the deep model" affordance in `apps/chat` with honest seconds-per-token framing.
- **Stage 3 — prove & harden.** Two browser peers + colibrì peer; kill/rejoin mid-answer (clean timeout, mesh unaffected); OPFS path untouched; counts-only telemetry; commit → merge → deploy.

### Track 2 — native pipeline-parallel MoE across the mesh (the concept, R&D)

Goal: prove that a GLM-class MoE can be split by layer range across **native** stage hosts joined to the Legion mesh, aggregating residency no single box has.

- **Step 1 — chain on a SMALL MoE first (de-risk, mirrors colibrì's own OLMoE→GLM path).** Pick an already-certified small MoE (e.g. Qwen3-30B-A3B or GLM-4.5-Air-class). `skippy-model-package write-package` → whole-layer fragments; produce a **detok-only Codec map**; stand up **two native stage hosts** (Node + native llama.cpp stage runtime, DSA/MTP off) each holding a layer range; join them to a room; confirm a split forward is token-exact vs the monolith and streams token-ids on the Codec wire. This exercises slice → map → native-split → mesh end-to-end cheaply.
- **Step 2 — per-peer memory tiering.** Give each native stage host a colibrì-style RAM(+VRAM+disk) tier so a *fat* MoE layer range fits without a giant box. This is the piece that makes GLM-5.2's 4–5 GB layers placeable on modest peers.
- **Step 3 — scale to GLM-5.2, DSA/MTP off.** Slice the unsloth GLM-5.2 GGUF by layer; distribute layer ranges across the available native boxes (.88, workstation, .198/.229 as capacity allows) to reach full residency collectively; measure tok/s and cross-peer hop cost. Land DSA/MTP support only if the quality/throughput delta justifies it (track mesh-llm's native-MTP/DSA work).

**Track 2 explicitly de-scopes:** per-expert cross-peer sharding, colibrì-in-WASM, GLM-5.2 on browser peers, native MTP/DSA in the browser glue.

---

## Benefits, pitfalls, non-goals

**Benefits:** 744B-class capability reachable from any browser peer with zero browser download (Track 1); Track 2 aggregates ~380 GB residency across heterogeneous homelab boxes so no single 380 GB machine is required — colibrì's disk-streaming floor escaped without datacenter InfiniBand; validates Legion's native-host roadmap (§D1) and reuses the whole stack conjunctively (skippy slice + Codec map + colibrì tiering + mesh fabric); all self-hosted.

**Pitfalls:** throughput is "deep answer," never chat — frame it honestly; .88 alone can't hit full residency (that's the point of Track 2's aggregation); DSA is the one unproven runtime axis (run off initially); native MTP not in the browser glue; a single MoE layer can't be subdivided, so each peer's layer range must fit its per-buffer budget; Codec round-trip-exact encode needs the ignore_merges/tiktoken path (detok-only unblocks the bridge now); pipeline-parallel improves *throughput/residency*, not single-token latency (sequential layers); colibrì upstream moves fast — pin a commit; GLM-5.2 weights are a one-time 220–475 GB download depending on quant.

**Non-goals:** expert-level sharding across peers; running the 744B model on browser peers; a colibrì WASM port; treating Track 2 as interactive-chat-speed.

### Anchor files
- colibrì memory tiers/GPU: `colibri/c/glm.c` (pin_load 5483-5542, resource_plan.py), `docs/experiments/glm52-6x5090-2026-07-12.md`, `c/tok.h` (tokenizer).
- Skippy slice + format: `mesh-llm/crates/skippy-model-package/src/main.rs`, `mesh-llm/docs/specs/layer-package-repos.md`, `mesh-llm/docs/skippy/FAMILY_STATUS.md`, `legion-stage-runtime/scripts/slice-model.sh`, `native/stage_glue.cpp`, `third_party/llama.cpp/{upstream.txt,patches/}`.
- Mesh planner/bridge: `unstable-legion/packages/mesh-core/src/{stagePlanner,guards,tools}.ts`, `legion-server-bridge/README.md`, `unstable-legion/docs/mesh-llm-assessment.md`.
- Codec maps: `codec-maps/README.md`, `codec-maps/scripts/convert.ts`.
- Native MTP/DSA WIP: `mesh-llm/docs/design/GLM_NATIVE_MTP_SKIPPY_ARCHITECTURE.md`, mesh-llm commit `8dead37c`.
