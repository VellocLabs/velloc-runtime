/**
 * Entry of the spawner frame's inline script. Bundled to one IIFE by
 * `vite/isolatedWorkerSourcesPlugin.ts` and placed in the frame's `srcdoc`;
 * never imported by the app. All logic is in `spawnerFrame.ts`.
 */

import { installSpawnerFrame, type SpawnerFrameScope } from './spawnerFrame'

installSpawnerFrame(self as unknown as SpawnerFrameScope)
