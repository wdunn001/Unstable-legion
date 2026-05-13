/**
 * AudioKeepaliveToggle — small toggle UI for `useAudioKeepalive`.
 *
 * Drop into any panel. Shows a one-line explainer + a button. Click
 * the button to start/stop the silent-audio loop that defeats tab
 * throttling.
 */
import type { AudioKeepaliveHandle } from '../useAudioKeepalive.js';

export interface AudioKeepaliveToggleProps {
  handle: AudioKeepaliveHandle;
  className?: string;
}

export function AudioKeepaliveToggle(props: AudioKeepaliveToggleProps) {
  const { handle, className } = props;
  return (
    <div className={`ul-keepalive ${className ?? ''}`}>
      <button
        type="button"
        className={handle.enabled ? 'ul-keepalive-on' : 'ul-keepalive-off'}
        onClick={() => {
          void handle.toggle();
        }}
        aria-pressed={handle.enabled}
      >
        {handle.enabled ? '◉ keepalive on' : '○ keepalive off'}
      </button>
      <span className="ul-keepalive-explain">
        {handle.enabled
          ? 'silent audio playing. modern browsers detect 0-amplitude audio and may throttle anyway — the worker-based mesh + LLM is the real fix.'
          : 'historical workaround: silent audio used to defeat tab-throttling. modern Chrome/Firefox detect it. left here in case your browser is older or behaves differently.'}
      </span>
      {handle.lastError && (
        <span className="ul-keepalive-error" role="alert">
          {handle.lastError}
        </span>
      )}
    </div>
  );
}
