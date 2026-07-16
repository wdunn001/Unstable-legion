import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Build once before the webServer starts — see
 * apps/demo/e2e/global-setup.ts's identical comment: Windows'
 * process-tree kill doesn't reach through a `vite build && vite preview`
 * `&&` chain, so the build has to run here instead of in the webServer
 * command or a leaked preview server serves a stale bundle on the next run. */
export default function globalSetup(): void {
  execSync('npx vite build', { stdio: 'inherit', cwd: path.join(here, '..') });
}
