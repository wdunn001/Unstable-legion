/**
 * ModelFolderPanel — "Load layers from a local folder" control. Lets a
 * user who already has the model package on disk (a clone of the HF repo,
 * or a `.88` slice) point the app at that folder instead of downloading
 * every fragment over the network.
 *
 * TRUST: this panel is deliberately silent about hashes/manifests — it has
 * nothing to say about them, because they never come from the folder (see
 * `useModelFolder.ts`'s / `@unstable-legion/react`'s `localFolderFetch.ts`
 * module doc comments for the full trust model). The one line of copy this
 * panel DOES show ("verified against the official checksums") is the
 * user-facing summary of that guarantee, not a claim this component
 * enforces itself.
 *
 * No component-level CSS — every className resolves against `styles.css`'s
 * `.contribution-*`/`.model-folder-*` rules, same convention as
 * `ContributionPanel.tsx`.
 */
import type { UseModelFolderHandle } from '../hooks/useModelFolder.js';

export interface ModelFolderPanelProps {
  modelFolder: UseModelFolderHandle;
}

export function ModelFolderPanel(props: ModelFolderPanelProps) {
  const { modelFolder } = props;

  if (!modelFolder.supported) {
    return (
      <div className="contribution-panel model-folder-panel" role="region" aria-label="Load layers from a local folder">
        <p className="contribution-hint">Load layers from a local folder</p>
        <p className="contribution-note">Local folder needs Chrome or Edge.</p>
      </div>
    );
  }

  return (
    <div className="contribution-panel model-folder-panel" role="region" aria-label="Load layers from a local folder">
      <p className="contribution-hint">Load layers from a local folder</p>
      <p className="contribution-note">
        Already have the model weights on disk (a clone of the Hugging Face repo, or a slice from another machine)?
        Point this tab at that folder and it fetches layer/shared fragments from it instead of downloading — anything
        missing from the folder still downloads normally.
      </p>

      {modelFolder.handle && (
        <p className="model-folder-status model-folder-active">
          Using local folder — layers are verified against the official checksums.
        </p>
      )}
      {modelFolder.needsPermission && (
        <p className="model-folder-status model-folder-needs-permission">
          A previously-picked folder needs permission again — pick it once more to reconnect.
        </p>
      )}
      {modelFolder.error && <p className="model-folder-status model-folder-error">{modelFolder.error}</p>}

      <div className="contribution-field-row">
        <button type="button" className="btn btn-ghost model-folder-pick" onClick={() => void modelFolder.pick()}>
          {modelFolder.handle ? 'Change folder…' : 'Choose folder…'}
        </button>
        {modelFolder.handle && (
          <button type="button" className="btn-link model-folder-clear" onClick={() => void modelFolder.clear()}>
            Use downloads instead
          </button>
        )}
      </div>
    </div>
  );
}
