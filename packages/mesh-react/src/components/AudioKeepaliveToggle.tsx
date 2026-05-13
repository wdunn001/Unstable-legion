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
          ? 'tab is playing silent audio; backgrounded throttling is disabled. tab bar will show a speaker icon.'
          : 'browsers throttle backgrounded tabs. enable to keep this peer responsive when tabbed away.'}
      </span>
      {handle.lastError && (
        <span className="ul-keepalive-error" role="alert">
          {handle.lastError}
        </span>
      )}
    </div>
  );
}
