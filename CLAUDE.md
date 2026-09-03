# CLAUDE.md

Project guidance for Claude Code lives in **[AGENTS.md](AGENTS.md)** and the
**[`.cursor/rules/`](.cursor/rules/)** directory (the source of truth for this
project's concerns and patterns. It is shared with Cursor so both stay in sync). Read
those first; this file is just the fast path.

## The one-liner

Unstable Legion is ONE Qwen3-8B **split across browser tabs** using pipeline
parallelism over WebRTC. Activations move on the wire between peers. See
[`.cursor/rules/architecture.mdc`](.cursor/rules/architecture.mdc).

## Don't-get-burned checklist

- **Guards stay additive**: never hard-require a wire field a slightly-older
  peer might omit; it drops the peer from the whole mesh. Default at ingestion.
  → [`.cursor/rules/mesh-protocol.mdc`](.cursor/rules/mesh-protocol.mdc)
- **Empty ICE states mean dead signaling (MQTT).** Signaling sits upstream of TURN;
  diagnose it first. `window.__legionIce` / `window.__legionChat` are your probes.
- **Self-hosted infra only**: no third-party STUN/MQTT brokers. Signaling
  (MQTT/WSS) + TURN (coturn) come from `VITE_RELAY_URLS` / `VITE_TURN_*`; host
  them off-ISP. Deployment topology lives in the private IaC, never here. This
  repo is public. → [`.cursor/rules/infra-and-deploy.mdc`](.cursor/rules/infra-and-deploy.mdc)
- **Deploy:** `.env` must bake `VITE_TURN_*` + `VITE_RELAY_URLS`; run
  `scripts/verify-turn-baked.sh`; a missing `.env` fails silently.
- **Rebuild `mesh-core` dist** after `src` edits; add a `node:test` regression
  with every guard/planner change.
- **Commit to GitHub `main`** (Forgejo = read-only mirror), **no Claude
  attribution**, **persist host/infra changes to homelab IaC** same task.
- Nothing is done until committed, merged, deployed, and verified live.

Full conventions: [`.cursor/rules/conventions.mdc`](.cursor/rules/conventions.mdc).
