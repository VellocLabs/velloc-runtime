/**
 * The loops under a slot (sub-agents, teammates) raise their tool calls in the slot's mod runtime with their id as
 * `agentId`, so a guard's refused call cannot run through a sub-agent. Real `runToolUse` and `ModRuntime`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkingState, ModelReplyRow, Message } from '../runtime/RuntimeTypes'
import type { QueryRuntimeDeps } from '../runtime/interfaces/QueryRuntimeDeps'
import { declareTool } from '../toolkit/toolContract'
import { type ToolCallContext } from '../toolkit/toolCallContext'
import { executeToolCall, type DeferredMessageUpdate } from '../toolkit/run/executeToolCall'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { ModRuntime, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import {
  MOD_SLOT_MAX_DEPTH,
  findModSlot,
  linkModChild,
  modSlotToolsFor,
  modsForAgentLoop,
  onModSlotToolsChanged,
  publishModSlotTools,
  registerModSlot,
  resetModSlotRegistryForTests,
  undoWhenScopeEnds,
} from '../mods/modSlotRegistry'
import type { ToolCallMods } from '../mods/toolCallEvent'
import { buildModTool } from '../mods/modRegisteredTools'

let uuid = 0
let uniqueLoad = 0
const RUNTIME_DEPS = { uuid: () => `uuid-${++uuid}` } as QueryRuntimeDeps

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
beforeEach(() => resetModSlotRegistryForTests())
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
  resetModSlotRegistryForTests()
})

/** A stand-in slot, told apart by identity. */
const fakeSlot = (): ToolCallMods => ({
  ready: Promise.resolve(),
  hasToolCallHooks: () => true,
  toolCall: async () => ({ settled: false }),
})

describe('the slot registry', () => {
  it('a session with a slot resolves to its own', () => {
    const slot = fakeSlot()
    registerModSlot('root', slot)
    expect(findModSlot('root')).toBe(slot)
    expect(findModSlot('stranger')).toBeUndefined()
  })

  it('a child resolves to its nearest ancestor with a slot, however deep', () => {
    const slot = fakeSlot()
    registerModSlot('root', slot)
    linkModChild('subagent-a', 'root')
    linkModChild('subagent-b', 'subagent-a')
    linkModChild('team-mate', 'root')
    linkModChild('subagent-c', 'team-mate')
    for (const id of ['subagent-a', 'subagent-b', 'team-mate', 'subagent-c']) {
      expect(findModSlot(id), id).toBe(slot)
    }
  })

  it('a child of a session with no slot has none', () => {
    linkModChild('subagent-a', 'plain-session')
    expect(findModSlot('subagent-a')).toBeUndefined()
  })

  it('the undo of a registration removes only its own entry', () => {
    const first = fakeSlot()
    const undoFirst = registerModSlot('root', first)
    // The session's runtime is rebuilt: a new slot under the same id…
    const second = fakeSlot()
    registerModSlot('root', second)
    // …and the OLD runtime's teardown runs afterwards.
    undoFirst()
    expect(findModSlot('root')).toBe(second)
  })

  it('the undo of a link removes only its own', () => {
    registerModSlot('root', fakeSlot())
    const undo = linkModChild('child', 'elsewhere')
    linkModChild('child', 'root')
    undo()
    expect(findModSlot('child')).toBeDefined()
  })

  it('a registration or link made after its scope ended is undone at once', () => {
    const ended = new AbortController()
    ended.abort()
    undoWhenScopeEnds(registerModSlot('root', fakeSlot()), ended.signal)
    linkModChild('child', 'other-root')
    registerModSlot('other-root', fakeSlot())
    undoWhenScopeEnds(linkModChild('late', 'other-root'), ended.signal)
    expect(findModSlot('root')).toBeUndefined()
    expect(findModSlot('late')).toBeUndefined()
    // A live scope keeps them until it ends.
    const live = new AbortController()
    undoWhenScopeEnds(registerModSlot('root', fakeSlot()), live.signal)
    expect(findModSlot('root')).toBeDefined()
    live.abort()
    expect(findModSlot('root')).toBeUndefined()
  })

  it('a session is not its own parent, and a cycle resolves to nothing', () => {
    linkModChild('a', 'a')
    expect(findModSlot('a')).toBeUndefined()
    linkModChild('x', 'y')
    linkModChild('y', 'x')
    expect(findModSlot('x')).toBeUndefined()
    expect(MOD_SLOT_MAX_DEPTH).toBeGreaterThan(8)
  })
})

describe('modsForAgentLoop resolves the slot at each use', () => {
  it('has no hooks and settles nothing while there is no slot', async () => {
    const mods = modsForAgentLoop('subagent-a', 'a')
    linkModChild('subagent-a', 'root')
    expect(mods.agentId).toBe('a')
    expect(mods.hasToolCallHooks()).toBe(false)
    await expect(mods.ready).resolves.toBeUndefined()
    await expect(
      mods.toolCall({ tool: 'X', tool_use_id: 't' }, async () => ({ ref: 1, result: 1 })),
    ).resolves.toEqual({ settled: false })
  })

  it('follows a slot that appears, is rebuilt, and goes away', () => {
    const mods = modsForAgentLoop('subagent-a', 'a')
    linkModChild('subagent-a', 'root')
    const undo = registerModSlot('root', fakeSlot())
    expect(mods.hasToolCallHooks()).toBe(true)
    undo()
    expect(mods.hasToolCallHooks()).toBe(false)
    registerModSlot('root', { ...fakeSlot(), hasToolCallHooks: () => true })
    expect(mods.hasToolCallHooks()).toBe(true)
  })
})

// ── the real tool path ───────────────────────────────────────────────────────

function rootRuntime(registerBody: string) {
  const reports: string[] = []
  const runtime = new ModRuntime({
    modules: [{ plugin: 'guard', path: 'guard/hooks/register.js' }],
    readModule: async () =>
      `export function register(on) {\n${registerBody}\n}\n// load ${++uniqueLoad}`,
    openWorker: async (): Promise<ModWorkerHandle> => {
      const channel = new MessageChannel()
      open.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
      const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
        settle = resolve
      })
      return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
    },
    session: { id: () => 'root', cwd: () => '/work' },
    report: line => reports.push(line),
  })
  runtimes.push(runtime)
  return { runtime, reports }
}

/** A session's own tool context — as a sub-agent's or a teammate's runtime
 *  builds it: no `agentId` of its own, its mods handed in. */
function sessionContext(mods: ToolCallContext['options']['mods']) {
  let appState: WorkingState = createEmptyAppState()
  const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
    appState = updater(appState)
  }
  const calls: Array<Record<string, unknown>> = []
  const tool = declareTool({
    name: 'Read',
    argsSchema: { type: 'object' as const, properties: {} },
    description: async () => 'reads',
    call: async (args: Record<string, unknown>) => {
      calls.push(args)
      return { data: `contents of ${String(args.file_path)}` }
    },
  })
  const context = createNoopToolUseContext({
    tools: [tool],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState,
    setAppState,
    sessionId: 'whichever',
  })
  context.writeAppState = setAppState
  context.readAppState = () => appState
  if (mods) context.options.mods = mods
  return { context, calls }
}

async function read(context: ToolCallContext, file_path: string): Promise<DeferredMessageUpdate[]> {
  const assistant: ModelReplyRow = {
    type: 'assistant',
    uuid: 'assistant-1',
    message: {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'tc-1', toolName: 'Read', args: {} }],
    },
  }
  const updates: DeferredMessageUpdate[] = []
  for await (const update of executeToolCall(
    { type: 'tool-call', toolCallId: 'tc-1', toolName: 'Read', args: { file_path } },
    assistant,
    async () => ({ behavior: 'allow' }),
    context,
    RUNTIME_DEPS,
  )) {
    updates.push(update)
  }
  return updates
}

function resultOf(update: DeferredMessageUpdate | undefined) {
  const message = update?.message as
    | (Message & {
        toolUseResult?: string
        message: { content: Array<{ isError?: boolean }> }
      })
    | undefined
  return { text: message?.toolUseResult, isError: message?.message.content[0]?.isError === true }
}

const GUARD = `
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    await $.ui.log('saw ' + e.file_path + ' agentId=' + e.agentId)
    return /\\.env$/.test(e.file_path) ? { deny: 'guard: .env is off limits' } : next(e)
  })
`

describe('a child loop\'s tool call is the slot\'s tool.call', () => {
  it('a sub-agent cannot do what the guard refuses, and the hook sees whose call it is', async () => {
    const { runtime, reports } = rootRuntime(GUARD)
    registerModSlot('root', runtime)
    linkModChild('subagent-a1b2', 'root')
    const { context, calls } = sessionContext(modsForAgentLoop('subagent-a1b2', 'a1b2'))

    const denied = await read(context, '/repo/.env')
    expect(resultOf(denied[0])).toEqual({ text: 'guard: .env is off limits', isError: true })
    expect(calls).toEqual([])

    const allowed = await read(context, '/repo/readme.md')
    expect(resultOf(allowed[0])).toEqual({ text: 'contents of /repo/readme.md', isError: false })
    expect(reports).toEqual([
      'guard: saw /repo/.env agentId=a1b2',
      'guard: saw /repo/readme.md agentId=a1b2',
    ])
  })

  it('the main loop\'s own call carries no agentId', async () => {
    const { runtime, reports } = rootRuntime(GUARD)
    const { context } = sessionContext(runtime)
    await read(context, '/repo/readme.md')
    expect(reports).toEqual(['guard: saw /repo/readme.md agentId=undefined'])
  })

  it('a sub-agent of a teammate reaches the lead\'s mods', async () => {
    const { runtime, reports } = rootRuntime(GUARD)
    registerModSlot('lead', runtime)
    linkModChild('mate-session', 'lead')
    linkModChild('subagent-z9', 'mate-session')
    const { context, calls } = sessionContext(modsForAgentLoop('subagent-z9', 'z9'))
    expect(resultOf((await read(context, '/repo/.env'))[0]).isError).toBe(true)
    expect(calls).toEqual([])
    expect(reports).toEqual(['guard: saw /repo/.env agentId=z9'])
  })

  it('an in-turn fork\'s own agentId wins over the session\'s', async () => {
    const { runtime, reports } = rootRuntime(GUARD)
    registerModSlot('root', runtime)
    linkModChild('subagent-a1b2', 'root')
    const { context } = sessionContext(modsForAgentLoop('subagent-a1b2', 'a1b2'))
    context.agentId = 'fork-7'
    await read(context, '/repo/readme.md')
    expect(reports).toEqual(['guard: saw /repo/readme.md agentId=fork-7'])
  })

  it('with no slot above it, a child\'s tools run exactly as without mods', async () => {
    linkModChild('subagent-a1b2', 'plain-root')
    const { context, calls } = sessionContext(modsForAgentLoop('subagent-a1b2', 'a1b2'))
    expect(resultOf((await read(context, '/repo/.env'))[0]).isError).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('once the slot has ended, the child goes on without it', async () => {
    const { runtime } = rootRuntime(GUARD)
    const undo = registerModSlot('root', runtime)
    linkModChild('subagent-a1b2', 'root')
    const { context, calls } = sessionContext(modsForAgentLoop('subagent-a1b2', 'a1b2'))
    expect(resultOf((await read(context, '/repo/.env'))[0]).isError).toBe(true)
    runtime.dispose()
    undo()
    expect(resultOf((await read(context, '/repo/.env'))[0]).isError).toBe(false)
    expect(calls).toHaveLength(1)
  })
})

describe("a child loop lists the tools its slot's mods registered", () => {
  const tide = buildModTool('mod-sea', { name: 'tide', description: 'Tides.', inputSchema: { type: 'object' } })
  const wave = buildModTool('mod-sea', { name: 'wave', description: 'Waves.', inputSchema: { type: 'object' } })

  it("a child reads its nearest slot's tools; a session under no slot reads none", () => {
    registerModSlot('root', fakeSlot())
    registerModSlot('mid', fakeSlot())
    linkModChild('mid', 'root')
    linkModChild('child', 'root')
    linkModChild('grandchild', 'mid')
    publishModSlotTools('root', [tide])
    publishModSlotTools('mid', [wave])
    expect(modSlotToolsFor('child').map(tool => tool.name)).toEqual(['mcp__mod-sea__tide'])
    expect(modSlotToolsFor('grandchild').map(tool => tool.name)).toEqual(['mcp__mod-sea__wave'])
    expect(modSlotToolsFor('stranger')).toEqual([])
  })

  it('tools of a session that has no slot are listed under none', () => {
    linkModChild('child', 'root')
    publishModSlotTools('root', [tide])
    expect(modSlotToolsFor('child')).toEqual([])
  })

  it('a watcher hears a publish, a slot coming and going, and nothing after its undo', () => {
    let heard = 0
    const undo = onModSlotToolsChanged(() => {
      heard += 1
    })
    const unregister = registerModSlot('root', fakeSlot())
    publishModSlotTools('root', [tide])
    publishModSlotTools('root', [])
    publishModSlotTools('root', [])
    unregister()
    expect(heard).toBe(4)
    undo()
    publishModSlotTools('root', [wave])
    expect(heard).toBe(4)
  })
})

describe('the wiring names both kinds of child', () => {
  // `createAgentRuntime` and the coordinator cannot be instantiated here, so
  // pin the text: a child that is not linked is a child the guard never sees.
  const read_ = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8')

  it('a sub-agent is launched with the session it runs under — fresh and resumed', () => {
    const coordinator = read_('browser/worker/SubAgentCoordinator.ts')
    expect(coordinator).toContain('modParentSessionId: spawnerSessionId,')
    expect(coordinator).toContain('modParentSessionId: rec.spawnerSessionId,')
  })

  it('createAgentRuntime links a sub-agent by that field and a teammate by its lead', () => {
    const runtime = read_('browser/runtime/createAgentRuntime.ts')
    const at = runtime.indexOf('const modParentSessionId =')
    expect(at).toBeGreaterThan(0)
    const block = runtime.slice(at, runtime.indexOf('const engine = new QueryEngine(', at))
    expect(block).toContain('modParentSessionId')
    expect(block).toContain('isTeammateSession')
    expect(block).toContain('spawnerSessionId')
    expect(block).toContain('linkModChild(resolvedSessionId, modParentSessionId)')
    expect(block).toContain('modsForAgentLoop(')
    expect(runtime).toMatch(/registerModSlot\(\s*resolvedSessionId,\s*Object\.assign\(modRuntime,/)
  })

  it("createAgentRuntime publishes a slot's registered tools and a child lists them, scoped as its own tools", () => {
    const runtime = read_('browser/runtime/createAgentRuntime.ts')
    expect(runtime).toContain('onModToolsChanged: registered => publishModSlotTools(resolvedSessionId, registered),')
    const at = runtime.indexOf('if (agentLoopMods && allowsMcp) {')
    expect(at).toBeGreaterThan(0)
    const block = runtime.slice(at, runtime.indexOf('onModSlotToolsChanged(inheritSlotTools)', at))
    expect(block).toContain('modSlotToolsFor(resolvedSessionId)')
    expect(block).toContain('applySubAgentToolScope(')
    expect(block).toContain('engine.inheritModTools(')
  })
})
