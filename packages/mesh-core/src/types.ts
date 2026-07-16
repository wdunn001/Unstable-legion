/**
 * Wire types for Unstable Legion's peer-to-peer mesh.
 *
 * Three Trystero action payloads:
 *   - `cap` — `MeshPeerCap`, capability advertisement (on join + 30s heartbeat + change)
 *   - `cm`  — `MeshChatMessage`, chat over Codec msgpack frames
 *   - `tc`  — `MeshToolCall` / `MeshToolResult`, tool invocation
 *
 * Schemas are versioned (`v: 1`) so a future protocol bump can be
 * gated without crashing stale tabs.
 *
 * The wire types deliberately don't try to satisfy Trystero's
 * `DataPayload` constraint structurally — that constraint excludes
 * readonly arrays, optional fields, and `unknown`, all of which the
 * domain types want for ergonomics. The peer module casts through
 * `unknown` once at the wire boundary, with runtime type-guards
 * carrying the safety burden (see `guards.ts`).
 */

/** Wire-format version. Bump when shape changes. */
export const MESH_PROTOCOL_VERSION = 1 as const;

// ── cap: capability advertisement ──────────────────────────────────────────

/**
 * MCP-compatible tool descriptor — the schema fields a peer advertises
 * for each tool it's willing to execute on its own machine. Mirrors the
 * Anthropic / MCP "tool" object shape so a future MCP-bridge can re-emit
 * these as native MCP tools without reshaping.
 */
export interface MeshToolDescriptor {
  /** Unique within the advertising peer's tool set. */
  name: string;
  /** One-line human description for roster UI. */
  description: string;
  /**
   * JSON Schema for the call's `args` object. Kept opaque (`unknown`)
   * at the protocol layer — receiving peer validates against its
   * locally-registered tool definition, not this descriptor's schema.
   */
  inputSchema: Readonly<Record<string, unknown>>;
}

/**
 * Peer capability advertisement — broadcast on the `cap` Trystero action
 * when a peer joins, every 30s heartbeat, and on local change.
 */
export interface MeshPeerCap {
  v: typeof MESH_PROTOCOL_VERSION;
  /** Wall-clock millis the cap was minted. Used for staleness only — clocks aren't assumed in sync. */
  ts: number;
  /** Operator-chosen display name. */
  nick: string;
  /**
   * Model id the peer's local engine is running. Format is
   * implementation-defined; for `@mlc-ai/web-llm` it's e.g.
   * `Qwen2.5-0.5B-Instruct-q4f16_1-MLC`.
   */
  modelId: string;
  /** True iff the peer's engine is warm and willing to service prompts. */
  available: boolean;
  /**
   * Operator-tagged specialty list, e.g. `["code-review", "ja-translate"]`.
   * For Layer-4 hierarchical routing: skills can use dotted paths
   * (`coding.python.optimize`) — the existing field is treated as the
   * authoritative-leaf list for back-compat. Prefer `authoritative`
   * + `delegating` (below) for new peers; both shapes interoperate.
   */
  skills: readonly string[];
  /**
   * Layer-4 hierarchical-routing field. Skills this peer EXECUTES
   * itself (the "authoritative answer" set, DNS A-record analog).
   * Optional; absent or empty means use `skills[]` instead. Mixing
   * is allowed (the resolver unions both).
   */
  authoritative?: readonly string[];
  /**
   * Layer-4 hierarchical-routing field. Skill ZONES this peer routes
   * for but doesn't execute (DNS NS-record analog). e.g. `coding.python`
   * means "I know peers who handle anything under coding.python.* —
   * ask me and I'll forward via my `route_skill` tool." Optional.
   */
  delegating?: readonly string[];
  /** One-line summary of the persona / system prompt for roster display. */
  systemPromptSummary: string;
  /** Tool descriptors this peer will execute over the `tc` action. */
  tools: readonly MeshToolDescriptor[];
  /**
   * Phase C — pipeline-split stage hosting. Optional; absent means this
   * peer doesn't participate in split-model inference (v1-compatible: an
   * older peer or a peer without stage-runtime simply omits the field,
   * and `stagePlanner.ts` filters it out of candidacy). See
   * `H:\dev\legion-stage-runtime\docs\SLICING.md` / `docs/CHAOS.md` for
   * the capacity model and stability-scoring rationale this shape backs.
   */
  stageHost?: {
    /** GPU VRAM budget in bytes, when the peer can determine it (WebGPU
     * adapter limits are often approximate/unavailable — falls back to
     * `maxStorageBufferBytes` in the planner's capacity calc when absent). */
    vramBytes?: number;
    /** WebGPU `maxStorageBufferBindingSize` (or equivalent) — a hard
     * per-binding ceiling independent of total VRAM. */
    maxStorageBufferBytes: number;
    /** wasm linear-memory budget this peer is willing to dedicate to a
     * stage runtime instance. */
    wasmHeapBudget: number;
    /**
     * Fragment ids of per-layer artifacts already resident in this
     * peer's OPFS cache (see SLICING.md "Target state (Phase C)" —
     * `layer-00005` etc.). Absent/empty = no cache locality signal.
     * The planner uses this to prefer reassigning a peer the range it
     * already holds (cheap failover / replan).
     */
    cachedFragments?: readonly string[];
    /**
     * Chaos-model stability signals (CHAOS.md Layer 4) — the planner
     * uses these to prefer a stable desktop tab over a freshly-joined
     * one at equal capacity, and to pick hot-spare candidates.
     */
    stability?: {
      /** Audio-keepalive (or equivalent) active — peer is trying to stay backgrounded-alive. */
      keepalive: boolean;
      /** Tab is pinned (harder for the user to accidentally close). */
      pinned?: boolean;
      /** document.visibilityState === 'visible' at cap-mint time. */
      visible: boolean;
      /** true = running on battery (deprioritized vs AC power). */
      onBattery?: boolean;
      /** Milliseconds since this peer joined the mesh (tab/session age). */
      uptimeMs: number;
    };
    /**
     * M2 — maximum concurrent driver sessions this peer commits to when it
     * loads a stage (chosen once at load time, not elastic per-request —
     * see legion-stage-runtime's docs/MULTI-SESSION.md: skippy sessions are
     * lanes into ONE shared llama_context, and lane_count is fixed at
     * legion_stage_open time). Absent = this peer hasn't loaded a stage
     * yet, or predates M2 (treat as maxSessions=1 for planning purposes).
     */
    maxSessions?: number;
    /** Sessions currently occupying a lane, for roster-level "how full is
     * this host" display. Absent = no session ever opened yet. */
    activeSessions?: number;
    /**
     * M3 — communal pipeline: every stage this peer currently has LOADED
     * and warm (never advertised before `warmUpStageWorker` completes —
     * the C3 cold-shader lesson). A peer with `activeSessions === 0` can
     * still have entries here (a loaded-but-idle stage — see M3's
     * "no idle-unload v1" teardown rule: staying advertised is the point).
     * Absent/empty = this peer hasn't loaded any stage yet, or predates
     * M3. `communalTopology.ts`'s `buildCommunalTopology` is the sole
     * consumer that turns a roster's union of these into a coverage map —
     * nothing else in mesh-core reads this field directly.
     */
    loadedStages?: readonly MeshLoadedStage[];
  };
}

/**
 * One entry in `MeshPeerCap.stageHost.loadedStages` (M3). Deliberately a
 * peer-local fact ("what I have loaded"), not a claim about the mesh's
 * overall coverage — `communalTopology.ts` unions these across the roster
 * to compute coverage/gaps/seats.
 */
export interface MeshLoadedStage {
  modelId: string;
  /** Inclusive start layer of this loaded stage. */
  layerStart: number;
  /** Exclusive end layer of this loaded stage. */
  layerEnd: number;
  includeEmbeddings: boolean;
  includeOutput: boolean;
  ctxSize: number;
  wireDtype: 'f32' | 'f16';
  /** Lane ceiling committed at load time (see `chooseMaxSessions`). */
  maxSessions: number;
  /** Sessions currently occupying a lane on THIS stage. */
  activeSessions: number;
  /**
   * Monotonic counter, bumped every time this peer (re)loads a stage
   * (including reloading the SAME layer range) — lets a consumer detect
   * "this is a fresh load of the same range" vs stale cap data during a
   * fast reload, without needing wall-clock comparisons across peers
   * with unsynced clocks.
   */
  epoch: number;
}

// ── cm: chat-message frame ─────────────────────────────────────────────────

/**
 * Chat message between peers. The body is wrapped in a Codec msgpack
 * frame (see `@codecai/web` encoder) so the same byte format that
 * vLLM/sglang/llama.cpp emit also flows between browsers. Relays /
 * observers can passthrough without detokenizing.
 *
 * When the sending peer pre-tokenized the message (knows the recipient's
 * tokenizer map by id), `bodyKind: 'tokens'` carries packed uint32 IDs.
 * Otherwise `bodyKind: 'text'` ships UTF-8 + the receiver tokenizes.
 *
 * Both shapes are still wrapped in the same Codec msgpack frame for wire
 * uniformity — the peer-side encoder/decoder handles the dispatch.
 */
export interface MeshChatMessage {
  v: typeof MESH_PROTOCOL_VERSION;
  ts: number;
  /** Sender's selfId for correlation; the Trystero room enforces the channel anyway. */
  from: string;
  /** Empty = broadcast; non-empty = directed to a specific peer's selfId. */
  to: string;
  /**
   * `text` — UTF-8 prompt + ready-for-receive-side-tokenize.
   * `tokens` — pre-tokenized; receiver loads the named map + detokenizes.
   * `frame` — opaque Codec msgpack frame bytes (already-encoded stream
   *           output forwarded from a model elsewhere; receiver decodes
   *           via `@codecai/web`'s `decodeMsgpackStream`).
   */
  bodyKind: 'text' | 'tokens' | 'frame';
  /** UTF-8 string when `bodyKind === 'text'`. */
  text?: string;
  /** Packed uint32 ids when `bodyKind === 'tokens'`. */
  ids?: readonly number[];
  /** Tokenizer map id (used by both `tokens` and `frame` bodies). */
  mapId?: string;
  /** Opaque Codec frame bytes when `bodyKind === 'frame'`. base64-encoded for Trystero JSON serialization. */
  frame?: string;
  /**
   * Safety classifier verdict the sender ran locally before transmit.
   * Receivers MAY re-run their own classifier; this is informational so
   * a receiver UI can show the badge without re-classifying every msg.
   */
  safety?: {
    /** Highest-severity category seen, if any. */
    category?: string;
    /** Confidence [0,1]; 1.0 = regex hit, <1 = classifier. */
    confidence?: number;
    /** Source: 'prefilter' (regex), 'classifier' (model), or 'clean'. */
    source: 'prefilter' | 'classifier' | 'clean';
  };
}

// ── tc: tool-call request/response ────────────────────────────────────────

/**
 * Outbound tool-call request — sent by an asker to a specific peer over
 * the `tc` action. The asker invents `callId`; the responding peer
 * echoes it on the matching `MeshToolResult`.
 */
export interface MeshToolCall {
  v: typeof MESH_PROTOCOL_VERSION;
  ts: number;
  /** Per-invocation correlation id. ULID / UUID / nanoid — any unique-within-this-room string works. */
  callId: string;
  /** From the responder's `tools[*].name`. */
  toolName: string;
  /** Validated by the responder against its `inputSchema`. */
  args: Readonly<Record<string, unknown>>;
}

/** Response counterpart to `MeshToolCall`, echoed on the same `callId`. */
export interface MeshToolResult {
  v: typeof MESH_PROTOCOL_VERSION;
  ts: number;
  /** Echo of the request's callId. */
  callId: string;
  /** Status: 'ok' = `result` present; 'error' = `error` present; 'denied' = blocked by responder safety. */
  status: 'ok' | 'error' | 'denied';
  /** JSON-shaped result on success. */
  result?: Readonly<Record<string, unknown>>;
  /** Human-readable error reason on failure. */
  error?: string;
}

// ── Aggregated discriminated union for the `tc` payload ────────────────────

export type MeshToolFrame =
  | ({ kind: 'call' } & MeshToolCall)
  | ({ kind: 'result' } & MeshToolResult);

// ── Roster entry (local-side view of remote peers) ────────────────────────

/**
 * What a local consumer sees when iterating the roster. Same shape as
 * `MeshPeerCap` plus the local `peerId` (Trystero selfId of the remote)
 * and `lastSeen` (local clock — for stale-peer pruning).
 */
export interface MeshRosterEntry extends MeshPeerCap {
  /** Trystero selfId of the remote peer. */
  peerId: string;
  /** Local-clock millis the most recent `cap` was received. */
  lastSeen: number;
}
