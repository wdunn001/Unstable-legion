# Manual browser verification: speech mesh PoC

Mic capture, WebGPU/wasm engine init, and the actual mesh round-trip
can't run headlessly in this environment. Follow these steps in a real
browser (Chrome/Edge recommended for WebGPU) to verify the PoC end to
end.

## 1. Local (host-own) path: one tab

1. From the repo root: `npm run dev -w @unstable-legion/demo`.
2. Open `http://localhost:5173` (or whatever port Vite prints).
3. Fill in the persona form (any nick) and join.
4. Find the **speech** panel in the dashboard. Toggle **enable ASR
   host** on.
   - Expect the status line to show `initializing…` then an engine id
     like `whisper-base/webgpu` (or `whisper-base/wasm` if WebGPU isn't
     available/enabled in your browser) once the model finishes
     downloading. First-run downloads pull tens of MB from the HF Hub CDN.
     Watch the Network tab if it seems stuck.
5. Click **record** (grant mic permission when prompted). Speak a short
   sentence. Recording auto-stops after ~6s, or click **stop** sooner.
6. Click **transcribe**.
   - Expect the transcript text to appear, the status line to say it
     ran **locally**, and a timing figure (`durationMs`) to show.
7. Sanity check: an obviously-wrong transcript (empty string, or
   garbage unrelated to what you said) means something is broken in the
   decode/engine path. Whisper stays generally intelligible even on a
   short or noisy clip. A bad transcript there is a real bug signal.

## 2. Mesh path: two tabs

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
   - Expect: no local ASR host on this tab. `useSpeechClient` should
     route the call to the first tab's peer over `tc` (`callTool(peerId,
     'transcribe', args)`).
   - Expect the status line to say it ran **via** the first tab's peer
     id (or nick, however `SpeechPanel` labels it), the transcript text
     to appear, and a timing figure that includes the WebRTC round trip
     (should be noticeably larger than the local-path timing from step
     1, but still on the order of the engine's own transcribe time plus
     network. It should not take many seconds unless a cold model load
     is happening on the host side too).
5. Turn the first tab's ASR host toggle off, then repeat step 4's record
   + transcribe in the second tab. Expect a clear "no ASR peer available"
   error. This confirms `useSpeechClient`'s no-target error path avoids a
   silent hang or crash.

## 3. Chat app (apps/chat): voice INPUT in the composer

The demo's `SpeechPanel` above is the dev harness; `apps/chat` is the
product surface (legion.codecai.net). This is voice INPUT only: mic →
transcript dropped into the composer textarea. No auto-send, no TTS, no
LLM-loop change. The user still hits Send/Enter themselves.

### 3a. Local (host-own) path: one tab

1. From the repo root: `npm run dev -w @unstable-legion/chat`.
2. Open `http://localhost:5174` (or whatever port Vite prints), pick a
   nick, join.
3. In the right-hand mesh sidebar's **Tool contributions** card, scroll to
   the bottom and toggle **🎤 Host speech-to-text (uses your GPU)** on.
   - Expect `initializing (downloading model on first use)…` while the
     Whisper worker loads, then the status line clears once ready (no
     error line).
4. In the composer (bottom of the chat pane), the mic button (🎤) should
   now be enabled. Hover it to confirm the tooltip now reads "Speak your
   message", with the disabled-reachability tooltip gone.
5. Click the mic button, grant mic permission if prompted, speak a short
   sentence. Click it again to stop (or wait for the 30s auto-stop).
   - Expect the button to show a recording indicator while capturing,
     then `transcribing…` briefly.
6. Expect the transcript text to land in the composer textarea (replacing
   placeholder text, appended after any text you'd already typed) and the
   textarea to be focused. Verify nothing was auto-sent.
7. Toggle ASR host back off and confirm the mic button becomes disabled
   again (tooltip: "Enable Host speech-to-text, or wait for a peer that
   offers it") once no peer advertises `asr.transcribe` either.

### 3b. Mesh path: two tabs

1. Tab A: as in 3a, enable **Host speech-to-text**, leave it ready.
2. Tab B: open the same chat URL/room with a different nick, leave its
   ASR host toggle **off**.
3. In Tab B, the composer's mic button should become enabled once Tab A's
   peer roster entry shows up, advertising `asr.transcribe`. Tab B has
   no local host. `useSpeechClient` resolves to Tab A's peer via
   `callTool`.
4. Record + stop in Tab B. Expect the transcript to land in Tab B's
   composer textarea after a brief mesh round trip (slower than the local
   path in 3a, but not multi-second under normal conditions).
5. Turn Tab A's host toggle off, then try recording in Tab B again.
   Expect the mic button to go back to disabled once the roster updates
   (no local host, no remote advertiser). No silent hang should occur.
6. Mic-permission-denied check: in either tab, deny the browser's mic
   permission prompt (or revoke it beforehand) and click the mic button.
   Expect a visible "Mic error: …" line under the composer. The composer
   must not silently no-op.

## 4. Chat app (apps/chat): voice OUTPUT: 🔊 speak an assistant reply

TTS is the reverse-direction twin of section 3: text → Kokoro → audio,
manual "speak" button on each assistant bubble. Auto-speak (replies read
aloud with no button click) is covered separately in section 5.

As of the rolling/chunked-TTS increment, `useTtsSpeaker` (not a bare
`useTtsClient` + `useAudioPlayback` pair) drives the 🔊 button: it splits
the speakable text into sentence-sized chunks via `splitForTts` (each
safely under Kokoro-82M's ~510-phoneme-token context limit), synthesizes
them ONE AT A TIME (the Kokoro worker isn't re-entrant), but does NOT wait
for a chunk to finish PLAYING before starting the NEXT chunk's synth. The
first chunk starts playing while later chunks are still being
synthesized. This fixes long replies overflowing Kokoro's context and cuts
latency-to-first-audio versus synthesizing the whole reply in one call.

### 4a. Local (host-own) path: one tab

1. From the repo root: `npm run dev -w @unstable-legion/chat`.
2. Open the dev URL, pick a nick, join.
3. In the right-hand mesh sidebar's **Tool contributions** card, below the
   ASR toggle, switch on **🔊 Host text-to-speech (uses your GPU)**.
   - Expect `initializing (downloading model on first use)…` while the
     Kokoro worker loads (first run: tens of MB from the HF Hub CDN),
     then the status line clears once ready (no error line).
4. Send a message so the model produces an assistant reply.
5. On the assistant's message bubble, a 🔊 button should now be enabled
   (hover: tooltip now reads "Speak this reply aloud", with the
   disabled-reachability tooltip gone).
6. Click it. Expect the button to switch to an ⏹ state while
   synthesizing/speaking, then audio plays back through your
   speakers/headphones once the first chunk is ready. Check the browser
   console for `[legion-speech]` lines: `speak: N chunk(s)`, then per-chunk
   `synth start`/`synth done` pairs, then a final `speak: done`. For a
   multi-chunk reply, chunk 2's `synth start` should log almost
   immediately after chunk 1's `synth done`. That means chunk 2 starts
   synthesizing while chunk 1 is still audibly playing, before chunk
   1's audio finishes. That overlap is the latency-to-first-audio win.
7. **Long-reply test (the actual bug fix)**: ask a question that yields a
   long, multi-paragraph reply (e.g. "explain how TCP congestion control
   works in detail, with examples" or similar). Click 🔊.
   - Expect the WHOLE reply to be read aloud, in full, without truncation
     or errors. This is the overflow Kokoro's ~510-token context
     previously hit on a single big `synthesize()` call. A slight gap
     between chunk boundaries (sentence/clause breaks) is fine and
     expected. Garbled audio, a cut-off reply, or a console error counts
     as a failure.
   - Check the console log's chunk count (`speak: N chunk(s)`) is > 1 for
     a genuinely long reply, confirming `splitForTts` actually split it.
8. **Stop-toggle test**: click 🔊 again while it's mid-speech (⏹ showing).
   Expect playback to stop promptly (not finish the current chunk, and
   definitely not keep going through the remaining queued chunks) and the
   button to return to its idle 🔊 state. Click 🔊 once more afterward and
   confirm it starts a fresh read from the beginning. Stopping always
   restarts from scratch. It does not resume.
9. Click 🔊 on a second assistant reply while the first is still speaking,
   without using the stop toggle first. This pane shares ONE
   `useTtsSpeaker` instance. Starting a second `speak()` call reuses the
   same synth/playback pipeline. It does not start an independent listen
   for the newly clicked message. Expect the second message's audio to
   queue in gaplessly after the first's chunks finish, with no overlap or
   garble. This confirms `useAudioPlayback`'s serial queue still holds
   across messages and not only within one message's chunks.
10. Toggle TTS host back off and confirm the 🔊 buttons go back to
    disabled (tooltip: "Enable Host text-to-speech, or wait for a peer
    that offers it") once no peer advertises `tts.synthesize` either.

### 4b. Mesh path: two tabs

1. Tab A: as in 4a, enable **Host text-to-speech**, leave it ready.
2. Tab B: open the same chat URL/room with a different nick, leave its
   TTS host toggle **off**. Send/receive at least one assistant reply in
   Tab B so it has a message to speak.
3. In Tab B, an assistant message's 🔊 button should become enabled once
   Tab A's peer roster entry shows up, advertising `tts.synthesize`. Tab
   B has no local host. `useTtsSpeaker`'s internal `useTtsClient`
   resolves to Tab A's peer via `callTool`, once per chunk.
4. Click 🔊 in Tab B. Expect audio to play back in Tab B after a brief
   mesh round trip per chunk (slower than the local path in 4a, but not
   multi-second under normal conditions). Each chunk's synthesized WAV
   travels Tab A → Tab B over `tc` as base64, one `tts.synthesize` call per
   chunk, then Tab B decodes + plays it. A long reply in Tab B should still
   read in full, same as the local-path long-reply test in 4a step 7.
5. Turn Tab A's host toggle off, then click 🔊 in Tab B again. Expect a
   visible "Speak failed: …" notice. This confirms `useTtsClient`'s
   no-target error path still surfaces through `useTtsSpeaker`, avoiding a
   silent hang.

## 5. Chat app (apps/chat): auto-speak: hands-free reply playback

Increment 2 of the voice-conversation layer: when **🗣 Auto-speak replies**
is on, each assistant reply is spoken automatically the moment it finishes
streaming, with no 🔊 click needed. This is a CONSUMPTION preference,
independent of whether this tab hosts TTS (`useTtsSpeaker` resolves
local-vs-mesh the same way either way; `🗣 Auto-speak replies` is usable
whenever ANY TTS target is reachable, without depending on this tab's own
`🔊 Host text-to-speech` toggle).

1. From the repo root: `npm run dev -w @unstable-legion/chat`.
2. Open the dev URL, pick a nick, join.
3. Get a TTS target reachable. Either toggle **🔊 Host text-to-speech** on
   in this same tab (wait for it to finish initializing), or open a second
   tab/nick in the same room and enable its host toggle (leave this
   tab's host toggle off, to specifically exercise the mesh-routed case).
4. In the **Tool contributions** card, toggle **🗣 Auto-speak replies** on.
   - If no TTS target is reachable yet, expect a "needs a TTS host on the
     mesh" hint under the toggle; it should disappear once step 3's host
     becomes ready/visible in the roster.
5. Send a message. Expect: once the reply finishes streaming (composer
   re-enables / the ⏹ spinner clears), the assistant bubble's 🔊 button
   flips to its ⏹ (speaking) state ON ITS OWN (no click) and audio plays.
   Console should show the same `[legion-speech] speak: N chunk(s)` /
   `synth start`/`synth done` / `speak: done` lines as the manual path.
6. **No re-speak / no history replay**: reload the page (or switch to a
   different thread and back). Confirm OLD replies do NOT speak on load.
   Auto-speak fires only on a genuine streaming→done transition, never on
   mount.
7. **No speak on user messages**: confirm sending a message doesn't trigger
   any auto-speech until the ASSISTANT's reply comes back (the user's own
   bubble should never get an auto-🔊).
8. **Supersede test (the concurrency fix)**: send a message, and the moment
   its reply starts auto-speaking, send a SECOND message before the first
   finishes talking. Expect: the first reply's audio stops promptly and
   abruptly, with no graceful fade and no finishing of its current chunk,
   the instant the second reply finishes streaming and takes over. The
   first bubble's 🔊 flips back to idle, the second bubble's flips to ⏹,
   and only the second reply's audio plays (no overlap/garble of the two).
   This exercises `useTtsSpeaker`'s generation-counter fix: a NEW
   `speak()` call safely cancels an in-flight one, keeping the two from
   racing on the same Kokoro engine.
9. **Manual stop still works**: with auto-speak on, let a reply start
   auto-speaking, then click its 🔊 (now showing ⏹) to stop it manually.
   Expect playback to stop immediately and the button to return to idle,
   the same as the manual-only behavior in section 4.
10. **Manual 🔊 on a DIFFERENT (older) message while auto-speak is on**:
    click 🔊 on an earlier reply while a fresh reply is auto-speaking.
    Expect the same supersede behavior as step 8 (older/auto audio stops,
    clicked message's audio plays). Manual and auto-speak share the one
    `useTtsSpeaker` instance. They supersede each other exactly like two
    auto-speaks would.
11. Toggle **🗣 Auto-speak replies** off. Send another message and let it
    finish streaming. Expect: silence (no automatic playback) while the
    manual 🔊 button on that same reply still works when clicked.

## 6. Chat app (apps/chat): VAD "open mic": hands-free continuous listening

Increment 3a of the voice-conversation layer: the **🎙 Listen** toggle next
to the composer's push-to-talk mic button. When on, a Silero VAD model
(`@ricky0123/vad-web`, running fully client-side: see
`useVadListen.ts`'s module doc for the worklet/model/wasm asset-hosting
story) continuously watches the mic, segments each utterance on its own
(no button hold needed), and transcribes it through the SAME ASR path
push-to-talk uses (local host first, else a roster peer advertising
`asr.transcribe`). Text is APPENDED into the composer textarea as each
utterance resolves. There is no auto-send (that's increment 3c) and no
wake word (3b): this is pure continuous-listening-to-text.

### 6a. Local (host-own) path: one tab

1. From the repo root: `npm run dev -w @unstable-legion/chat`.
2. Open the dev URL, pick a nick, join.
3. In the **Tool contributions** card, toggle **🎤 Host speech-to-text**
   on and wait for it to finish initializing (same as section 3a).
4. In the composer, the **🎙 Listen** button (next to the 🎤 push-to-talk
   button) should now be enabled. Hover it to confirm the tooltip now
   reads "Start hands-free listening…", with the disabled-reachability
   tooltip gone.
5. Click **🎙 Listen**. Grant mic permission if prompted. Expect the
   button to switch to a pulsing **📡 listening…** state. This is a
   CONTINUOUS stream: nothing else needs clicking.
6. Speak one short sentence, then pause for a beat. Expect: shortly after
   you stop talking, the transcript appears in the composer textarea by
   itself (no button press) and the textarea gets focus. Check the
   browser console for `[legion-speech] vad:` lines: `speech-start`, then
   `speech-end (N samples)`, then `transcript "…"`.
7. Speak a SECOND sentence after a pause (with **🎙 Listen** still on).
   Expect: a second, separate transcript segment gets APPENDED after the
   first (space-joined), each utterance kept as its own distinct segment.
   This confirms each VAD-detected utterance produces its own transcribe
   call and append, in order.
8. **Rapid-fire test (the serialization fix)**: speak two short sentences
   back-to-back with only a brief pause between them (short enough that
   the first utterance's transcribe call may still be in flight when the
   second `speech-end` fires). Expect BOTH transcripts to eventually
   appear, in the correct order, with no dropped, garbled, or interleaved
   text. This confirms `useVadListen`'s transcribe queue serializes calls
   onto the single ASR engine, avoiding overlap.
9. **Misfire check**: make a very short, quiet sound (a cough, a quick
   "uh"), short enough that Silero VAD may treat it as a misfire. Expect
   either nothing to happen, or (if it was long enough to count as an
   utterance) a short or garbage transcript. A crash or a stuck
   "listening" state would be a failure. Console may show a `vad: misfire`
   line for the discarded case.
10. Click **🎙 Listen** again to toggle it off. Expect the button to
    return to its idle **🎙 Listen** state and the mic to actually be
    released (browser's mic-in-use indicator, if your OS/browser shows
    one, should turn off). This confirms `MicVAD.pause()` + `.destroy()`
    actually ran, beyond just a UI state flip.
11. Toggle **🎤 Host speech-to-text** off (with **🎙 Listen** still
    logically "on" if you didn't click it off in step 10). Expect
    **🎙 Listen** to automatically flip back to its idle/disabled state
    once no ASR target is reachable. It should not stay stuck spinning
    with an open mic stream and nowhere to send transcripts.

### 6b. Mesh path: two tabs

1. Tab A: enable **🎤 Host speech-to-text**, leave it ready.
2. Tab B: open the same chat URL/room with a different nick, leave its
   ASR host toggle **off**.
3. In Tab B, the composer's **🎙 Listen** button should become enabled
   once Tab A's peer roster entry shows up (advertising `asr.transcribe`),
   the same reachability gate the push-to-talk mic button uses.
4. Click **🎙 Listen** in Tab B, speak a sentence. Expect the transcript
   to land in Tab B's composer after a brief mesh round trip (slower than
   the local path in 6a, but not multi-second under normal conditions).
   Each utterance's WAV clip travels Tab B → Tab A over `tc` as base64,
   one `asr.transcribe` call per utterance, the same framing the
   push-to-talk mic path already uses.
5. Turn Tab A's host toggle off while Tab B's **🎙 Listen** is still on.
   Expect **🎙 Listen** in Tab B to turn itself off once the roster drops
   Tab A's `asr.transcribe` advertisement (same auto-off behavior as 6a
   step 11). It should not silently swallow utterances into a dead
   target.
6. Mic-permission-denied check: in either tab (fresh permission state),
   click **🎙 Listen**. Expect a visible "Listen failed: …" line under
   the composer, with no silent no-op and no button stuck showing
   **📡 listening…** with no working mic behind it.

### 6c. Push-to-talk + Listen coexistence

1. With **🎙 Listen** on and actively listening, click the push-to-talk
   🎤 button and record a short clip the normal way, then let it
   transcribe. Expect both paths to work independently. The
   push-to-talk clip's transcript appends into the composer via its own
   `useSpeechClient` instance, and **🎙 Listen** keeps running
   uninterrupted (still shows **📡 listening…**, still segments and
   appends any speech that happens around the push-to-talk recording).
   This is expected, documented behavior: the two features intentionally
   do not disable each other.

## 7. Chat app (apps/chat): Conversation mode: hands-free back-and-forth + barge-in

Increment 3c of the voice-conversation layer: **💬 Conversation mode
(hands-free)**. Turns the mesh chat into an actual spoken conversation:
talk, and it captures your utterance and auto-sends it (no Send click, no
Enter). The mesh replies, the reply auto-speaks, and the mic is listening
again the instant it's done. You can also interrupt (**barge-in**): talking
while it's speaking cuts the TTS short and your words become the next turn.

This is orchestration over already-proven pieces from sections 3 to 6,
combining them into a single flow: continuous VAD (section 6) drives
auto-send in place of appending to the composer, and the EXISTING
auto-speak effect (section 5) is what actually speaks replies. Conversation
mode just forces it on.

**Wake-ear engine note**: as of this increment, conversation mode's VAD
transcribes through a LOCAL Moonshine-tiny model
(`onnx-community/moonshine-tiny-ONNX`, a 5.8M-param model built for fast
voice-command transcription) in place of section 6's Whisper/mesh ASR
path. It runs purely on-device, with no mesh round-trip. This is a
SEPARATE lazy model download from Whisper's, triggered the first time
conversation mode is switched on (watch for a `wake-ear: Moonshine
loading…` status line under the composer, flipping to `wake-ear:
Moonshine (local)` once ready: see step 4a below). Manual push-to-talk
(🎤) and the manual **🎙 Listen** toggle (section 6) are UNCHANGED. They
still transcribe through Whisper, locally-hosted or mesh, exactly as
before. If Moonshine fails to load (or errors on a transcribe call),
conversation mode automatically falls back to the same mesh/Whisper path
section 6 uses. The status line should read `wake-ear: mesh ASR
(Moonshine failed to load)` in that case, and the hands-free loop below
should keep working, just via Whisper instead.

### 7a. Turning it on: needs BOTH ASR and TTS reachable

1. From the repo root: `npm run dev -w @unstable-legion/chat`. Open the dev
   URL, pick a nick, join.
2. In the **Tool contributions** card, toggle **🎤 Host speech-to-text** and
   **🔊 Host text-to-speech** both on in this same tab (wait for both to
   finish initializing). This is the simplest single-tab setup. (A two-tab
   mesh setup works too, same reachability rule as sections 3/4/6: this tab
   hosting is not required, a roster peer advertising either skill counts.)
3. Toggle **💬 Conversation mode (hands-free)** on.
   - If either ASR or TTS isn't reachable yet, expect a "needs both an ASR
     host and a TTS host on the mesh" hint under the toggle. It should
     clear once both are ready/visible in the roster.
4. Grant mic permission if prompted (this is a NEW `getUserMedia` call,
   separate from section 6's. Expect the browser to ask again even if you
   already granted it for the manual **🎙 Listen** toggle earlier in this
   tab).
4a. Watch for the **wake-ear** status line under the composer (see the
   note above this section): `wake-ear: Moonshine loading…` right after
   toggling conversation mode on, then `wake-ear: Moonshine (local)` once
   the model finishes downloading/initializing (first run: a few MB from
   the HF Hub CDN, much smaller than Whisper's download). Utterances
   spoken before it flips to ready still work. They just fall back to the
   mesh/Whisper path (section 6) until Moonshine is warm.

### 7b. The hands-free loop

5. Speak a short question, then pause. Expect: shortly after you stop
   talking, your message appears in the thread AND SENDS ITSELF. No Send
   click, no Enter, no text sitting in the composer waiting for you. Watch
   the console for `[legion-speech] conversation: auto-send` right before
   it.
6. While the reply streams in, expect NOTHING to happen if you stay quiet.
   This is the GENERATING state; conversation mode is just waiting.
7. The instant the reply finishes streaming, expect it to auto-speak on its
   own (same as section 5's auto-speak, ⏹ showing on the bubble). This is
   forced on by conversation mode even if **🗣 Auto-speak replies** itself is
   off; you should NOT need to also toggle that switch separately.
8. Once the reply finishes speaking, expect the mic to already be
   listening again (no need to click anything). Speak your NEXT question.
   Expect the same loop: auto-send → reply → auto-speak → listening. Do
   this for at least 2-3 turns to confirm the loop actually repeats and
   does not just fire once.

### 7c. Barge-in: interrupting mid-speech

9. Let a reply start auto-speaking (⏹ showing). While it's still talking,
   start speaking over it. Expect the TTS audio to cut off PROMPTLY, with
   no graceful fade-out and no waiting for the current chunk or sentence to
   finish. The console should show
   `[legion-speech] conversation: barge-in — stopping TTS` right as you
   start talking (this fires on VAD's
   `onSpeechStart`, before your utterance even finishes, let alone
   transcribes).
10. Keep talking after the barge-in cuts the audio, then pause. Expect your
    words to be transcribed and auto-sent as the NEXT turn (same as step
    5). A barge-in doesn't just silence the assistant: what you said next
    still becomes your next message.
11. **No accidental drop**: confirm the bubble that got interrupted still
    shows its full text. Barge-in stops only the AUDIO. The reply's
    message content stays unchanged. Playback is the only thing that
    stops.

### 7d. Self-trigger caveat: the reason echoCancellation matters

Conversation mode plays the assistant's reply out of your speakers while
the mic is still open for the next turn. Without echo cancellation, the mic
would re-hear the TTS audio and VAD would mistake the assistant's OWN voice
for you talking. That could either fire a false barge-in on every reply,
or auto-send a nonsense "transcript" of the assistant's own speech back to
itself.

12. With headphones OFF and speaker volume up (the actual self-trigger risk
    scenario), let several replies auto-speak in a row WITHOUT you talking
    over them. Expect no false barge-ins and no phantom auto-sent messages.
    `useVadListen`'s `echoCancellation: true`/`noiseSuppression: true`
    (conversation mode always passes both, see `useVadListen.ts`'s "self-echo
    prevention" doc) should keep the mic from re-triggering on this same
    tab's own TTS output. If you DO see a phantom send/barge-in here, that's
    the bug this design point exists to prevent. Note your browser/OS
    (echo cancellation quality varies) and whether headphones in place of
    speakers avoids it (a clean way to isolate mic-hears-speaker vs. a real
    regression).
13. For comparison, wearing headphones (so the mic genuinely can't hear the
    TTS output at all) should behave identically to steps 9-11. This
    confirms the loop itself works regardless of echo-cancellation's
    real-world imperfection.

### 7e. Coexistence with manual controls

14. With **💬 Conversation mode** ON, check the composer's **🎙 Listen**
    button (section 6's manual toggle): expect it to be disabled, showing
    (on hover) "Conversation mode owns the mic right now. Turn it off to
    use manual Listen." This confirms the two don't fight over the mic
    simultaneously. If **🎙 Listen** was already ON when you switched
    conversation mode on, expect it to turn itself off. It should not stay
    on silently overridden.
15. Toggle **💬 Conversation mode** back OFF. Expect: the mic stream
    releases (browser's mic-in-use indicator, if shown, turns off), no more
    auto-send/auto-speak/barge-in happens, and **🎙 Listen** becomes
    clickable again.
16. With conversation mode off, confirm a normal manual Send still works
    exactly as before (this increment changes nothing about the
    non-hands-free path).
17. Push-to-talk (🎤): while conversation mode is ON, click the ordinary
    push-to-talk mic button. Conversation mode leaves it enabled
    (documented behavior, see `Composer.tsx`'s `conversationMode` prop
    doc). Expect it to still work independently, dropping its transcript
    into the composer textarea same as always, without interfering with
    conversation mode's own loop.

### 7f. Mid-generation utterances get dropped

18. Send a question that will take a few seconds to answer (something that
    yields a long reply). While it's still GENERATING (before the reply
    starts auto-speaking), say something. Expect: the console shows
    `[legion-speech] conversation: dropped utterance — assistant is generating`
    and NOTHING gets sent. Your words are silently dropped,
    with nothing queued for after the reply finishes. This is intentional
    (documented in `ChatPane.tsx`): conversation mode never auto-sends a
    second message while one is still being generated.

## 8. Chat app (apps/chat): Wake word: gating conversation mode's auto-send

Increment 3b of the voice-conversation layer: **🔴 Require wake word**, under
**💬 Conversation mode** in the **Tool contributions** card. With it on,
conversation mode stops being open-mic (section 7 responds to ANYTHING said
while it's on). It ignores everything except a configured wake phrase
(default `hey legion`) until woken, then stays "awake" for a short window so
a real back-and-forth doesn't need the phrase repeated every turn.

This is a plain phrase match (`matchWakePhrase.ts`) over whatever
transcript conversation mode's continuous VAD produces, with no dedicated
wake-word model (no openWakeWord) involved. The match is ENGINE-AGNOSTIC:
the gate was built and proven against Whisper's transcripts, and now that
conversation mode transcribes locally via Moonshine-tiny (see section 7's
wake-ear note), the same phrase-match logic runs unchanged over
Moonshine's transcripts too. The gate never knows or cares which ASR
engine produced the text. Wake-phrase mishearing (either engine
transcribing "legion" as something else) is a browser/model-tuning matter.
This increment does not try to solve that. The gate is only as reliable
as the transcript it's given, from whichever engine (Moonshine, or
Whisper during a mesh/Whisper fallback) actually produced it.

### 8a. Setup

1. From the repo root: `npm run dev -w @unstable-legion/chat`. Open the dev
   URL, pick a nick, join.
2. As in section 7a, toggle **🎤 Host speech-to-text** and **🔊 Host
   text-to-speech** on (or use a two-tab mesh setup), then toggle **💬
   Conversation mode (hands-free)** on.
3. Directly below it, **🔴 Require wake word** should now be enabled
   (checkbox + text input no longer greyed out). Confirm it reads
   **checked by default** (this increment's default is ON) and the phrase
   input shows `hey legion`.
4. Above the composer, expect a small status line: **🔴 listening for "hey
   legion"**. This is the wake-state indicator; it should NOT show while
   conversation mode itself is off.

### 8b. Ignoring open-mic speech while asleep

5. Say an unrelated sentence that does NOT contain the wake phrase (e.g.
   "what's the capital of France"). Expect: NOTHING gets sent. No new
   message appears in the thread, and the status line stays **🔴 listening
   for…**. Console should show
   `[legion-speech] conversation: asleep — dropped (no wake phrase)`.

### 8c. Waking it up

6. Say "hey legion, what's two plus two" (a little filler before it, e.g.
   "uh, hey legion...", is fine too: the match works as a substring check
   and does not need to start the utterance). Expect: the status line flips
   to **🟢 conversation active**, your message is auto-sent as **just the
   part after the phrase** (e.g. "what's two plus two" only, without the
   full "hey legion what's two plus two"), and the mesh replies +
   auto-speaks as in section 7b. Console should show
   `[legion-speech] conversation: woken — auto-send command`.
7. Say the wake phrase ALONE, with no question attached ("hey legion").
   Expect: the status line flips to 🟢 immediately, but nothing is sent (no
   empty message in the thread). Console shows
   `conversation: woken — waiting for the next utterance`. Then speak the
   actual question as a separate utterance; expect it to be sent as-is
   (the active window is already open, with no need to repeat the
   phrase). This is the "active window" path (8d), a different case from
   another wake.

### 8d. Active window: follow-ups don't need the phrase again

8. Immediately after a wake (or after a reply finishes, per the next step),
   ask a follow-up WITHOUT the wake phrase, within a few seconds (well under
   20s). Expect: it's sent as-is, no wake phrase needed, console shows
   `conversation: active window — auto-send follow-up`.
9. Confirm the window opens both after a reply finishes speaking and after
   sending: let a reply finish streaming + auto-speaking, then
   immediately ask a follow-up with no wake phrase. Expect it to send (the
   window was refreshed by the reply finishing, per `ChatPane.tsx`'s
   auto-speak effect), same as step 8.
10. Wait **more than 20 seconds** of silence after the last turn/reply,
    then speak a question WITHOUT the wake phrase. Expect: it's dropped.
    Conversation mode goes back to asleep, and the status line should have
    flipped back to 🔴 listening for… once the window elapsed. Console
    shows the same asleep/dropped line described in 8b. Repeat with the
    wake phrase and confirm it wakes normally again.

### 8e. Turning the gate off: back to open-mic

11. Toggle **🔴 Require wake word** off. Expect: the status line
    disappears, and (per section 7b) conversation mode now responds to
    ANY speech again, no phrase needed. This confirms the toggle acts as a
    live gate on every turn, and not merely an initial-mode pick.
12. Toggle **💬 Conversation mode** off entirely. Expect: **🔴 Require wake
    word** and the phrase input go back to disabled/greyed, matching the
    "only meaningful under conversation mode" hint text under the toggle.

### 8f. Changing the phrase

13. With conversation mode + require-wake-word both on, change the phrase
    input to something else (e.g. `computer`). Say the OLD phrase ("hey
    legion ..."). Expect it to be dropped (asleep: the configured phrase no
    longer matches). Say "computer, what time is it". Expect it to wake and
    send "what time is it". This confirms the phrase is read live from the
    input, on every check, and never cached at toggle-on time.
14. Reload the page. Expect **🔴 Require wake word**'s checked state AND the
    custom phrase from step 13 to both have persisted (localStorage keys
    `unstable-legion-chat:require-wake-word-v1` /
    `unstable-legion-chat:wake-phrase-v1`), same persistence discipline as
    **💬 Conversation mode** itself.

## Known limitations to note while testing (not bugs)

- First model load per browser profile is slow (network fetch); repeat
  runs in the same tab/profile should be fast (Cache Storage hit).
- WebGPU device selection depends on the browser/flags; a `wasm`
  fallback is expected and fine for this PoC. Note whichever the
  status line reports.
- No COOP/COEP headers are wired into the demo's dev server yet. The
  wasm fallback therefore runs single-threaded (slower, still correct).
  See the package README's "COOP/COEP" section.
- The recording is capped at ~6s by default (`useMicCapture`'s
  `maxMs`) in apps/demo's SpeechPanel. Long dictation isn't the point of
  that PoC. apps/chat's Composer passes `maxMs: 30_000` since a real chat
  message is often longer than a 6s clip.
- Kokoro's ONNX weights are a separate lazy-loaded download from
  Whisper's. Enabling both ASR host and TTS host in the same tab
  downloads both models, each only on its own toggle-on and never
  upfront.
- The `kokoro-js` bundle chunk measured ~1.33 MB minified in a real
  `vite build` (see this package's README for the matching ASR-side
  `transformers.web`/onnxruntime-web numbers). It is code-split so it
  only loads when the TTS host toggle is switched on.
- **🎙 Listen (VAD)** self-hosts its worklet + Silero ONNX model +
  onnxruntime-web wasm binaries at `apps/chat/public/vad/` (gitignored,
  staged from `node_modules/@ricky0123/vad-web` by the `copyVadAssets`
  Vite plugin: see `vite.config.ts`'s doc comment and
  `useVadListen.ts`'s module doc for why it uses a directory copy in
  place of bundler `?url` imports). If `npm install` hasn't run since
  this increment landed, `public/vad/` won't exist yet. It gets
  populated automatically the next time `npm run dev`/`build -w
  @unstable-legion/chat` evaluates `vite.config.ts`, with no separate
  manual fetch step needed (unlike the Phase-C stage-runtime wasm/gguf
  assets).
- The onnxruntime-web wasm binaries vad-web needs (~38MB across four
  variants) are a SEPARATE, older, privately-vendored copy
  (onnxruntime-web@1.14.0, nested under
  `node_modules/@ricky0123/vad-web/node_modules/`) from the newer one
  `@huggingface/transformers`/Whisper uses. The two never collide: vad-web
  resolves its own `require("onnxruntime-web")` to its nested copy, and
  the `copyVadAssets` plugin copies from that exact nested path, leaving
  the hoisted top-level one untouched.
- **💬 Conversation mode** owns its OWN `getUserMedia` call (see
  `useVadListen.ts`'s module doc's "self-echo prevention" section: it's
  the ONLY way to actually control `echoCancellation`/`noiseSuppression`,
  since vad-web's own `additionalAudioConstraints` type excludes both and
  hardcodes them `true` internally regardless). This means it's a SEPARATE
  mic grant from section 6's manual **🎙 Listen** toggle even in the same
  tab/profile. Expect a fresh permission prompt (or a fresh browser
  mic-in-use indicator event) the first time you turn conversation mode on,
  even if you already granted the mic to **🎙 Listen** earlier in the same
  session.
- **Moonshine (the wake-ear engine)** is LOCAL ONLY. It is never advertised
  as a mesh capability/skill and never serves a remote peer's
  `asr.transcribe` call, unlike Whisper. It backs conversation mode's VAD
  exclusively; manual push-to-talk/**🎙 Listen** never use it. Because it
  runs in its OWN Worker (`moonshineWorker.ts`, separate from
  `speechWorker.ts`), enabling BOTH conversation mode AND the manual ASR
  host toggle in the same tab makes `@huggingface/transformers`' ~800KB+
  chunk download and load twice, once per worker, without being shared.
  That is a known byte-cost of the two-worker-entry split and is expected.
- **🔴 Require wake word** (section 8) is a plain substring match over
  whatever Whisper transcribes. It does not run a dedicated wake-word
  model. Whisper mishearing "legion" (or the rest of the phrase) as
  something else is a browser/model-tuning matter (mic quality, accent,
  background noise, the base Whisper model's own accuracy). That sits
  outside the gate logic itself. If wake-ups are unreliable in testing,
  try a short, phonetically distinct custom phrase in the text input
  before concluding the feature is broken.
