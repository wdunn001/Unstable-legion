import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App.js';
import './styles.css';
import './pwa.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

// Deliberately NOT wrapped in <StrictMode> — see apps/demo/src/main.tsx's
// doc comment for the full root-cause: React 18 dev-mode StrictMode's
// mount->cleanup->mount double-invoke of MeshProvider's join effect
// corrupts @trystero-p2p/mqtt's session/connection state for the second
// joinRoom() call against the same selfId/relays/appId/roomId. Applies
// identically here — this app mounts the exact same MeshProvider.
createRoot(root).render(<App />);

mountPwaUpdateToast();

/**
 * Minimal, self-contained "new version available" affordance for the
 * autoUpdate service worker registered by vite-plugin-pwa. Deliberately
 * plain DOM (not a React component) so it lives entirely outside the
 * App.tsx tree — a PWA-shell concern, not a product-UI concern — and
 * imports only ./pwa.css, never touching the shared styles.css.
 *
 * `registerSW({ immediate: true })` starts registration right away
 * (rather than waiting for a `load` event that already fired by the
 * time this module runs). `onNeedRefresh` fires when a new SW has
 * installed and is waiting to activate; `onOfflineReady` fires once
 * after the very first successful install, confirming the app shell is
 * now cached for offline launch.
 */
function mountPwaUpdateToast(): void {
  let updateSW: ((reloadPage?: boolean) => Promise<void>) | undefined;

  const toast = document.createElement('div');
  toast.className = 'pwa-toast';
  toast.hidden = true;
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  const message = document.createElement('span');
  message.className = 'pwa-toast__message';

  const reloadButton = document.createElement('button');
  reloadButton.type = 'button';
  reloadButton.className = 'pwa-toast__button';
  reloadButton.textContent = 'Reload';
  reloadButton.hidden = true;
  reloadButton.addEventListener('click', () => {
    void updateSW?.(true);
  });

  const dismissButton = document.createElement('button');
  dismissButton.type = 'button';
  dismissButton.className = 'pwa-toast__dismiss';
  dismissButton.textContent = '×';
  dismissButton.setAttribute('aria-label', 'Dismiss');
  dismissButton.addEventListener('click', () => {
    toast.hidden = true;
  });

  toast.append(message, reloadButton, dismissButton);
  document.body.appendChild(toast);

  const show = (text: string, withReload: boolean) => {
    message.textContent = text;
    reloadButton.hidden = !withReload;
    toast.hidden = false;
  };

  updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      show('New version available.', true);
    },
    onOfflineReady() {
      show('Legion is ready to launch offline.', false);
    },
  });
}
