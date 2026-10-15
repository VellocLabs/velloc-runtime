// SharedWorker ENTRY — deliberately a stub. Keep it free of static imports
// other than the connect gate: a worker main script and everything it imports
// statically never gets V8 code cache, so each static import here is
// recompiled from source on every browser launch. The runtime proper lives in
// `agentRuntimeBody.ts` and is pulled in with `import()`, which IS cached.
// `agentRuntime-entry-stub.test.ts` guards this shape.
import { createConnectGate } from './agentRuntimeConnectGate'

type SharedWorkerScopeLike = typeof globalThis & {
  onconnect: ((event: MessageEvent) => void) | null
}

const gate = createConnectGate()
;(globalThis as SharedWorkerScopeLike).onconnect = gate.onconnect

import('./agentRuntimeBody').then(
  ({ startAgentRuntime }) => {
    gate.open(startAgentRuntime())
  },
  (error: unknown) => {
    // Neither a throw nor closing the ports would reach a page from here
    // (agentRuntimeConnectGate.ts says why). `fail()` instead answers every
    // connection wire a page opens with a `bye` frame; the page's
    // RuntimeConnection takes its final close, the session renders the
    // runtime-connection-failed card, and no reconnect loop follows — a
    // MessagePort connection never redials.
    console.error('[agentRuntime] runtime body failed to load; refusing client ports', error)
    gate.fail()
  },
)
