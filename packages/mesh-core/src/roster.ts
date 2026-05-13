/**
 * Local roster — observable peer list keyed by Trystero selfId.
 *
 * Framework-free: a tiny event emitter that React / Vue / Svelte bindings
 * subscribe to via their idiomatic stores. `@unstable-legion/react`
 * wraps this in `useSyncExternalStore`.
 *
 * Stale-peer pruning: peers absent from the most recent cap broadcasts
 * are dropped after `staleMs` (default 5 minutes — tolerates browser
 * background-tab throttling, where Chrome drops setInterval cadence to
 * ~1/min and heartbeats miss the prune window). The optional
 * `isPaused` callback also lets the host skip pruning entirely while
 * the tab is hidden, so returning to a backgrounded tab doesn't show
 * an empty roster for the seconds it takes peers to re-heartbeat.
 */
import type { MeshPeerCap, MeshRosterEntry } from './types.js';

export interface RosterOptions {
  /** Milliseconds after which a peer with no recent `cap` is removed. Default 300_000 (5 min). */
  staleMs?: number;
  /** How often to run the prune sweep. Default 30_000. */
  sweepMs?: number;
  /**
   * Optional predicate: when it returns `true`, the prune sweep is
   * skipped. Wire to `document.visibilityState === 'hidden'` so a
   * backgrounded tab doesn't trash its roster from missed heartbeats
   * that were really just timer throttling.
   */
  isPaused?: () => boolean;
}

type Listener = (snapshot: readonly MeshRosterEntry[]) => void;

export class Roster {
  private peers = new Map<string, MeshRosterEntry>();
  private listeners = new Set<Listener>();
  private staleMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotCache: readonly MeshRosterEntry[] = [];
  private dirty = true;
  private isPaused: (() => boolean) | undefined;

  constructor(opts: RosterOptions = {}) {
    this.staleMs = opts.staleMs ?? 300_000;
    this.isPaused = opts.isPaused;
    const sweepMs = opts.sweepMs ?? 30_000;
    if (typeof setInterval !== 'undefined') {
      this.sweepTimer = setInterval(() => this.prune(), sweepMs);
    }
  }

  /** Update / insert a peer entry on receiving its `cap`. */
  upsert(peerId: string, cap: MeshPeerCap): void {
    this.peers.set(peerId, { ...cap, peerId, lastSeen: Date.now() });
    this.dirty = true;
    this.emit();
  }

  /** Explicit removal — Trystero `onPeerLeave` fires this. */
  remove(peerId: string): void {
    if (this.peers.delete(peerId)) {
      this.dirty = true;
      this.emit();
    }
  }

  /** Current peers, freshest-`lastSeen` first. Stable reference between writes. */
  snapshot(): readonly MeshRosterEntry[] {
    if (this.dirty) {
      this.snapshotCache = [...this.peers.values()].sort((a, b) => b.lastSeen - a.lastSeen);
      this.dirty = false;
    }
    return this.snapshotCache;
  }

  /** Subscribe; returns an unsubscribe callback. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** For consumers that need the entry without a snapshot scan. */
  get(peerId: string): MeshRosterEntry | undefined {
    return this.peers.get(peerId);
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.listeners.clear();
    this.peers.clear();
  }

  private prune(): void {
    if (this.isPaused?.()) return;
    const cutoff = Date.now() - this.staleMs;
    let changed = false;
    for (const [id, e] of this.peers) {
      if (e.lastSeen < cutoff) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.dirty = true;
      this.emit();
    }
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }
}
