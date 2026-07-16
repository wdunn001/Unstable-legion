# TOOL-NODES — GPU-less peers that contribute tool calls

A peer with no GPU (or one that simply chooses not to host model layers) can
still be a **first-class mesh participant** by advertising `cap.tools[]` and
executing tool calls for others. It earns **standing** (`docs/ECONOMY.md`)
the same way a layer-serving host does, so a contribution that costs no VRAM
still buys real routing priority.

This needs nothing new on the wire: the tool system already exists —
`MeshToolDescriptor` in `cap.tools[]`, the `tc` action, `MeshToolCall` /
`MeshToolResult`, `ToolRegistry.dispatch`, `PendingToolCallTracker`,
`routing.findPeersByTool`, and the MCP bridge (`mcp.ts`). A peer advertises
`cap.tools[]` whether or not it advertises `cap.stageHost` — the two are
independent fields on `MeshPeerCap`. A GPU-less tool node just publishes the
former and omits the latter.

## What landed (this PR) — one tool round-trip + economy

### 1. Detection — `toolLoop.ts` (mesh-core)

`parseToolCalls(text)` / `firstToolCall(text)` scan a span of **generated,
detokenized** text for `<tool_call>{"name": "...", "arguments": {...}}
</tool_call>` blocks — the exact convention `mesh-react`'s `useDirector`
already emits (and the codec `tool_watcher` grammar targets), so a model
prompted for either surface interoperates. Malformed blocks are skipped, not
thrown (a partial block mid-stream self-corrects on the next chunk).
Unit-tested in `test/toolLoop.test.ts`.

### 2. Round-trip — `runToolRoundTrip(opts)` (mesh-core)

Routes ONE detected call to a live provider and returns its result:

1. `findPeersByTool(roster, name)` → rank by `priorityScore` (a tool node
   with earned standing is preferred), then freshest `lastSeen`.
2. For each provider in rank order: mint a `callId`, `tracker.expect(callId,
   timeoutMs)`, `peer.sendTool(call)`, await the correlated `MeshToolResult`.
3. A provider that vanishes (timeout / send failure) falls through to the
   next candidate. An empty/exhausted provider set is a graceful
   `no-provider` / `timeout` — **never a hang**.
4. Returns `{ status, providerPeerId, result, resultBlock, ... }` where
   `resultBlock` is a `<tool_result>…</tool_result>` string ready for the
   driver to **re-prefill** into the model's context and continue
   generating.

The function owns a private `PendingToolCallTracker` + `onTool` subscription
for the round trip, keyed by a fresh `callId`, so it composes cleanly
alongside a stage session's own tracker with no cross-talk.

### 3. Economy — `standing.ts`

- `recordToolService({ providerPeerId, succeeded }, now)` credits the
  provider a flat `DEFAULT_TOOL_SERVICE_CREDIT` on an `ok` result, into the
  **same decayed accumulator** as `recordService` — so a tool node's
  standing is directly comparable to a layer host's and feeds one
  `priorityScore`. A failed/denied/timed-out call marks the provider "seen"
  (no newcomer re-farming) but credits nothing — parity with
  `recordService`'s completion gate.
- `recordToolConsumption({ consumerPeerId }, now)` debits the asker a flat
  `DEFAULT_TOOL_CONSUME_DEBIT`, not gated on success (you occupied the
  provider's turn regardless).

`runToolRoundTrip` applies both when a `standingLedger` is supplied. Proven
in `test/toolLoop.test.ts`: a served call lifts a GPU-less provider above an
unseen peer; a failed call credits nothing but still debits the consumer;
the consumer carries a debit.

## Follow-up (documented, not wired this PR)

A **coherent single round-trip beats a sprawling loop**, so this PR lands the
building blocks and ONE proven round-trip. The following compose from the
pieces above but are deliberately left for a follow-up:

- **The full multi-round agentic loop inside `useCommunalChat`.** Wiring
  `firstToolCall` against the live decode stream, pausing generation,
  `runToolRoundTrip`, re-prefilling `resultBlock`, and resuming — repeated N
  rounds — is the browser-runtime integration step. The driver would detect a
  tool call in its own generated span (it already detokenizes every token
  for on-screen text), call `runToolRoundTrip`, then feed the `<tool_result>`
  block back through the same continue-from-history re-prefill the churn path
  already uses. `useDirector.ts` is the reference implementation of that loop
  shape against a local LLM; porting it onto the communal decode loop is the
  remaining work.
- **Parallel / nested calls per turn** (multiple `<tool_call>` blocks in one
  generation; a tool whose result triggers another tool). `parseToolCalls`
  already returns all blocks; the scheduler that fans them out and orders
  nested results is follow-up.
- **Per-tool credit weighting.** Today every tool credits the same flat
  unit; weighting by tool cost/latency (`RecordToolServiceInput.credit`
  already accepts an override) is a tuning follow-up.
- **MCP-backed tools from a GPU-less node.** A tool node can front an MCP
  endpoint (`mcp.ts`'s `callMcpTool`) as a mesh tool; the advertise/dispatch
  path is unchanged, only the handler differs.

## ChatML / Qwen3 integration (post-rebase note, 2026-07-16)

`apps/chat` now prompts the communal model in **Qwen3 ChatML**
(`apps/chat/src/chatPrompt.ts`) — which is good news for this workstream:
`<tool_call>{"name": ..., "arguments": ...}</tool_call>` is Qwen3's NATIVE
tool-call emission format, so `parseToolCalls` matches what the deployed
model actually produces without any adapter. Two things the
`useCommunalChat` wiring step must do when it lands:

1. **Declare tools in the system turn.** Qwen3 only emits `<tool_call>`
   blocks when the system prompt lists the available functions (its template
   wraps them in a `<tools>…</tools>` JSON block). `buildPrompt` needs an
   optional tools parameter fed from the mesh's advertised tool registry
   (`findPeersByTool` sources — see `routing.ts`).
2. **Re-prefill results the way Qwen3 expects.** Qwen3's template renders a
   tool result as a user-side `<tool_response>…</tool_response>` turn, NOT
   a bare `<tool_result>` block. `buildToolResultBlock`'s output is the
   mesh-level convention (shared with `useDirector`); the chat app should
   wrap it accordingly when folding it back through `chatPrompt.ts`.
