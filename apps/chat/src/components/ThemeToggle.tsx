import type { ThemePreference } from '../hooks/useTheme.js';

export function ThemeToggle(props: { theme: ThemePreference; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={props.onToggle}
      aria-label={`Switch to ${props.theme === 'dark' ? 'light' : 'dark'} theme`}
      title={`Switch to ${props.theme === 'dark' ? 'light' : 'dark'} theme`}
    >
      {props.theme === 'dark' ? '☾ dark' : '☀ light'}
    </button>
  );
}
