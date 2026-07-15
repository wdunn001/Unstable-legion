import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

// Deliberately NOT wrapped in <StrictMode>. Verified while building
// Phase C (workstream C3): React 18's dev-mode StrictMode
// mount->cleanup->mount double-invoke of MeshProvider's join effect
// (joinMesh -> leave() -> joinMesh again) corrupts the Trystero MQTT
// strategy's session/connection state — the SECOND joinRoom call for
// the same page (same module-scoped `selfId`, so same MQTT client
// identity) never actually completes peer discovery, even though the
// underlying WebSocket connections to the relay brokers succeed. Raw
// Trystero (no React) reproduces this in isolation: a bare
// `joinRoom() -> room.leave() -> joinRoom()` sequence against the same
// relays/appId/roomId silently breaks discovery, while a single
// `joinRoom()` call works instantly. Root cause is upstream in
// @trystero-p2p/mqtt's teardown/reconnect handling, not app code — this
// demo just can't afford StrictMode's double-invoke until that's fixed.
createRoot(root).render(<App />);
