import { wireDtypeFromFrameBytes } from '@unstable-legion/core';
import { shortPeerId } from '../viewmodels/meshViewModels.js';

/**
 * PipelineHandoff — makes the machine-to-machine Codec activation handoff
 * VISIBLE. The mesh already ships one activation-wire frame per hop per
 * generated token (`useCommunalChat.ts`'s `loggedPeer.sendStageFrame`) —
 * real, but previously buried in the console. This renders the ACTIVE
 * route's chain of hops (driver -> host 1 -> host 2 -> ...), one segment
 * per remote stage, each showing the layer range it covers, the wire
 * dtype (DERIVED from the last frame's byte size, never a separately
 * plumbed field — see `wireDtypeFromFrameBytes`'s doc comment for why),
 * the last frame's size, and whether that hop's connection is a real P2P
 * path or riding TURN relay.
 */

export interface PipelineHandoffStage {
  stageIndex: number;
  peerId: string;
  layerStart: number;
  layerEnd: number;
}

export type HopConnType = 'direct' | 'relayed' | 'unknown';

export interface PipelineHandoffProps {
  /** `chat.plan.stages` verbatim — stage 0 (if present) is the local
   * driver, stages >=1 are remote hops. Thin-driver routes have NO stage
   * 0 (see `planThinDriverRoute`) — the driver's own peerId is used as
   * the first hop's source in that case too. */
  stages: readonly PipelineHandoffStage[];
  /** `chat.hopBytes` — last `sendStageFrame` size per destination peerId. */
  hopBytes: Readonly<Record<string, number>>;
  nEmbd: number;
  /** Polled `peer.peerConnectionType(peerId)` results, keyed by peerId. */
  connTypes: Readonly<Record<string, HopConnType>>;
  selfId: string;
  nickOf: (peerId: string) => string | undefined;
}

function peerLabel(peerId: string, selfId: string, nickOf: (peerId: string) => string | undefined): string {
  if (peerId === selfId) return 'you';
  return `@${nickOf(peerId) ?? shortPeerId(peerId)}`;
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

const CONN_BADGE: Record<HopConnType, { icon: string; text: string; title: string }> = {
  direct: { icon: '🔗', text: 'direct', title: 'Direct peer-to-peer WebRTC path — no relay in the middle.' },
  relayed: {
    icon: '📡',
    text: 'relayed',
    title:
      'Riding a TURN relay — a direct path couldn’t be established, so encrypted packets are carried through a relay server. Still peer-to-peer at the app layer; the relay only forwards opaque bytes.',
  },
  unknown: { icon: '·', text: 'unknown', title: 'Connection type not yet determined.' },
};

export function PipelineHandoff(props: PipelineHandoffProps) {
  const { stages, hopBytes, nEmbd, connTypes, selfId, nickOf } = props;

  const remoteStages = [...stages].filter((s) => s.stageIndex > 0).sort((a, b) => a.stageIndex - b.stageIndex);
  // Only render for an active route that actually crosses the wire —
  // an all-local plan (no remote stage) has nothing to hand off.
  if (remoteStages.length === 0) return null;

  const driverPeerId = stages.find((s) => s.stageIndex === 0)?.peerId ?? selfId;

  return (
    <section className="mesh-card pipeline-handoff">
      <h3>Pipeline handoff</h3>
      <div className="pipeline-hop-chain">
        {remoteStages.map((stage, i) => {
          const sourcePeerId = i === 0 ? driverPeerId : remoteStages[i - 1]!.peerId;
          const bytes = hopBytes[stage.peerId];
          const dtype = bytes !== undefined ? wireDtypeFromFrameBytes(bytes, nEmbd) : undefined;
          // A self-hosted hop (the driver claims one of its own segments —
          // see peer.ts's loopback doc comment) never touches WebRTC, so
          // "direct/relayed" doesn't apply; label it plainly instead of
          // polling a connection that doesn't exist.
          const isSelfHop = stage.peerId === selfId;
          const conn = isSelfHop ? undefined : (connTypes[stage.peerId] ?? 'unknown');

          return (
            <div className="pipeline-hop" key={stage.stageIndex}>
              <div className="pipeline-hop-route">
                {peerLabel(sourcePeerId, selfId, nickOf)} <span aria-hidden="true">→</span>{' '}
                {peerLabel(stage.peerId, selfId, nickOf)}
              </div>
              <div className="pipeline-hop-chips">
                <span className="pipeline-hop-chip" title="Layer range this hop computes">
                  [{stage.layerStart}, {stage.layerEnd})
                </span>
                <span className="pipeline-hop-chip pipeline-hop-dtype" title="Wire dtype, derived from the last frame's byte size">
                  {dtype ? dtype.toUpperCase() : '—'}
                </span>
                <span className="pipeline-hop-chip pipeline-hop-bytes" title="Last activation frame sent to this hop">
                  {bytes !== undefined ? formatBytes(bytes) : '—'}
                </span>
                {isSelfHop ? (
                  <span className="pipeline-hop-chip pipeline-hop-badge-local" title="Self-hosted hop — no network hop, served locally.">
                    local
                  </span>
                ) : (
                  <span className={`pipeline-hop-chip pipeline-hop-badge-${conn}`} title={CONN_BADGE[conn!].title}>
                    {CONN_BADGE[conn!].icon} {CONN_BADGE[conn!].text}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
