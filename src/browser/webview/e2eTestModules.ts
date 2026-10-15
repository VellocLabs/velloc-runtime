/**
 * Contract: module handles the e2e suite drives from inside the page, reached
 * only through `__NEXUS_E2E__.loadTestModules()` (which is installed only under
 * the `e2eTrace` flag). Loaded with `import()`, so it shares the app's module
 * instances (one workspace store, one runtime client module) and stays off the
 * boot chunk. Product code never imports this file. (G-2)
 */

export {
  connectRuntime,
  connectRuntimeOverSharedWorker,
  createRuntimeFileAccess,
} from '../runtimeClient'
export { createWebSocketTransport } from '../runtimeTransport'
export { createBrowserRuntimeSharedWorker } from './createBrowserRuntimeSharedWorker'
export { getWorkspaceStore } from './workspaceStore'
export { warmColdUi } from './coldUi'
