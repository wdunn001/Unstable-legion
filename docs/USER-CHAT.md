# User-to-User Room Chat

A **human, peer-to-peer text channel** for the Legion chat app — deliberately
distinct from the AI/LLM path. Where the **Assistant** pane streams a model's
reply split across the mesh (`useCommunalChat`, the `cf`/`sf` activation wire),
the **Room** tab is people talking to people: short text messages exchanged
directly between peers in a room, Codec-compressed and rate-limited.

The AI-activation wire is **untouched** by any of this — user chat rides its own
Trystero action (`uc`) with its own codec. Weights are a separate,
weight-shaped problem (see [`DISTRIBUTION.md`](./DISTRIBUTION.md)); this is the
text-shaped one.

## The surface

- A **Room / Assistant tab bar** over the center column (`apps/chat`,
  `App.tsx` + `components/RoomChatPanel.tsx`). The Room tab carries an unread
  badge when you're on the Assistant tab.
- **People roster** down the side — live presence, nicks from `usePersona`
  via the mesh roster (`useMeshRoster`).
- **Plain text only** — no Markdown, no slash-commands. React escapes text
  nodes; the outbound safety prefilter runs before anything leaves the tab.
  Simple and safe by construction.
- Visually one system with the rest of the app: same monospace, mint accent,
  hairline panels, chip badges — light and dark, from the shared `styles.css`
  tokens.

## Codec compression on the chat wire

Per `DISTRIBUTION.md`, a trained dict-zstd does ~nothing for model **weights**
but is exactly the right tool for **text / structured** payloads. Chat frames
are the textbook case: tiny (~40 B msgpack) and highly repetitive (same map
keys, the same handful of nicks, "lgtm"/"brb"/"on my way" over and over).

On payloads that small a **stateless** compressor *loses* — its frame header
alone outweighs what it saves, so plain zstd/gzip/deflate makes a short chat
frame **bigger** than the raw bytes. A **preset dictionary** flips that: the
compressor starts with a warm LZ window full of exactly those repeated tokens.

### What ships

- **Transport:** RFC-1951 **DEFLATE with a preset dictionary** via `fflate`
  (pure-JS, isomorphic — the browser runtime and the Node test harness run the
  *same* code path). DEFLATE-with-preset-dictionary is the same warm-start-
  window technique dict-zstd uses; we use DEFLATE only because it has a
  portable pure-JS implementation with dictionary support that runs identically
  in Chrome and Node **today** (native `CompressionStream` ships no dictionary
  hook). Swapping in dict-zstd later is a drop-in behind the same
  `compressChatBytes` / `decompressChatBytes` API — see *Follow-up* below.
- **Trained dictionary:** built deterministically from an embedded
  representative corpus (`CHAT_DICT_CORPUS` in `mesh-core/src/chatCompression.ts`)
  — transparent and regenerable, not an opaque blob, so every peer builds the
  byte-identical dict at import and both ends agree with no fetch.
- **Self-describing wire:** every payload is prefixed with a one-byte codec tag
  (`0x00` identity / `0x01` dict-deflate). This is the lightweight activation of
  the compression-negotiation surface `webrtc-codec.ts` declares but leaves
  inert for the broadcast chat path — a per-message tag instead of a per-stream
  HELLO/READY, which a fan-out room chat has no place to run. The encoder emits
  whichever form is smaller, so a pathological incompressible frame is never
  inflated by more than the one tag byte.
- **Compact frame:** wire keys are one letter (`v/i/n/o/x/s`), and — critically
  — `from` and `ts` are **not on the wire**. Trystero already hands the receiver
  the sender's peerId out-of-band, and the receive clock is an adequate display
  time; shipping the ~20-char random selfId and a 13-digit epoch in every tiny
  frame would be pure incompressible overhead. The message id is a short
  per-session monotonic counter (compressible), globally unique as the
  `(from, id)` pair.

### Measured ratio (reproducible)

Numbers from `mesh-core/test/chatCompression.test.ts` (`measureCompression`)
and the live browser e2e — not asserted from memory:

| corpus | avg raw | avg wire (dict) | dict ratio | plain-deflate ratio |
|---|---|---|---|---|
| realistic **held-out** mix | ~45 B | ~34 B | **0.77 (1.30×)** | **1.06 (EXPANDS)** |
| common repeated phrases | ~38 B | ~18 B | **0.47 (2.13×)** | 1.06 (expands) |
| live e2e `"hey bob, on my way"` | 40 B | **24 B** | **0.60** | — |

The headline: **dict-deflate is a net win on real short chat frames (1.3–2.1×
smaller), while stateless deflate/zstd *expands* the very same frames** — the
DISTRIBUTION.md thesis, demonstrated. The dictionary pays off precisely where
it's supposed to: small, repetitive text.

## Traffic limiting / anti-spam

All in `mesh-core/src/rateLimiter.ts` (pure, mock-clock unit-tested) and applied
by `mesh-react/src/useUserChat.ts` on **both** directions.

- **Per-peer token bucket.** Each message costs one token; an empty bucket means
  the message is dropped (inbound) or soft-rejected with a `retryAfterMs`
  (outbound). One bucket per peer — a flooder only drains *its own* bucket;
  there's no shared state to exhaust and no ban list to maintain.
- **Standing-gated ceilings — tied to the economy.** A peer's burst cap and
  refill rate scale with its contribution standing, read straight from the same
  `StandingLedger.priorityScore` the mesh economy runs on (`standing.ts`,
  `bindPriorityScore`). This is a deliberate echo of that module's *degrade,
  never deny* philosophy:

  | standing | example | burst | refill |
  |---|---|---|---|
  | debt (score ≤ 0) | heavy consumer | 2 | 0.50/s |
  | newcomer (score 1) | just joined | 3 | 0.75/s |
  | regular (score 8) | steady contributor | 10 | 2.50/s |
  | top (score ≥ 18) | big host | 20 (cap) | 5.00/s |

  Contributors get more chat headroom, newcomers less, debtors least — but every
  lane is **strictly positive**. A newcomer always outranks a debtor and is
  always still served (AI Horde's anonymous-lane rule the economy is modelled
  on). Never a hard block.
- **Safety prefilter.** Outbound text runs through the *same* `prefilterOutbound`
  gate the AI chat uses before anything is transmitted.
- **Dedup / replay suppression.** A bounded FIFO `SeenSet` keyed on the
  `(sender, id)` pair drops duplicated or replayed frames; inbound flood control
  runs *before* decompression so a spamming peer costs as little as possible.

Live e2e result: a peer flooding the room with 20 messages had **18 throttled,
2 sent**, and the other peer received only the 2 that actually left — the flood
was capped, not delivered.

## Module map

| file | role |
|---|---|
| `mesh-core/src/chatCompression.ts` | dict-deflate codec, trained dictionary, `measureCompression` |
| `mesh-core/src/userChat.ts` | compact wire shape, encode/decode, id sequencer, `SeenSet` |
| `mesh-core/src/rateLimiter.ts` | token bucket, standing→lane mapping, `PerPeerRateLimiter` |
| `mesh-core/src/peer.ts` | the `uc` Trystero action (`sendUserChat`/`onUserChat`) |
| `mesh-react/src/useUserChat.ts` | the hook: peer + safety + rate-limit + dedup + compression stats |
| `apps/chat/src/components/RoomChatPanel.tsx` | the Room surface + People roster |
| `apps/chat/src/App.tsx` | Assistant/Room tab wiring |

## Tests

- **Unit** (`mesh-core/test/`): `rateLimiter.test.ts` (token bucket, standing
  gating, burst/refill on a mock clock, flood drop, per-peer isolation),
  `chatCompression.test.ts` (round-trip, self-describing tag, wrong-dict
  rejection, measured ratios), `userChat.test.ts` (wire round-trip with
  transport-injected identity/time, id sequencing, dedup/replay).
- **e2e** (`apps/chat/e2e/user-chat.spec.ts`): two real browser peers over the
  real mesh exchange room messages that render on both, compression is exercised
  on the wire (wire bytes < raw bytes), and a flood is throttled.

## Follow-up: dict-zstd

The compression is fully behind `compressChatBytes` / `decompressChatBytes` with
a one-byte codec tag, so moving from dict-deflate to true dict-zstd is additive:
allocate a new tag (`0x02 = dict-zstd`), have the encoder prefer it when a zstd
codec is present, and keep decoding both. The corpus + `buildChatDict` already
produce a training set in the exact on-wire framing, ready to feed the Codec
repo's `train-zstd-dict` tooling. Node 22+/24 ship native `zlib.zstdCompressSync`
(with a dictionary parameter) and Chrome ships `CompressionStream('zstd')`; the
one missing portable piece is browser **dict**-zstd, which a small WASM zstd
build or a future `CompressionStream` dictionary option would close. Deferred so
this PR ships a complete, measured, portable win rather than a
platform-conditional one.
