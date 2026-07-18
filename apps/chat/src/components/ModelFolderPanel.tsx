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
  /** Hugging Face repo page for the active model's weights — rendered as a
   * "Download the weights" link so a user who doesn't have them yet can get
   * a folder to point at. Omitted (no link) for the test model / any channel
   * without a public repo. See `channelDownloadUrl` in chatModelSource. */
  downloadUrl?: string;
}

export function ModelFolderPanel(props: ModelFolderPanelProps) {
  const { modelFolder, downloadUrl } = props;

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
        {downloadUrl && (
          <>
            {' '}
            <a className="model-folder-download-link" href={downloadUrl} target="_blank" rel="noreferrer noopener">
              Download the weights ↗
            </a>
          </>
        )}
      </p>
      <p className="contribution-note model-folder-persist-hint">
        Tip: when Chrome asks for folder access, choose <strong>“Allow on every visit”</strong> — then this tab
        re-uses the same folder automatically on reload, with no re-grant click.
      </p>

      {modelFolder.handle && (
        <p className="model-folder-status model-folder-active">
          ✓ Local folder active — layers load from disk, verified against the official checksums.
        </p>
      )}
      {modelFolder.error && <p className="model-folder-status model-folder-error">{modelFolder.error}</p>}

      {modelFolder.needsPermission ? (
        // A folder is remembered but its read permission didn't survive the
        // reload (File System Access API needs a fresh user gesture to
        // re-grant). Model loading is PAUSED (App gates hosting/serve on this)
        // so it can't silently fall back to downloading the whole model —
        // make the user choose: re-grant the folder, or explicitly download.
        <div className="model-folder-status model-folder-needs-permission">
          <p>
            ⚠ Your remembered local folder needs a click to re-grant read access. <strong>Loading is paused</strong> so
            it doesn&rsquo;t silently download the whole model — choose one:
          </p>
          <div className="contribution-field-row">
            <button type="button" className="btn btn-ghost model-folder-pick" onClick={() => void modelFolder.pick()}>
              Re-grant folder
            </button>
            <button type="button" className="btn-link model-folder-clear" onClick={() => void modelFolder.clear()}>
              Download instead
            </button>
          </div>
        </div>
      ) : (
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
      )}
    </div>
  );
}
