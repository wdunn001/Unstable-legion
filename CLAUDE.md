# CLAUDE.md

Project guidance for Claude Code lives in **[AGENTS.md](AGENTS.md)** and the
**[`.cursor/rules/`](.cursor/rules/)** directory (the source of truth for this
project's concerns and patterns — shared with Cursor so both stay in sync). Read
those first; this file is just the fast path.

## The one-liner

Unstable Legion is ONE Qwen3-8B **split across browser tabs** (pipeline
parallelism over WebRTC — activations on the wire, not a chatbot per peer). See
[`.cursor/rules/architecture.mdc`](.cursor/rules/architecture.mdc).

## Don't-get-burned checklist

- **Guards stay additive** — never hard-require a wire field a slightly-older
  peer might omit; it drops the peer from the whole mesh. Default at ingestion.
  → [`.cursor/rules/mesh-protocol.mdc`](.cursor/rules/mesh-protocol.mdc)
- **Empty ICE states = dead signaling (MQTT), not TURN.** Signaling is upstream;
  diagnose it first. `window.__legionIce` / `window.__legionChat` are your probes.
- **Self-hosted infra only** — no third-party STUN/MQTT brokers; signaling
  (`signal.quasarke.net` MQTT/WSS) + TURN (`51.81.33.184` coturn) are off-ISP.
  Mind split-horizon DNS. → [`.cursor/rules/infra-and-deploy.mdc`](.cursor/rules/infra-and-deploy.mdc)
- **Deploy:** `.env` must bake `VITE_TURN_*` + `VITE_RELAY_URLS`; run
  `scripts/verify-turn-baked.sh`; a missing `.env` fails silently.
- **Rebuild `mesh-core` dist** after `src` edits; add a `node:test` regression
  with every guard/planner change.
- **Commit to GitHub `main`** (Forgejo = read-only mirror), **no Claude
  attribution**, **persist host/infra changes to homelab IaC** same task.
- Nothing is done until committed, merged, deployed, and verified live.

Full conventions: [`.cursor/rules/conventions.mdc`](.cursor/rules/conventions.mdc).
