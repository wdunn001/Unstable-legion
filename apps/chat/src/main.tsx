import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

// Deliberately NOT wrapped in <StrictMode> — see apps/demo/src/main.tsx's
// doc comment for the full root-cause: React 18 dev-mode StrictMode's
// mount->cleanup->mount double-invoke of MeshProvider's join effect
// corrupts @trystero-p2p/mqtt's session/connection state for the second
// joinRoom() call against the same selfId/relays/appId/roomId. Applies
// identically here — this app mounts the exact same MeshProvider.
createRoot(root).render(<App />);
