/**
 * useStageHost — makes THIS peer answer pipeline-split stage-hosting
 * requests (Phase C). Two responsibilities in one hook because they
 * share state (the current session) and lifecycle (both gated by the
 * same `enabled` flag):
 *
 *   1. Advertise `cap.stageHost` (WebGPU-limit-derived capacity +
 *      stability signals) so `stagePlanner.ts` can consider this peer.
 *   2. Answer the stage-control protocol (`stageControl.ts` over the
 *      `tc` action) and the activation data-plane (`sf` action):
 *      `stage.load` spins a stage worker for the requested layer range,
 *      `stage.ping`/`stage.stop` are trivial, and inbound `sf` frames
 *      are decoded, run through `decodeStep`/`prefill`, and answered
 *      with `stage.token` (+ periodic `stage.progress`).
 *
 * Ported from the proven Phase B harness host loop
 * (H:\dev\legion-stage-runtime\harness\src\p2p\host.ts) onto mesh-core's
 * `Peer` — same "first `sf` after `stage.load` is the wire header, every
 * `sf` after that is a frame" single-session convention (see that file's
 * doc comment), same prefill-at-seq-0 / decode-otherwise split.
 *
 * Scope: only the FINAL-stage host role is implemented (this demo's
 * plans never assign a non-final remote stage to more than one host —
 * see `stagePipelinePlanning.ts`'s doc comment and
 * `stageOrchestrator.ts`'s SCOPE NOTE on why N>2-stage relay is out of
 * scope). A `stage.load` for a non-final range still loads and decodes
 * correctly; it just never needs to itself forward an `sf` frame
 * onward, because this demo's orchestrator never asks it to.
 */
import { useEffect, useRef, useState } from 'react';
import {
  decodeStageControl,
  encodeStageControl,
  isStageControlFrame,
  makeStagePong,
  makeStageProgress,
  makeStageReady,
  makeStageStop,
  makeStageToken,
  type MeshPeerCap,
  type Peer,
  type StageControlMessageFor,
} from '@unstable-legion/core';
import { createActivationWireDecoder, type ActivationWireDecoder } from '@unstable-legion/stage-runtime';
import { StageWorkerClient, warmUpStageWorker, type StageWorkerLog } from './stageWorkerClient.js';
import type { WireActivationFrame } from './stageWorkerProtocol.js';
import { buildStageHostCap, type StageHostLimits } from './stagePipelinePlanning.js';
import { detectWebGpuLimits } from './webgpuLimits.js';

export interface UseStageHostOptions {
  /** Operator toggle — "Host stages". Publishing + answering both gate on this. */
  enabled: boolean;
  peer: Peer | null;
  /** Everything this peer's cap needs EXCEPT `stageHost` — the SAME
   * object shape `MeshProviderProps.cap` accepts (`ts` optional; `Peer.
   * setCap` re-stamps it unconditionally, so omitting it here is fine).
   * Read via a ref internally so the publish loop always uses the latest
   * value without needing it as an effect dependency (avoids
   * re-subscribing the answer loop on every persona edit). */
  baseCap: Omit<MeshPeerCap, 'stageHost' | 'ts'> & { ts?: number };
  /** Factory for a fresh stage-hosting DedicatedWorker — host app owns
   * the actual worker script (Vite needs a static `new URL(...)` call
   * site, which can't live in a shared library). Must be stable
   * (useCallback) or this hook will restart its answer loop every render. */
  createStageWorker: () => Worker;
  /** Mirrors `useAudioKeepalive().enabled` — feeds `stability.keepalive`. */
  keepaliveEnabled?: boolean;
  /** Fragment ids already resident in this peer's cache (future OPFS
   * work) — omitted today (this demo always cold-loads). */
  cachedFragments?: readonly string[];
  /** Send `stage.progress` every N decoded tokens. Default 8. */
  progressEveryN?: number;
  /** Re-publish `cap.stageHost` (refreshing uptimeMs/stability) this
   * often. Default 15_000ms. */
  republishMs?: number;
  log?: StageWorkerLog;
}

export interface UseStageHostSession {
  sessionId: string;
  layerStart: number;
  layerEnd: number;
  totalLayers: number;
  isFirst: boolean;
  isFinal: boolean;
}

export interface UseStageHostHandle {
  /** WebGPU present + adapter acquired. */
  supported: boolean;
  unsupportedReason?: string;
  /** enabled && supported && cap published. */
  active: boolean;
  stageHostCap?: NonNullable<MeshPeerCap['stageHost']>;
  session?: UseStageHostSession;
  tokensDecoded: number;
  lastError?: string;
}

const DEFAULT_REPUBLISH_MS = 15_000;
const DEFAULT_PROGRESS_EVERY_N = 8;

export function useStageHost(opts: UseStageHostOptions): UseStageHostHandle {
  const {
    enabled,
    peer,
    createStageWorker,
    keepaliveEnabled,
    cachedFragments,
    progressEveryN = DEFAULT_PROGRESS_EVERY_N,
    republishMs = DEFAULT_REPUBLISH_MS,
    log = () => undefined,
  } = opts;

  const baseCapRef = useRef(opts.baseCap);
  baseCapRef.current = opts.baseCap;
  const mountedAtRef = useRef(Date.now());

  const [supportState, setSupportState] = useState<{ ok: boolean; reason?: string }>({ ok: true });
  const [limits, setLimits] = useState<StageHostLimits | null>(null);
  const [visible, setVisible] = useState<boolean>(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  );
  const [onBattery, setOnBattery] = useState<boolean | undefined>(undefined);
  const [stageHostCap, setStageHostCap] = useState<NonNullable<MeshPeerCap['stageHost']> | undefined>(undefined);
  const [session, setSession] = useState<UseStageHostSession | undefined>(undefined);
  const [tokensDecoded, setTokensDecoded] = useState(0);
  const [lastError, setLastError] = useState<string | undefined>(undefined);

  // ── Feature-detect once ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void detectWebGpuLimits().then((result) => {
      if (cancelled) return;
      setSupportState({ ok: result.ok, reason: result.reason });
      if (result.ok && result.limits) setLimits(result.limits);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Visibility signal ────────────────────────────────────────────────
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVis = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // ── Battery signal (best-effort; not all browsers implement it) ─────
  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    const getBattery = (
      navigator as unknown as {
        getBattery?: () => Promise<{ charging: boolean; addEventListener: (ev: string, cb: () => void) => void }>;
      }
    ).getBattery;
    if (typeof getBattery !== 'function') return;
    let cancelled = false;
    getBattery
      .call(navigator)
      .then((battery) => {
        if (cancelled) return;
        const update = () => setOnBattery(!battery.charging);
        update();
        battery.addEventListener('chargingchange', update);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Publish cap.stageHost while enabled ─────────────────────────────
  useEffect(() => {
    if (!peer) return;
    if (!enabled || !limits || !supportState.ok) {
      if (!enabled) {
        setStageHostCap(undefined);
        peer.setCap({ ...baseCapRef.current, ts: Date.now() });
      }
      return;
    }
    const publish = (): void => {
      const cap = buildStageHostCap(
        limits,
        {
          keepalive: !!keepaliveEnabled,
          visible,
          onBattery,
          uptimeMs: Date.now() - mountedAtRef.current,
        },
        cachedFragments,
      );
      setStageHostCap(cap);
      peer.setCap({ ...baseCapRef.current, ts: Date.now(), stageHost: cap });
    };
    publish();
    const timer = setInterval(publish, republishMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peer, enabled, limits, supportState.ok, visible, onBattery, keepaliveEnabled, republishMs]);

  // ── Answer stage-control + activation frames while enabled ──────────
  useEffect(() => {
    if (!peer || !enabled) return;
    // Narrow into a fresh binding — TS control-flow narrowing on the
    // destructured `peer` doesn't survive into the nested handler
    // functions below (closures over an outer-scope variable aren't
    // re-narrowed), so capture the non-null value once here.
    const meshPeer: Peer = peer;

    let workerClient: StageWorkerClient | undefined;
    let decoder: ActivationWireDecoder | undefined;
    let sessionId: string | undefined;
    let driverPeerId: string | undefined;
    let awaitingHeader = false;
    let decodedCount = 0;

    function resetSession(): void {
      decoder = undefined;
      sessionId = undefined;
      driverPeerId = undefined;
      awaitingHeader = false;
      decodedCount = 0;
      setTokensDecoded(0);
      setSession(undefined);
    }

    async function disposeWorker(): Promise<void> {
      const w = workerClient;
      workerClient = undefined;
      if (w) await w.dispose().catch(() => undefined);
    }

    async function handleLoad(msg: StageControlMessageFor<'stage.load'>, peerId: string): Promise<void> {
      log(`[stage-host] stage.load from ${peerId} sessionId=${msg.sessionId} layers=[${msg.payload.layerStart},${msg.payload.layerEnd})`);
      await disposeWorker();
      resetSession();
      sessionId = msg.sessionId;
      driverPeerId = peerId;
      awaitingHeader = true;
      try {
        workerClient = new StageWorkerClient(
          createStageWorker(),
          `stage-host-${msg.payload.layerStart}-${msg.payload.layerEnd}`,
          log,
        );
        const shardUrls = msg.payload.shardUrls ?? (msg.payload.manifestUrl ? [msg.payload.manifestUrl] : []);
        // Deadline the load: a worker the browser kills (OOM / GPU-process
        // death) fires NO ErrorEvent — without a timeout this await hangs
        // forever, the driver never gets stage.stop, and a dead host looks
        // identical to a slow one (CHAOS.md layer 1: fail fast, never hang).
        const loadDeadlineMs = 240_000;
        await Promise.race([
          workerClient.load({
            modelId: msg.payload.modelId,
            layerStart: msg.payload.layerStart,
            layerEnd: msg.payload.layerEnd,
            totalLayers: msg.payload.totalLayers,
            shardUrls,
            ctxSize: msg.payload.ctxSize,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`stage worker load exceeded ${loadDeadlineMs}ms (worker died silently or stalled)`)),
              loadDeadlineMs,
            ),
          ),
        ]);
        log('[stage-host] warming up WebGPU shader pipelines before reporting ready…');
        await warmUpStageWorker(workerClient, log);
        setSession({
          sessionId,
          layerStart: msg.payload.layerStart,
          layerEnd: msg.payload.layerEnd,
          totalLayers: msg.payload.totalLayers,
          isFirst: workerClient.isFirst,
          isFinal: workerClient.isFinal,
        });
        await meshPeer.sendTool(
          encodeStageControl(
            makeStageReady(
              sessionId,
              { isFirst: workerClient.isFirst, isFinal: workerClient.isFinal, nEmbd: workerClient.nEmbd },
              msg.callId,
            ),
          ),
          peerId,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setLastError(message);
        log(`[stage-host] stage.load FAILED: ${message}`);
        await meshPeer
          .sendTool(encodeStageControl(makeStageStop(sessionId ?? 'unknown', `load failed: ${message}`)), peerId)
          .catch(() => undefined);
      }
    }

    async function handlePing(msg: StageControlMessageFor<'stage.ping'>, peerId: string): Promise<void> {
      await meshPeer.sendTool(encodeStageControl(makeStagePong(msg.sessionId, msg.payload.sentAtMs, msg.callId)), peerId);
    }

    async function handleStop(): Promise<void> {
      log('[stage-host] stage.stop received — tearing down session');
      await disposeWorker();
      resetSession();
    }

    const unsubTool = peer.onTool((frame, peerId) => {
      if (!isStageControlFrame(frame)) return;
      const decoded = decodeStageControl(frame);
      if (!decoded) return;
      if (decoded.kind === 'stage.load') void handleLoad(decoded, peerId);
      else if (decoded.kind === 'stage.ping') void handlePing(decoded, peerId);
      else if (decoded.kind === 'stage.stop') void handleStop();
    });

    const unsubFrame = peer.onStageFrame((bytes, peerId) => {
      log(
        `[stage-host] onStageFrame fired: peerId=${peerId} bytes=${bytes.byteLength} ` +
          `hasWorker=${!!workerClient} sessionId=${sessionId ?? 'none'} driverPeerId=${driverPeerId ?? 'none'} awaitingHeader=${awaitingHeader}`,
      );
      if (!workerClient || !sessionId || peerId !== driverPeerId) {
        log('[stage-host] onStageFrame DROPPED by guard (see fields above)');
        return;
      }
      void (async () => {
        try {
          if (awaitingHeader) {
            decoder = createActivationWireDecoder(bytes);
            awaitingHeader = false;
            log(`[stage-host] wire header: modelId=${decoder.modelId} nEmbd=${decoder.nEmbd} dtype=${decoder.dtype}`);
            return;
          }
          if (!decoder || !workerClient) return;
          const frame = decoder.decodeFrameBytes(bytes);
          const wireFrame: WireActivationFrame = {
            dtype: 'f32',
            layout: 'token-major',
            tokenCount: frame.tokenCount,
            payload: frame.activations.buffer.slice(
              frame.activations.byteOffset,
              frame.activations.byteOffset + frame.activations.byteLength,
            ) as ArrayBuffer,
          };
          const tokens = frame.tokens ?? [];
          const positions = tokens.map((_, i) => (frame.posStart ?? 0) + i);
          const isPrefill = frame.seq === 0;
          const result = isPrefill
            ? await workerClient.prefill(tokens as number[], positions, wireFrame)
            : await workerClient.decode((tokens[0] as number) ?? 0, wireFrame);
          if (result.predictedToken === undefined) {
            throw new Error('final-stage host produced no predictedToken');
          }
          decodedCount += 1;
          setTokensDecoded(decodedCount);
          const isEog = await workerClient.tokenIsEog(result.predictedToken);
          await meshPeer.sendTool(
            encodeStageControl(
              makeStageToken(sessionId!, result.predictedToken, frame.seq, isEog, isEog ? 'eos' : undefined),
            ),
            peerId,
          );
          if (decodedCount % progressEveryN === 0) {
            await meshPeer.sendTool(encodeStageControl(makeStageProgress(sessionId!, decodedCount, frame.seq)), peerId);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setLastError(message);
          log(`[stage-host] frame handling FAILED: ${message}`);
          if (sessionId) {
            await meshPeer
              .sendTool(encodeStageControl(makeStageStop(sessionId, `host error: ${message}`)), peerId)
              .catch(() => undefined);
          }
        }
      })();
    });

    // Graceful-leave: tell the driver we're going away instead of just
    // vanishing (CHAOS.md's graceful-leave path — the driver's replan is
    // instant instead of waiting out a full step timeout).
    const onPageHide = (): void => {
      if (sessionId && driverPeerId) {
        void meshPeer
          .sendTool(encodeStageControl(makeStageStop(sessionId, 'peer pagehide')), driverPeerId)
          .catch(() => undefined);
      }
    };
    if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide);

    return () => {
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
      unsubTool();
      unsubFrame();
      void disposeWorker();
    };
  }, [peer, enabled, createStageWorker, progressEveryN, log]);

  return {
    supported: supportState.ok,
    unsupportedReason: supportState.reason,
    active: enabled && supportState.ok && !!stageHostCap,
    stageHostCap,
    session,
    tokensDecoded,
    lastError,
  };
}
