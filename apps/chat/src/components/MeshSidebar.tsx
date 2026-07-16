import type { AudioKeepaliveHandle } from '@unstable-legion/react';
import { CapacityMeter } from './CapacityMeter.js';
import { OccupancyMeter } from './OccupancyMeter.js';
import { TopologyMap } from './TopologyMap.js';
import { StandingPanel } from './StandingPanel.js';
import { Leaderboard } from './Leaderboard.js';
import { HostingConsentBanner, type HostingConsentBannerProps } from './HostingConsentBanner.js';
import type { CapacityView, LeaderboardEntry, StandingView, TopologySegmentView } from '../viewmodels/meshViewModels.js';

export interface MeshSidebarProps {
  capacity: CapacityView;
  segments: readonly TopologySegmentView[];
  totalLayers: number;
  standing: StandingView;
  leaderboard: readonly LeaderboardEntry[];
  consentBanner: HostingConsentBannerProps;
  audioKeepalive: AudioKeepaliveHandle;
  showAudioKeepalive: boolean;
}

export function MeshSidebar(props: MeshSidebarProps) {
  return (
    <aside className="mesh-sidebar">
      <HostingConsentBanner {...props.consentBanner} />
      {props.showAudioKeepalive && (
        <label className="audio-keepalive-row" title="Keep this tab active (and hosting) while it's in the background.">
          <input type="checkbox" checked={props.audioKeepalive.enabled} onChange={() => void props.audioKeepalive.toggle()} />
          <span>Keep hosting while this tab is in the background</span>
        </label>
      )}
      <CapacityMeter capacity={props.capacity} />
      {props.capacity.occupancy && <OccupancyMeter occupancy={props.capacity.occupancy} />}
      <TopologyMap segments={props.segments} totalLayers={props.totalLayers} modelLabel={props.capacity.modelLabel} />
      <StandingPanel standing={props.standing} />
      <Leaderboard entries={props.leaderboard} />
    </aside>
  );
}
