import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build once before the webServer starts. The build used to live in the
 * webServer command as `vite build && vite preview`, but on Windows
 * Playwright's process-tree kill doesn't reach through the cmd.exe `&&`
 * chain — the preview server leaks, occupies the port, and (with
 * reuseExistingServer) later runs silently test a STALE bundle.
 */
export default function globalSetup(): void {
  execSync('npx vite build', { stdio: 'inherit', cwd: path.join(here, '..') });
}
