// Cross-platform wrapper for `VERSIONED_DEPLOY=1 vite build` (npm run
// build:versioned) — Windows shells have no inline env-var syntax and the
// repo avoids a cross-env dependency for one flag. The flag makes
// vite.config.ts derive `base` (`/v<N>/`) from NEXUS_INTERFACE_VERSION; see
// G-3.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const viteCli = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js')

const result = spawnSync(process.execPath, [viteCli, 'build'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, VERSIONED_DEPLOY: '1' },
})
process.exit(result.status ?? 1)
