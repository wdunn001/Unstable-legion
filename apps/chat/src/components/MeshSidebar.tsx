import type { AudioKeepaliveHandle } from '@unstable-legion/react';
import { CapacityMeter } from './CapacityMeter.js';
import { OccupancyMeter } from './OccupancyMeter.js';
import { TopologyMap } from './TopologyMap.js';
import { PipelineHandoff, type PipelineHandoffProps } from './PipelineHandoff.js';
import { StandingPanel } from './StandingPanel.js';
import { Leaderboard } from './Leaderboard.js';
import { HostingConsentBanner, type HostingConsentBannerProps } from './HostingConsentBanner.js';
import { ToolContributionPanel } from './ToolContributionPanel.js';
import { useMobileCollapse } from '../hooks/useMobileCollapse.js';
import type { UseToolContributionHandle } from '../hooks/useToolContribution.js';
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
  toolContribution: UseToolContributionHandle;
  pipelineHandoff: PipelineHandoffProps;
}

export function MeshSidebar(props: MeshSidebarProps) {
  // Mobile: the whole telemetry/hosting stack collapses to a one-line
  // status strip (model readiness is the one signal a phone needs, and
  // capacity.statusLine already carries it — "Assembling Qwen3-8B — 60%
  // ready"). Desktop CSS hides the strip and shows the full sidebar.
  const [collapsed, setCollapsed] = useMobileCollapse();

  return (
    <aside className={`mesh-sidebar ${collapsed ? 'mesh-sidebar-collapsed' : ''}`}>
      <button
        type="button"
        className="sidebar-toggle"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span> {props.capacity.statusLine}
      </button>
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
      <PipelineHandoff {...props.pipelineHandoff} />
      <ToolContributionPanel tools={props.toolContribution} />
      <StandingPanel standing={props.standing} />
      <Leaderboard entries={props.leaderboard} />
    </aside>
  );
}
