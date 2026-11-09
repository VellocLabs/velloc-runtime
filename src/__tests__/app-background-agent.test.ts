/**
 * Agent runs of an app's background module (F-40): `$.app.analyze` is refused
 * without `agent` approved, starts one run with the app's template and folder,
 * resolves `{ok, text}` or `{ok: false, reason}` — `busy` while one is in
 * flight, `limit` past the day's cap, `stopped` when the module stops,
 * `failed: …` otherwise — and the request is checked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModWorkerHandle } from '../mods/ModRuntime'
import { AppBackgroundRuntime, type AppBackgroundRef, type AppBackgroundRuntimeOptions } from '../mods/app/AppBackgroundRuntime'
import {
  APP_AGENT_DAILY_LIMIT,
  AppAgentRuns,
  manifestAsksAgent,
  readAnalyzeRequest,
  type AppAgentRunJob,
  type AppAgentRunOutcome,
} from '../mods/app/appAgentRun'
import { refuseAppBackgroundCall } from '../mods/app/appBackgroundEvents'
import { appRunKeepsTool, appRunTools } from '../mods/app/appRunTools'

const FOLDER = 'C:/home/.velloc/shared-workspace/app-pay-board'
const TYPE = 'pay:board'

const openPorts: MessagePort[] = []
const runtimes: AppBackgroundRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  for (const port of openPorts.splice(0)) port.close()
})

/** A runner whose runs end when the test says so. */
function fakeRunner() {
  const jobs: AppAgentRunJob[] = []
  const ends: Array<(outcome: AppAgentRunOutcome) => void> = []
  const run = vi.fn((job: AppAgentRunJob) => {
    jobs.push(job)
    return new Promise<AppAgentRunOutcome>(resolve => {
      ends.push(resolve)
      job.abortSignal.addEventListener('abort', () => resolve({ status: 'aborted' }), { once: true })
    })
  })
  return { run, jobs, end: (i: number, outcome: AppAgentRunOutcome) => ends[i]!(outcome) }
}

/** On `analyze`, runs the agent with the action's context as the request and keeps each answer or error. */
const ANALYST = `
  export function register(on) {
    on('app.start', async ($) => { await $.app.state.set({ answers: [] }) })
    on('app.action', ($, e) => {
      $.app.analyze(e.context).then(
        answer => $.app.state.update(s => { s.answers.push(answer) }),
        error => $.app.state.update(s => { s.answers.push(error.name + ': ' + error.message) }),
      )
      return true
    })
  }
`

function world(options: Partial<AppBackgroundRuntimeOptions> = {}) {
  const reports: string[] = []
  const runtime = new AppBackgroundRuntime({
    readModule: async () => ANALYST,
    openWorker: async (): Promise<ModWorkerHandle> => {
      const channel = new MessageChannel()
      openPorts.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
      const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
        settle = resolve
      })
      return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
    },
    window: { available: () => true, attached: async () => {} },
    report: line => reports.push(line),
    ...options,
  })
  runtimes.push(runtime)
  const ref = (agentType?: string): AppBackgroundRef => ({
    plugin: 'pay',
    path: '/plugins/pay/bg.js',
    root: '/plugins/pay',
    appId: 'pay-board',
    folder: FOLDER,
    stateFile: `${FOLDER}/data/state.json`,
    ...(agentType ? { agentType } : {}),
  })
  const answers = () => (runtime.document('pay-board')?.value as { answers?: unknown[] } | undefined)?.answers ?? []
  const ready = async (agentType?: string) => {
    runtime.sync([ref(agentType)])
    await vi.waitFor(() => expect(runtime.status()[0]?.state).toBe('ready'))
  }
  return { runtime, reports, ref, answers, ready }
}

describe('$.app.analyze — admission', () => {
  it('is refused loudly, without a run, when the app has no approved agent', async () => {
    const runner = fakeRunner()
    const { runtime, reports, answers, ready } = world({ runAgent: runner.run })
    await ready()
    await runtime.action('pay-board', 'go', { prompt: 'look' }, 's1')
    await vi.waitFor(() => expect(answers()).toHaveLength(1))
    expect(answers()[0]).toMatch(/^NotAllowedError: \$\.app\.analyze needs "agent": true/)
    expect(reports.some(line => /pay-board called \$\.app\.analyze, refused/.test(line))).toBe(true)
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('analyze is among the methods a background module may call', () => {
    expect(refuseAppBackgroundCall('app', 'analyze')).toBeNull()
  })

  it('a request that is not { prompt, title? } rejects with a TypeError', async () => {
    const runner = fakeRunner()
    const { runtime, answers, ready } = world({ runAgent: runner.run })
    await ready(TYPE)
    await runtime.action('pay-board', 'go', { prompt: '  ' }, 's1')
    await vi.waitFor(() => expect(answers()).toHaveLength(1))
    expect(answers()[0]).toMatch(/^TypeError: \$\.app\.analyze\(\{ prompt, title\? \}\): prompt is a non-empty string/)
    expect(runner.run).not.toHaveBeenCalled()
  })
})

describe('$.app.analyze — a run', () => {
  it("runs with the app's template and folder and resolves with the run's final text", async () => {
    const runner = fakeRunner()
    const { runtime, answers, ready } = world({ runAgent: runner.run })
    await ready(TYPE)
    await runtime.action('pay-board', 'go', { prompt: 'Why did revenue drop?', title: ' Weekly alert ' }, 's1')
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(1))
    expect(runner.jobs[0]).toMatchObject({
      appId: 'pay-board',
      plugin: 'pay',
      templateType: TYPE,
      folder: FOLDER,
      prompt: 'Why did revenue drop?',
      title: 'Weekly alert',
    })
    runner.end(0, { status: 'success', text: 'Refunds doubled.' })
    await vi.waitFor(() => expect(answers()).toEqual([{ ok: true, text: 'Refunds doubled.' }]))
  })

  it('a second call while one is in flight is busy at once; after it ends another may start', async () => {
    const runner = fakeRunner()
    const { runtime, answers, ready } = world({ runAgent: runner.run })
    await ready(TYPE)
    await runtime.action('pay-board', 'go', { prompt: 'one' }, 's1')
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(1))
    await runtime.action('pay-board', 'go', { prompt: 'two' }, 's1')
    await vi.waitFor(() => expect(answers()).toEqual([{ ok: false, reason: 'busy' }]))
    runner.end(0, { status: 'success', text: 'a' })
    await vi.waitFor(() => expect(answers()).toHaveLength(2))
    await runtime.action('pay-board', 'go', { prompt: 'three' }, 's1')
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(2))
  })

  it("the app stopping cancels its run, which ends stopped", async () => {
    const runner = fakeRunner()
    const { runtime, ready } = world({ runAgent: runner.run })
    await ready(TYPE)
    await runtime.action('pay-board', 'go', { prompt: 'one' }, 's1')
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(1))
    runtime.sync([])
    await vi.waitFor(() => expect(runner.jobs[0]!.abortSignal.aborted).toBe(true))
  })

  it('a changed approval restarts the module', async () => {
    const runner = fakeRunner()
    const { runtime, ref, ready } = world({ runAgent: runner.run })
    await ready()
    runtime.sync([ref(TYPE)])
    await vi.waitFor(() => expect(runtime.status()[0]?.state).toBe('ready'))
    await runtime.action('pay-board', 'go', { prompt: 'one' }, 's1')
    await vi.waitFor(() => expect(runner.jobs).toHaveLength(1))
  })
})

describe('AppAgentRuns', () => {
  const job = { appId: 'pay-board', plugin: 'pay', templateType: TYPE, folder: FOLDER, prompt: 'p' }

  it('refuses past the daily limit, counted per app, and starts again the next day', async () => {
    let now = new Date(2026, 10, 8, 9).getTime()
    const reports: string[] = []
    const runs = new AppAgentRuns({ run: async () => ({ status: 'success', text: 't' }), report: line => reports.push(line), now: () => now, dailyLimit: 2 })
    const gone = new AbortController().signal
    expect(await runs.start(job, gone)).toEqual({ ok: true, text: 't' })
    expect(await runs.start(job, gone)).toEqual({ ok: true, text: 't' })
    expect(await runs.start(job, gone)).toEqual({ ok: false, reason: 'limit' })
    expect(await runs.start({ ...job, appId: 'other' }, gone)).toEqual({ ok: true, text: 't' })
    expect(reports.some(line => /started 2 agent runs today, its limit/.test(line))).toBe(true)
    now = new Date(2026, 10, 9, 0, 1).getTime()
    expect(await runs.start(job, gone)).toEqual({ ok: true, text: 't' })
    expect(APP_AGENT_DAILY_LIMIT).toBe(24)
  })

  it('maps how the run ended: aborted is stopped, an error or a throw is failed, a timeout fails and aborts the run', async () => {
    const gone = new AbortController().signal
    const report = () => undefined
    const of = (run: () => Promise<AppAgentRunOutcome>) => new AppAgentRuns({ run, report }).start(job, gone)
    expect(await of(async () => ({ status: 'aborted' }))).toEqual({ ok: false, reason: 'stopped' })
    expect(await of(async () => ({ status: 'error', message: 'model down' }))).toEqual({ ok: false, reason: 'failed: model down' })
    expect(await of(async () => Promise.reject(new Error('worker gone')))).toEqual({ ok: false, reason: 'failed: worker gone' })
    expect(await new AppAgentRuns({ report }).start(job, gone)).toEqual({ ok: false, reason: 'failed: agent runs are not available in this realm' })
    let seen: AbortSignal | undefined
    const slow = new AppAgentRuns({
      run: job =>
        new Promise(resolve => {
          seen = job.abortSignal
          job.abortSignal.addEventListener('abort', () => resolve({ status: 'aborted' }), { once: true })
        }),
      report,
      timeoutMs: 20,
    })
    expect(await slow.start(job, gone)).toEqual({ ok: false, reason: 'failed: the run did not finish within 20 ms' })
    expect(seen?.aborted).toBe(true)
  })

  it('a gone module is stopped before a run starts, and a run it outlives ends stopped', async () => {
    const before = new AbortController()
    before.abort()
    const run = vi.fn(async () => ({ status: 'success' as const, text: 't' }))
    expect(await new AppAgentRuns({ run, report: () => undefined }).start(job, before.signal)).toEqual({ ok: false, reason: 'stopped' })
    expect(run).not.toHaveBeenCalled()
    const gone = new AbortController()
    const runs = new AppAgentRuns({
      run: job => new Promise(resolve => job.abortSignal.addEventListener('abort', () => resolve({ status: 'success', text: 'late' }), { once: true })),
      report: () => undefined,
    })
    const pending = runs.start(job, gone.signal)
    gone.abort()
    expect(await pending).toEqual({ ok: false, reason: 'stopped' })
  })
})

describe('the request, the manifest and the tools', () => {
  it('readAnalyzeRequest keeps prompt and a trimmed title, and names what is wrong', () => {
    expect(readAnalyzeRequest({ prompt: 'p', title: ' t ' })).toEqual({ prompt: 'p', title: 't' })
    expect(() => readAnalyzeRequest('p')).toThrow(/expected an object/)
    expect(() => readAnalyzeRequest({ prompt: 'x'.repeat(20_001) })).toThrow(/longer than 20000/)
    expect(() => readAnalyzeRequest({ prompt: 'p', title: 3 })).toThrow(/title is a non-empty string/)
  })

  it('manifestAsksAgent reads background.agent of any app template', () => {
    const manifest = (agent: unknown) => ({ templates: { board: { app: { background: { module: './bg.js', agent } } } } })
    expect(manifestAsksAgent(manifest(true))).toBe(true)
    expect(manifestAsksAgent(manifest(false))).toBe(false)
    expect(manifestAsksAgent({ templates: { board: { app: { background: './bg.js' } } } })).toBe(false)
    expect(manifestAsksAgent(null)).toBe(false)
  })

  it('an app run keeps files, todos, skills, fetch and MCP tools, and drops shells, agents, sessions, routines and asks', () => {
    for (const name of ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'TodoWrite', 'Skill', 'ToolSearch', 'WebFetch', 'SuperEdit', 'mcp__pay__invoices']) {
      expect(appRunKeepsTool(name)).toBe(true)
    }
    for (const name of ['Bash', 'PowerShell', 'SuperShell', 'Exec', 'Agent', 'SpawnSession', 'SendMessage', 'TeamCreate', 'CronCreate', 'RoutineSignal', 'AskUserQuestion', 'BuildApp', 'ExitPlanMode']) {
      expect(appRunKeepsTool(name)).toBe(false)
    }
    expect(appRunTools([{ name: 'Read' }, { name: 'Bash' }])).toEqual([{ name: 'Read' }])
  })
})
