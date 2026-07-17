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
  `maxMs`) — long dictation isn't the point of this PoC.
