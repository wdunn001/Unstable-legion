# AGENTS.md — Unstable Legion

Guidance for AI coding agents (Cursor, Claude Code, Codex, etc.) working in this
repo. **The detailed concerns and patterns live in [`.cursor/rules/`](.cursor/rules/)**
— this file orients you and points there; that directory is the source of truth,
kept in sync so Cursor auto-applies it and other agents can read it directly.

## What this project is (read first)

Unstable Legion is ONE Qwen3-8B **split across browser tabs** — pipeline
parallelism over WebRTC, with hidden-state **activations** on the wire, not a
chatbot-per-peer. If you internalize one thing, make it that. Full picture:
[`.cursor/rules/architecture.mdc`](.cursor/rules/architecture.mdc) and `README.md`.

## The rules (concerns + patterns)

| File | Covers |
|------|--------|
| [`.cursor/rules/architecture.mdc`](.cursor/rules/architecture.mdc) | Pipeline-split model, drivers/hosts, key modules, **resilience gaps** to not regress |
| [`.cursor/rules/mesh-protocol.mdc`](.cursor/rules/mesh-protocol.mdc) | Wire actions, runtime guards, the **additive-versioning idiom** (load-bearing), runtime debugging |
| [`.cursor/rules/infra-and-deploy.mdc`](.cursor/rules/infra-and-deploy.mdc) | Self-hosted signaling + TURN (**no third-party**), split-horizon DNS, deploy pipeline, IaC persistence |
| [`.cursor/rules/conventions.mdc`](.cursor/rules/conventions.mdc) | Code/test/commit conventions, product decisions not to casually reverse |

## Top concerns (the ones that bite)

1. **Guards must stay additive.** A too-strict guard drops a version-skewed peer
   from the whole mesh. New fields optional; default at ingestion. (mesh-protocol)
2. **Signaling is upstream of ICE/TURN.** Empty ICE-state connections = discovery
   (MQTT signaling) is dead, not TURN. Diagnose signaling first. (mesh-protocol)
3. **No third-party STUN / MQTT brokers** — self-hosted off-ISP only. (infra)
4. **`.env` must bake TURN + relay** at build; a missing `.env` silently ships a
   broken bundle. Run `scripts/verify-turn-baked.sh`. (infra)
5. **Commit to GitHub `main`** (Forgejo is a read-only mirror); **no AI
   attribution**; **persist host changes to homelab IaC**. (conventions)
6. **Rebuild `mesh-core` dist** after editing its `src` before apps consume it.

## Quick commands

```bash
npm run test -w @unstable-legion/core     # unit tests (node:test)
npm run build -w @unstable-legion/core    # rebuild dist after src edits
# deploy: see .cursor/rules/infra-and-deploy.mdc (manual, .198 edge)
```
