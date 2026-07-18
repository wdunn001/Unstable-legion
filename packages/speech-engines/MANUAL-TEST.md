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
