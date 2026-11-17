import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { createMessagePortTransport } from '../browser/runtimeTransport'
import {
  CapabilityRegistry,
  ConnectionHub,
  TopicBroker,
  installSessionSurface,
  type RuntimeContext,
  type SessionSurfaceHost,
} from '../browser/runtimeHub'
import type { AttachOptions } from '../browser/runtimeHub/ConnectionHub'
import { registerTurnTopic } from '../browser/runtimeHub/turnCapability'
import { SESSION_DETAIL_EVENT_TYPES, sessionDetailSnapshot } from '../browser/runtimeHub/sessionDetailProjection'
import { TurnBoard } from '../sessions/turnBoard'

// Session detail on a delegated port (F-42): only what the consent dialog lists reaches it — model,
// effort, working folder, pending permissions and the questions asked — on the snapshot and on every
// live delta, and a field or event type nobody allowlisted is withheld. A full connection is unchanged.

type Frame = { kind: string; [key: string]: unknown }

const LEAK = 'LEAK'

/** Every snapshot field filled; only the allowlisted ones hold no `LEAK`. */
function fullSnapshot(): Record<string, unknown> {
  return {
    initialized: true,
    uiReady: false,
    sessionId: 's1',
    cwd: 'C:/work/app',
    projectRoot: 'C:/work/app',
    projectBranch: `${LEAK}-branch`,
    canPickProjectFolder: true,
    needsProjectFolder: false,
    currentProviderId: 'provider-a',
    activeModelId: 'model-a',
    currentThinkingTier: 'high',
    currentSelection: { note: `${LEAK}-selection` },
    autoCompact: { note: `${LEAK}-autocompact` },
    currentPermissionMode: `${LEAK}-mode`,
    modelCatalog: { note: `${LEAK}-catalog` },
    availableModels: [`${LEAK}-models`],
    toolNames: [`${LEAK}-tools`],
    commandNames: [{ name: `${LEAK}-command` }],
    loadedSkills: [{ name: 'skill', path: `${LEAK}-skill-path` }],
    mcpServers: [{ name: `${LEAK}-mcp` }],
    messageCount: 3,
    isBusy: true,
    isStopping: false,
    pendingBridgeRequestIds: [`${LEAK}-bridge`],
    pendingPermissions: {
      call1: {
        toolName: 'Bash',
        summary: 'npm test',
        suggestedRule: `${LEAK}-rule`,
        reason: 'outside-workspace',
        directory: 'C:/other',
        suggestions: [{ type: 'setMode', mode: `${LEAK}-suggestion` }],
      },
    },
    pendingPlanApproval: {
      call2: { toolName: 'ExitPlanMode', planText: `${LEAK}-plan`, planFilePath: `${LEAK}-plan-path`, restoreMode: 'default' },
    },
    pendingUserInteraction: { call3: { toolName: 'AskUserQuestion', extra: `${LEAK}-interaction` } },
    approvalQueue: [
      {
        assistantMessage: { text: `${LEAK}-reply` },
        toolName: 'Write',
        description: 'Write notes.md',
        input: { content: `${LEAK}-input` },
        approvalCallId: `${LEAK}-call-id`,
        permissionResult: { behavior: 'ask', message: `${LEAK}-message` },
        askedAtMs: 5,
      },
      {
        assistantMessage: { text: `${LEAK}-reply` },
        toolName: 'ExitPlanMode',
        description: `${LEAK}-plan-label`,
        input: { plan: `${LEAK}-plan-input` },
        approvalCallId: 'c',
        permissionResult: { behavior: 'ask', planText: `${LEAK}-plan` },
        askedAtMs: 6,
      },
    ],
    skipDangerousModePermissionPrompt: true,
    lastTerminalReason: `${LEAK}-terminal`,
    lastTerminalTimestamp: 7,
    injectMessages: [{ uuid: 'u', text: `${LEAK}-inject`, hasAttachments: false }],
    nextMessages: [`${LEAK}-next`],
    someFutureField: `${LEAK}-future`,
  }
}

const CONSENTED = {
  sessionId: 's1',
  cwd: 'C:/work/app',
  projectRoot: 'C:/work/app',
  currentProviderId: 'provider-a',
  activeModelId: 'model-a',
  currentThinkingTier: 'high',
  pendingPermissions: { call1: { toolName: 'Bash', summary: 'npm test', reason: 'outside-workspace', directory: 'C:/other' } },
  pendingPlanApproval: { call2: { toolName: 'ExitPlanMode' } },
  pendingUserInteraction: { call3: { toolName: 'AskUserQuestion' } },
  approvalQueue: [
    { toolName: 'Write', description: 'Write notes.md', askedAtMs: 5 },
    { toolName: 'ExitPlanMode', askedAtMs: 6 },
  ],
}

/** Every `worker.*` type the runtime sends, and one it does not send yet. */
const WORKER_TYPES = [
  'worker.ready', 'worker.uiReady', 'worker.completed', 'worker.state', 'worker.metadataUpdated',
  'worker.toolCallDetail', 'worker.skillBody', 'worker.toolDetailPersisted', 'worker.bridgeRequest',
  'worker.debugLog', 'worker.pendingMessageUpdated', 'worker.pendingMessageCleared',
  'worker.injectMessagesUpdated', 'worker.injectMessagesLanded', 'worker.injectMessageRemoved',
  'worker.injectMessagesCleared', 'worker.error', 'worker.somethingNew',
]

function makeRig() {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  const host = {
    getSessionSnapshot: (id: string) => (id === 's1' ? fullSnapshot() : null),
    buildSessionInfoList: () => [{ sessionId: 's1', initialized: true }],
    attachSessionPort: () => true,
    detachSessionPort: () => {},
    subscribeSessionList: () => {},
    unsubscribeSessionList: () => {},
    dispatch: () => {},
  } as unknown as SessionSurfaceHost
  const surface = installSessionSurface({ registry, broker }, host)
  const board = new TurnBoard()
  registerTurnTopic(broker, board)
  const context: RuntimeContext = {
    fs: {} as RuntimeFs,
    host: null,
    homeDir: '/h',
    publish: (id, payload, opts) => broker.publish(id, payload, opts),
    connections: () => hub.list(),
    webUiBridge: { homeDir: '/h', fs: {} as RuntimeFs, broadcastEvent: vi.fn(), directBridge: null },
  }
  const hub = new ConnectionHub({ registry, broker, context, runtimeVersion: 'sd', bootstrap: () => undefined })
  return { hub, broker, surface, board }
}

const opened: MessagePort[] = []
afterEach(() => {
  for (const port of opened.splice(0)) port.close()
})

function client(rig: ReturnType<typeof makeRig>, options: AttachOptions = {}) {
  const channel = new MessageChannel()
  opened.push(channel.port1, channel.port2)
  rig.hub.attach(createMessagePortTransport(channel.port1), options)
  const frames: Frame[] = []
  const waiters: Array<() => void> = []
  channel.port2.onmessage = event => {
    frames.push(event.data as Frame)
    waiters.splice(0).forEach(wake => wake())
  }
  const until = async (match: (all: Frame[]) => boolean): Promise<void> => {
    while (!match(frames)) await new Promise<void>(resolve => waiters.push(resolve))
  }
  const send = (frame: Frame) => channel.port2.postMessage(frame)
  const open = async (topics: string[]) => {
    send({ kind: 'hello', v: 1, client: { clientId: 'page', kind: 'browser' }, auth: { mode: 'local' } })
    await until(all => all.some(f => f.kind === 'welcome'))
    send({ kind: 'req', id: 'sub', route: 'topics.subscribe', payload: { topics: topics.map(topic => ({ topic })) } })
    await until(all => all.some(f => f.kind === 'res' && f.id === 'sub'))
    expect(frames.find(f => f.kind === 'res' && f.id === 'sub')?.ok).toBe(true)
    await until(all => topics.every(topic => all.some(f => f.kind === 'evt' && f.topic === topic && f.form === 'snapshot')))
  }
  const events = (topic: string) => frames.filter(f => f.kind === 'evt' && f.topic === topic)
  return { open, until, events }
}

const PAGE: AttachOptions = { delegate: { scope: 'observe', topics: ['session/*/state', 'turn/*'] } }

describe('session detail projection on a delegated port', () => {
  it('the state snapshot carries only the consented fields', async () => {
    const rig = makeRig()
    const page = client(rig, PAGE)
    await page.open(['session/s1/state'])
    const [snapshot] = page.events('session/s1/state')
    expect(snapshot).toMatchObject({ form: 'snapshot', type: 'worker.state' })
    expect((snapshot!.payload as { payload: unknown }).payload).toEqual(CONSENTED)
    expect(JSON.stringify(snapshot)).not.toContain(LEAK)
  })

  it('every live delta is either an allowlisted snapshot cut to the consented fields or withheld', async () => {
    const rig = makeRig()
    const page = client(rig, PAGE)
    await page.open(['session/s1/state'])
    for (const type of WORKER_TYPES) {
      const payload = SESSION_DETAIL_EVENT_TYPES.has(type) ? fullSnapshot() : { text: `${LEAK}-${type}`, entries: [LEAK] }
      rig.surface.port.postMessage({ type, sessionId: 's1', payload })
    }
    rig.surface.port.postMessage({ type: 'session.currentState', payload: { sessionId: 's1', note: LEAK } })
    await page.until(() => page.events('session/s1/state').length === 1 + WORKER_TYPES.length + 1)
    const deltas = page.events('session/s1/state').slice(1)
    expect(JSON.stringify(deltas)).not.toContain(LEAK)
    const passed = deltas.filter(evt => evt.type !== undefined)
    expect(passed.map(evt => evt.type).sort()).toEqual([...SESSION_DETAIL_EVENT_TYPES].sort())
    for (const evt of passed) expect(evt.payload).toEqual({ payload: CONSENTED })
    for (const evt of deltas.filter(evt => evt.type === undefined)) expect(evt.payload).toBeNull()
  })

  it('the turn board gives a delegated port only the closing question, on the snapshot and live', async () => {
    const rig = makeRig()
    rig.board.close('s1', { summary: `${LEAK}-summary`, question: 'Ship it?', replies: ['Yes'], waiting: true })
    const page = client(rig, PAGE)
    await page.open(['turn/s1'])
    expect(page.events('turn/s1')[0]?.payload).toEqual({
      sessionId: 's1',
      closing: { question: 'Ship it?', replies: ['Yes'], waiting: true },
    })
    rig.board.close('s1', { summary: `${LEAK}-summary`, replies: [], waiting: false })
    await page.until(() => page.events('turn/s1').length === 2)
    expect(page.events('turn/s1')[1]?.payload).toEqual({ sessionId: 's1', closing: null })
    expect(JSON.stringify(page.events('turn/s1'))).not.toContain(LEAK)
  })

  it('a full connection still gets the whole snapshot, every delta and the whole turn board', async () => {
    const rig = makeRig()
    rig.board.close('s1', { summary: 'Done.', replies: [], waiting: false })
    const shell = client(rig)
    await shell.open(['session/s1/state', 'turn/s1'])
    expect(shell.events('session/s1/state')[0]?.payload).toEqual({ payload: fullSnapshot() })
    expect(shell.events('turn/s1')[0]?.payload).toMatchObject({ closing: { summary: 'Done.' } })
    rig.surface.port.postMessage({ type: 'worker.debugLog', sessionId: 's1', payload: { line: 'trace' } })
    await shell.until(() => shell.events('session/s1/state').length === 2)
    expect(shell.events('session/s1/state')[1]).toMatchObject({ type: 'worker.debugLog', payload: { payload: { line: 'trace' } } })
  })

  it('sessionDetailSnapshot keeps nothing of a value that is not a snapshot', () => {
    expect(sessionDetailSnapshot(null)).toEqual({})
    expect(sessionDetailSnapshot({ pendingPermissions: { a: 'x' }, approvalQueue: [1] })).toEqual({ pendingPermissions: {}, approvalQueue: [] })
  })
})
