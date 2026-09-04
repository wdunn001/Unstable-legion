# Trust model: what "communal" actually means for your messages

Unstable Legion's chat app (`apps/chat`) is a peer-to-peer mesh. It runs
with no hosted service behind it. This document is the canonical statement of what that
means for anyone typing a message into it. The exact wording below is
also shown in-product, verbatim, before a user's first message (the
"trust interstitial", `apps/chat/src/components/TrustInterstitial.tsx`)
and is re-shown whenever the set of peers hosting your chat changes.
Both the app and this document read from one source of truth
(`apps/chat/src/trustStatement.ts`) so they can never drift apart.

> Unstable Legion runs on a peer-to-peer mesh. No company’s servers sit
> behind it. When you send a message, it is processed by other members’
> computers. Volunteers contribute part of their machine to help run this
> model.
>
> The activations that pass through a volunteer’s computer can be
> reconstructed into the text you typed and the text you receive. Treat
> everything you type here as readable by the room’s hosts.
>
> A malicious host could also alter the reply before it reaches you.
> There is no cryptographic guarantee against this today.
>
> Do not share secrets, passwords, private keys, or anything you would
> not want a stranger to read.

## Why this is the honest claim, without a hedge

The communal pipeline (see `docs/COMMUNAL.md`) splits Qwen3-8B's layers
across whichever peers are currently online and willing to host. Your
prompt is tokenized locally, but every layer past the first
`STAGE_DRIVER_LAYERS` is computed on someone else's browser tab as a
plaintext-adjacent activation tensor. `stageFrameEnvelope.ts`'s wire
format is efficient. It carries no encryption, and no peer in this mesh has been
vetted. Any host on the current route can:

- **Read**: the activation a host processes is deterministically
  invertible toward the original tokens with enough effort; there is no
  cryptographic barrier stopping a host from doing so. "Readable by
  hosts" is therefore the correct claim. It is a stronger claim than "theoretically could leak
  under an attack": assume every host on your route CAN read your
  message. Nothing prevents it.
- **Tamper**: a host computing your final layers could return an
  activation that decodes to a different reply than the model would
  have honestly produced. Nothing downstream currently detects this.

This repo has no anti-Sybil, attestation, or encryption story yet (see
`docs/ECONOMY.md`'s "LOCAL-ONLY" note on `StandingLedger`: standing is
a private, per-driver reputation signal. It is no trust or safety
mechanism). Framing the mesh as anything more private than "readable by
whoever is currently hosting your route" would be a false claim.

## Thin drivers: an EXTRA privacy cost, stated plainly

A device with no usable WebGPU can't compute even the first stage locally
(see `docs/OPTIONAL-STAGE0.md`). It runs as a **thin driver**: it ships its
**raw token-ids** (trivially the text you typed) to a remote *isFirst*
host. That host does the embedding + first layers your own computer would
normally do privately.

This is **strictly weaker** than the capable path. On a capable device, what
leaves your machine is already an activation tensor (still host-readable with
effort, per above). On a thin device, the very first hop receives your prompt
as tokens it can read directly. No local step stands between your words and
that host at all.

This is not hidden. `trustStatement.ts`'s `THIN_DRIVER_TRUST_ADDENDUM` is
shown **verbatim** in the trust interstitial to any device detected as a thin
driver (`TrustInterstitial`'s `thinDriver` prop), before its first message,
in addition to the four paragraphs above. A thin driver should treat its
prompts as readable by the single first host with even less protection than
the general "readable by the room's hosts" claim already implies.

## Where this is enforced in the product

- **`TrustBadge`**: an always-visible header pill:
  "Community-powered: messages are processed on other members'
  computers." Present on every screen, well beyond the interstitial.
- **`TrustInterstitial`**: blocks the FIRST message in a fresh session
  until acknowledged, and is re-shown whenever
  `useCommunalChat`'s resolved route's remote host set changes from the
  set the user last acknowledged (`trustStatement.ts`'s
  `hostSetKey`/`loadAckedHostSetKey`). A new host joining your route is
  a new set of people who can read your traffic. The notice re-earns
  its acknowledgement on every such change. It never acks silently forever.
- **Hosting consent** (`HostingConsentBanner`) is a SEPARATE decision
  from the trust statement above. Contributing your own GPU to host
  OTHER people's messages doesn't change what THIS device's own outbound
  chat traffic is exposed to. The two prompts are deliberately
  independent (accepting one never silently implies the other).
