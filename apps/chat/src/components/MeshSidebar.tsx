import type { AudioKeepaliveHandle } from '@unstable-legion/react';
import { CapacityMeter } from './CapacityMeter.js';
import { OccupancyMeter } from './OccupancyMeter.js';
import { TopologyMap } from './TopologyMap.js';
import { PipelineHandoff, type PipelineHandoffProps } from './PipelineHandoff.js';
import { StandingPanel } from './StandingPanel.js';
import { Leaderboard } from './Leaderboard.js';
import { HostingConsentBanner, type HostingConsentBannerProps } from './HostingConsentBanner.js';
import {
  ToolContributionPanel,
  type ToolContributionSpeechProps,
  type ToolContributionTtsProps,
  type ToolContributionAutoSpeakProps,
  type ToolContributionConversationModeProps,
} from './ToolContributionPanel.js';
import { ModelFolderPanel } from './ModelFolderPanel.js';
import { useMobileCollapse } from '../hooks/useMobileCollapse.js';
import type { UseToolContributionHandle } from '../hooks/useToolContribution.js';
import type { UseModelFolderHandle } from '../hooks/useModelFolder.js';
import type { CapacityView, CrewScaleView, LeaderboardEntry, StandingView, TopologySegmentView } from '../viewmodels/meshViewModels.js';

export interface MeshSidebarProps {
  capacity: CapacityView;
  segments: readonly TopologySegmentView[];
  crewScale?: CrewScaleView;
  totalLayers: number;
  standing: StandingView;
  leaderboard: readonly LeaderboardEntry[];
  consentBanner: HostingConsentBannerProps;
  audioKeepalive: AudioKeepaliveHandle;
  showAudioKeepalive: boolean;
  toolContribution: UseToolContributionHandle;
  speechHost: ToolContributionSpeechProps;
  ttsHost: ToolContributionTtsProps;
  autoSpeak: ToolContributionAutoSpeakProps;
  conversationMode: ToolContributionConversationModeProps;
  pipelineHandoff: PipelineHandoffProps;
  /** "Load layers from a local folder" — applies to this driver's OWN
   * stage-0 load regardless of hosting consent, so it's rendered
   * unconditionally (unlike `ContributionPanel`, which is nested inside
   * `HostingConsentBanner`'s hosting-accepted state). */
  modelFolder: UseModelFolderHandle;
  /** HF repo page for the active model's weights — passed to ModelFolderPanel's
   * "Download the weights" link. Undefined omits the link. */
  modelFolderDownloadUrl?: string;
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
      <ModelFolderPanel modelFolder={props.modelFolder} downloadUrl={props.modelFolderDownloadUrl} />
      {props.showAudioKeepalive && (
        <label className="audio-keepalive-row" title="Keep this tab active (and hosting) while it's in the background.">
          <input type="checkbox" checked={props.audioKeepalive.enabled} onChange={() => void props.audioKeepalive.toggle()} />
          <span>Keep hosting while this tab is in the background</span>
        </label>
      )}
      <CapacityMeter capacity={props.capacity} />
      {props.capacity.occupancy && <OccupancyMeter occupancy={props.capacity.occupancy} />}
      <TopologyMap segments={props.segments} totalLayers={props.totalLayers} modelLabel={props.capacity.modelLabel} scale={props.crewScale} />
      <PipelineHandoff {...props.pipelineHandoff} />
      <ToolContributionPanel
        tools={props.toolContribution}
        speechHost={props.speechHost}
        ttsHost={props.ttsHost}
        autoSpeak={props.autoSpeak}
        conversationMode={props.conversationMode}
      />
      <StandingPanel standing={props.standing} />
      <Leaderboard entries={props.leaderboard} />
    </aside>
  );
}
