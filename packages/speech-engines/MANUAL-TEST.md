# Manual browser verification — speech mesh PoC

Mic capture, WebGPU/wasm engine init, and the actual mesh round-trip
can't run headlessly in this environment. Follow these steps in a real
browser (Chrome/Edge recommended for WebGPU) to verify the PoC end to
end.

## 1. Local (host-own) path — one tab

1. From the repo root: `npm run dev -w @unstable-legion/demo`.
2. Open `http://localhost:5173` (or whatever port Vite prints).
3. Fill in the persona form (any nick) and join.
4. Find the **speech** panel in the dashboard. Toggle **enable ASR
   host** on.
   - Expect the status line to show `initializing…` then an engine id
     like `whisper-base/webgpu` (or `whisper-base/wasm` if WebGPU isn't
     available/enabled in your browser) once the model finishes
     downloading (first run: tens of MB from the HF Hub CDN — watch the
     Network tab if it seems stuck).
5. Click **record** (grant mic permission when prompted). Speak a short
   sentence. Recording auto-stops after ~6s, or click **stop** sooner.
6. Click **transcribe**.
   - Expect the transcript text to appear, the status line to say it
     ran **locally**, and a timing figure (`durationMs`) to show.
7. Sanity check: an obviously-wrong transcript (empty string, or
   garbage unrelated to what you said) means something's broken in the
   decode/engine path, not just ASR being imperfect — Whisper is
   generally intelligible even on a short/noisy clip.

## 2. Mesh path — two tabs

1. With the first tab still running from step 1 (ASR host **enabled**),
   open a second tab/window to the same demo URL, same room (default
   room unless you passed `?room=`).
2. Join with a different nick in the second tab. Leave its ASR host
   toggle **off**.
3. In the second tab's roster panel, confirm the first tab's peer shows
   up and its advertised skills include `asr.transcribe` (roster entries
   surface `skills[]`/`tools[]` from `cap`).
4. In the second tab's speech panel, record a clip and click
   **transcribe**.
   - Expect: no local ASR host on this tab, so `useSpeechClient` should
     route the call to the first tab's peer over `tc` (`callTool(peerId,
     'transcribe', args)`).
   - Expect the status line to say it ran **via** the first tab's peer
     id (or nick, however `SpeechPanel` labels it), the transcript text
     to appear, and a timing figure that includes the WebRTC round trip
     (should be noticeably larger than the local-path timing from step
     1, but still on the order of the engine's own transcribe time plus
     network — not many seconds unless a cold model load is happening
     on the host side too).
5. Turn the first tab's ASR host toggle off, then repeat step 4's record
   + transcribe in the second tab. Expect a clear "no ASR peer available"
   error instead of a silent hang or crash — confirms `useSpeechClient`'s
   no-target error path.

## 3. Chat app (apps/chat) — voice INPUT in the composer

The demo's `SpeechPanel` above is the dev harness; `apps/chat` is the
product surface (legion.codecai.net). This is voice INPUT only: mic →
transcript dropped into the composer textarea. No auto-send, no TTS, no
LLM-loop change — the user still hits Send/Enter themselves.

### 3a. Local (host-own) path — one tab

1. From the repo root: `npm run dev -w @unstable-legion/chat`.
2. Open `http://localhost:5174` (or whatever port Vite prints), pick a
   nick, join.
3. In the right-hand mesh sidebar's **Tool contributions** card, scroll to
   the bottom and toggle **🎤 Host speech-to-text (uses your GPU)** on.
   - Expect `initializing (downloading model on first use)…` while the
     Whisper worker loads, then the status line clears once ready (no
     error line).
4. In the composer (bottom of the chat pane), the mic button (🎤) should
   now be enabled — hover it to confirm the tooltip reads "Speak your
   message" rather than the disabled-reachability tooltip.
5. Click the mic button, grant mic permission if prompted, speak a short
   sentence. Click it again to stop (or wait for the 30s auto-stop).
   - Expect the button to show a recording indicator while capturing,
     then `transcribing…` briefly.
6. Expect the transcript text to land in the composer textarea (replacing
   placeholder text, appended after any text you'd already typed) and the
   textarea to be focused — verify nothing was auto-sent.
7. Toggle ASR host back off and confirm the mic button becomes disabled
   again (tooltip: "Enable Host speech-to-text, or wait for a peer that
   offers it") once no peer advertises `asr.transcribe` either.

### 3b. Mesh path — two tabs

1. Tab A: as in 3a, enable **Host speech-to-text**, leave it ready.
2. Tab B: open the same chat URL/room with a different nick, leave its
   ASR host toggle **off**.
3. In Tab B, the composer's mic button should become enabled once Tab A's
   peer roster entry shows up (advertising `asr.transcribe` — Tab B has
   no local host, so `useSpeechClient` resolves to Tab A's peer via
   `callTool`).
4. Record + stop in Tab B. Expect the transcript to land in Tab B's
   composer textarea after a brief mesh round trip (slower than the local
   path in 3a, but not multi-second under normal conditions).
5. Turn Tab A's host toggle off, then try recording in Tab B again.
   Expect the mic button to go back to disabled once the roster updates
   (no local host, no remote advertiser) — rather than a silent hang.
6. Mic-permission-denied check: in either tab, deny the browser's mic
   permission prompt (or revoke it beforehand) and click the mic button.
   Expect a visible "Mic error: …" line under the composer, not a silent
   no-op.

## 4. Chat app (apps/chat) — voice OUTPUT: 🔊 speak an assistant reply

TTS is the reverse-direction twin of section 3 — text → Kokoro → audio,
manual "speak" button on each assistant bubble. Auto-speak (replies read
aloud with no button click) is covered separately in section 5.

As of the rolling/chunked-TTS increment, `useTtsSpeaker` (not a bare
`useTtsClient` + `useAudioPlayback` pair) drives the 🔊 button: it splits
the speakable text into sentence-sized chunks via `splitForTts` (each
safely under Kokoro-82M's ~510-phoneme-token context limit), synthesizes
them ONE AT A TIME (the Kokoro worker isn't re-entrant), but does NOT wait
for a chunk to finish PLAYING before starting the NEXT chunk's synth — so
the first chunk starts playing while later chunks are still being
synthesized. This fixes long replies overflowing Kokoro's context and cuts
latency-to-first-audio versus synthesizing the whole reply in one call.

### 4a. Local (host-own) path — one tab

1. From the repo root: `npm run dev -w @unstable-legion/chat`.
2. Open the dev URL, pick a nick, join.
3. In the right-hand mesh sidebar's **Tool contributions** card, below the
   ASR toggle, switch on **🔊 Host text-to-speech (uses your GPU)**.
   - Expect `initializing (downloading model on first use)…` while the
     Kokoro worker loads (first run: tens of MB from the HF Hub CDN),
     then the status line clears once ready (no error line).
4. Send a message so the model produces an assistant reply.
5. On the assistant's message bubble, a 🔊 button should now be enabled
   (hover: tooltip reads "Speak this reply aloud" rather than the
   disabled-reachability tooltip).
6. Click it. Expect the button to switch to an ⏹ state while
   synthesizing/speaking, then audio plays back through your
   speakers/headphones once the first chunk is ready. Check the browser
   console for `[legion-speech]` lines: `speak: N chunk(s)`, then per-chunk
   `synth start`/`synth done` pairs, then a final `speak: done`. For a
   multi-chunk reply, chunk 2's `synth start` should log almost
   immediately after chunk 1's `synth done` — i.e. chunk 2 starts
   synthesizing while chunk 1 is still audibly playing, not after chunk
   1's audio finishes. That overlap is the latency-to-first-audio win.
7. **Long-reply test (the actual bug fix)**: ask a question that yields a
   long, multi-paragraph reply (e.g. "explain how TCP congestion control
   works in detail, with examples" or similar). Click 🔊.
   - Expect the WHOLE reply to be read aloud, not truncated partway
     through and not erroring out — this is the overflow Kokoro's
     ~510-token context previously hit on a single big `synthesize()`
     call. A slight gap between chunk boundaries (sentence/clause breaks)
     is fine and expected; garbled audio, a cut-off reply, or a console
     error is not.
   - Check the console log's chunk count (`speak: N chunk(s)`) is > 1 for
     a genuinely long reply, confirming `splitForTts` actually split it.
8. **Stop-toggle test**: click 🔊 again while it's mid-speech (⏹ showing).
   Expect playback to stop promptly (not finish the current chunk, and
   definitely not keep going through the remaining queued chunks) and the
   button to return to its idle 🔊 state. Click 🔊 once more afterward and
   confirm it starts a fresh read from the beginning (not from where it
   left off — this is a stop, not a pause).
9. Click 🔊 on a second assistant reply while the first is still speaking
   (without using the stop toggle first). Expect the first message's
   speech to keep going uninterrupted and an independent listen to start
   for whichever is clicked — actually: this pane shares ONE
   `useTtsSpeaker` instance, so starting a second `speak()` call reuses the
   same synth/playback pipeline; expect the second message's audio to
   queue in gaplessly after the first's chunks finish, not overlap/garble
   — confirming `useAudioPlayback`'s serial queue still holds across
   messages, not just across one message's chunks.
10. Toggle TTS host back off and confirm the 🔊 buttons go back to
    disabled (tooltip: "Enable Host text-to-speech, or wait for a peer
    that offers it") once no peer advertises `tts.synthesize` either.

### 4b. Mesh path — two tabs

1. Tab A: as in 4a, enable **Host text-to-speech**, leave it ready.
2. Tab B: open the same chat URL/room with a different nick, leave its
   TTS host toggle **off**. Send/receive at least one assistant reply in
   Tab B so it has a message to speak.
3. In Tab B, an assistant message's 🔊 button should become enabled once
   Tab A's peer roster entry shows up (advertising `tts.synthesize`) —
   Tab B has no local host, so `useTtsSpeaker`'s internal `useTtsClient`
   resolves to Tab A's peer via `callTool`, once per chunk.
4. Click 🔊 in Tab B. Expect audio to play back in Tab B after a brief
   mesh round trip per chunk (slower than the local path in 4a, but not
   multi-second under normal conditions) — each chunk's synthesized WAV
   travels Tab A → Tab B over `tc` as base64, one `tts.synthesize` call per
   chunk, then Tab B decodes + plays it. A long reply in Tab B should still
   read in full, same as the local-path long-reply test in 4a step 7.
5. Turn Tab A's host toggle off, then click 🔊 in Tab B again. Expect a
   visible "Speak failed: …" notice instead of a silent hang — confirms
   `useTtsClient`'s no-target error path still surfaces through
   `useTtsSpeaker`.

## 5. Chat app (apps/chat) — auto-speak: hands-free reply playback

Increment 2 of the voice-conversation layer: when **🗣 Auto-speak replies**
is on, each assistant reply is spoken automatically the moment it finishes
streaming — no 🔊 click. This is a CONSUMPTION preference, independent of
whether this tab hosts TTS (`useTtsSpeaker` resolves local-vs-mesh the same
way either way; `🗣 Auto-speak replies` is usable whenever ANY TTS target is
reachable, not gated on this tab's own `🔊 Host text-to-speech` toggle).

1. From the repo root: `npm run dev -w @unstable-legion/chat`.
2. Open the dev URL, pick a nick, join.
3. Get a TTS target reachable — either toggle **🔊 Host text-to-speech** on
   in this same tab (wait for it to finish initializing), or open a second
   tab/nick in the same room and enable its host toggle instead (leave this
   tab's host toggle off, to specifically exercise the mesh-routed case).
4. In the **Tool contributions** card, toggle **🗣 Auto-speak replies** on.
   - If no TTS target is reachable yet, expect a "needs a TTS host on the
     mesh" hint under the toggle; it should disappear once step 3's host
     becomes ready/visible in the roster.
5. Send a message. Expect: once the reply finishes streaming (composer
   re-enables / the ⏹ spinner clears), the assistant bubble's 🔊 button
   flips to its ⏹ (speaking) state ON ITS OWN — no click — and audio plays.
   Console should show the same `[legion-speech] speak: N chunk(s)` /
   `synth start`/`synth done` / `speak: done` lines as the manual path.
6. **No re-speak / no history replay**: reload the page (or switch to a
   different thread and back). Confirm OLD replies do NOT speak on load —
   auto-speak fires only on a genuine streaming→done transition, never on
   mount.
7. **No speak on user messages**: confirm sending a message doesn't trigger
   any auto-speech until the ASSISTANT's reply comes back (the user's own
   bubble should never get an auto-🔊).
8. **Supersede test (the concurrency fix)**: send a message, and the moment
   its reply starts auto-speaking, send a SECOND message before the first
   finishes talking. Expect: the first reply's audio stops promptly (not a
   graceful fade, not finishing its current chunk) the instant the second
   reply finishes streaming and takes over — the first bubble's 🔊 flips
   back to idle, the second bubble's flips to ⏹, and only the second
   reply's audio plays (no overlap/garble of the two). This exercises
   `useTtsSpeaker`'s generation-counter fix: a NEW `speak()` call safely
   cancels an in-flight one instead of the two racing on the same Kokoro
   engine.
9. **Manual stop still works**: with auto-speak on, let a reply start
   auto-speaking, then click its 🔊 (now showing ⏹) to stop it manually.
   Expect playback to stop immediately and the button to return to idle —
   same as the manual-only behavior in section 4.
10. **Manual 🔊 on a DIFFERENT (older) message while auto-speak is on**:
    click 🔊 on an earlier reply while a fresh reply is auto-speaking.
    Expect the same supersede behavior as step 8 (older/auto audio stops,
    clicked message's audio plays) — manual and auto-speak share the one
    `useTtsSpeaker` instance, so they supersede each other exactly like two
    auto-speaks would.
11. Toggle **🗣 Auto-speak replies** off. Send another message and let it
    finish streaming. Expect: silence — no automatic playback — while the
    manual 🔊 button on that same reply still works when clicked.

## Known limitations to note while testing (not bugs)

- First model load per browser profile is slow (network fetch); repeat
  runs in the same tab/profile should be fast (Cache Storage hit).
- WebGPU device selection depends on the browser/flags; a `wasm`
  fallback is expected and fine for this PoC — note whichever the
  status line reports.
- No COOP/COEP headers are wired into the demo's dev server yet, so the
  wasm fallback runs single-threaded (slower, still correct). See the
  package README's "COOP/COEP" section.
- The recording is capped at ~6s by default (`useMicCapture`'s
  `maxMs`) in apps/demo's SpeechPanel — long dictation isn't the point of
  that PoC. apps/chat's Composer passes `maxMs: 30_000` since a real chat
  message is often longer than a 6s clip.
- Kokoro's ONNX weights are a separate lazy-loaded download from
  Whisper's — enabling both ASR host and TTS host in the same tab
  downloads both models (each only on its own toggle-on, not upfront).
- The `kokoro-js` bundle chunk measured ~1.33 MB minified in a real
  `vite build` (see this package's README for the matching ASR-side
  `transformers.web`/onnxruntime-web numbers) — code-split so it only
  loads when the TTS host toggle is switched on.
