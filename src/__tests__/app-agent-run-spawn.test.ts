/**
 * The manager's spawn of an app's agent run (F-40): a headless session on the
 * app's template and folder whatever the last window's session was bound to,
 * read-bounded to the folder, routine-originated, on the default model; its
 * run is listed as a finished background task; its final text, an error or a
 * stop come back as the outcome.
 */
import { describe, expect, it, vi } from 'vitest'

import { RoutineCoordinator, type RoutineHost } from '../browser/worker/RoutineCoordinator'
import type { AgentRuntimeWorkerInitPayload } from '../browser/worker/workerProtocol'
import type { AppAgentRunJob } from '../mods/app/appAgentRun'

const FOLDER = 'C:/home/.velloc/shared-workspace/app-pay-board'

const TEMPLATE = {
  cwd: 'C:/work/other',
  projectRoot: 'C:/work/other',
  templateType: 'code',
  userSpecifiedProviderId: 'acme',
  userSpecifiedModel: 'big-model',
  userSpecifiedThinkingTier: 'max',
  hostMode: 'nexus',
} as unknown as AgentRuntimeWorkerInitPayload

type Ending = { status: 'completed' } | { status: 'failed'; message: string } | { status: 'aborted' }

function world(options: { template?: AgentRuntimeWorkerInitPayload | null; reply?: string; ending?: Ending } = {}) {
  const frames: Array<{ type: string; payload?: unknown }> = []
  const recorded: unknown[] = []
  const bindings: unknown[] = []
  const reaped: string[] = []
  let coordinator!: RoutineCoordinator
  let finish!: (ending: Ending) => void
  const worker = {
    receiveFrame: vi.fn(async (frame: { type: string; sessionId: string; payload?: unknown }) => {
      frames.push(frame)
      if (frame.type === 'worker.interrupt') finish({ status: 'aborted' })
    }),
    submitAndWait: vi.fn(
      (message: { payload: { prompt: string } }) =>
        new Promise<Ending>(resolve => {
          finish = resolve
          const sessionId = (frames.find(frame => frame.type === 'worker.init')!.payload as { sessionId: string }).sessionId
          if (options.reply !== undefined) {
            coordinator.interceptEmit(sessionId, {
              type: 'worker.stream',
              payload: { event: { type: 'assistant', message: { content: [{ type: 'text', text: options.reply }] } } },
            } as never)
          }
          void message
          if (options.ending) queueMicrotask(() => resolve(options.ending!))
        }),
    ),
  }
  const host: RoutineHost = {
    getInitTemplate: () => (options.template === undefined ? TEMPLATE : options.template),
    prepareWorkerStorage: () => null,
    createWorker: () => ({ worker: worker as never, instanceId: 'i1' }),
    registerSessionEntry: (_sessionId, _worker, _instanceId, binding) => void bindings.push(binding),
    getSessionWorker: () => worker as never,
    reapSessionEntry: sessionId => void reaped.push(sessionId),
    routeBridgeRequest: () => undefined,
    scheduleSummary: () => undefined,
  }
  const registry = {
    indexTaskId: vi.fn(),
    recordFinished: vi.fn((_sessionId: string, record: unknown) => void recorded.push(record)),
    evictFinishedOverCap: vi.fn(),
  }
  coordinator = new RoutineCoordinator(registry as never, host)
  const init = () => frames.find(frame => frame.type === 'worker.init')?.payload as AgentRuntimeWorkerInitPayload | undefined
  return { coordinator, frames, recorded, bindings, reaped, init, worker }
}

const job = (abortSignal = new AbortController().signal): AppAgentRunJob => ({
  appId: 'pay-board',
  plugin: 'pay',
  templateType: 'pay:board',
  folder: FOLDER,
  prompt: 'Why did revenue drop?',
  title: 'Weekly alert',
  abortSignal,
})

describe('RoutineCoordinator.spawnAppRun', () => {
  it("boots on the app's template and folder, read-bounded, routine-originated, on the default model, and returns the final text", async () => {
    const { coordinator, init, bindings, recorded, reaped, worker } = world({ reply: 'Refunds doubled.', ending: { status: 'completed' } })
    const outcome = await coordinator.spawnAppRun(job())
    expect(outcome).toEqual({ status: 'success', text: 'Refunds doubled.' })
    const payload = init()!
    expect(payload).toMatchObject({
      cwd: FOLDER,
      projectRoot: FOLDER,
      templateType: 'pay:board',
      isHeadless: true,
      routineOriginId: 'app:pay-board',
      appAgentRun: 'pay-board',
      untrustedReadRoot: FOLDER,
      hostMode: 'nexus',
    })
    expect(payload.sessionId).toMatch(/^headless-app-[0-9a-f-]{36}$/)
    for (const field of ['userSpecifiedProviderId', 'userSpecifiedModel', 'userSpecifiedThinkingTier', 'routineId', 'cwdOverride', 'traceId'] as const) {
      expect(payload[field]).toBeUndefined()
    }
    expect(bindings).toEqual([{ projectRoot: FOLDER, templateType: 'pay:board' }])
    expect(recorded).toEqual([
      expect.objectContaining({ type: 'local_routine', routineId: 'app:pay-board', description: 'Weekly alert', prompt: 'Why did revenue drop?', status: 'success' }),
    ])
    expect(worker.submitAndWait.mock.calls[0]![0]).toMatchObject({ payload: { prompt: 'Why did revenue drop?' } })
    expect(reaped).toEqual([payload.sessionId])
  })

  it('a run that wrote no text succeeds with empty text; a failed turn is an error', async () => {
    expect(await world({ ending: { status: 'completed' } }).coordinator.spawnAppRun(job())).toEqual({ status: 'success', text: '' })
    expect(await world({ ending: { status: 'failed', message: 'model down' } }).coordinator.spawnAppRun(job())).toEqual({ status: 'error', message: 'model down' })
  })

  it('an abort interrupts the worker and the run ends aborted, listed as stopped', async () => {
    const { coordinator, frames, recorded, worker } = world()
    const controller = new AbortController()
    const pending = coordinator.spawnAppRun(job(controller.signal))
    await vi.waitFor(() => expect(worker.submitAndWait).toHaveBeenCalled())
    controller.abort()
    expect(await pending).toEqual({ status: 'aborted' })
    expect(frames.some(frame => frame.type === 'worker.interrupt')).toBe(true)
    expect(recorded).toEqual([expect.objectContaining({ status: 'stopped' })])
  })

  it('with no window session yet, or a signal already aborted, nothing is spawned', async () => {
    const none = world({ template: null })
    expect(await none.coordinator.spawnAppRun(job())).toEqual({ status: 'error', message: expect.stringMatching(/no session has started/) })
    expect(none.init()).toBeUndefined()
    const aborted = new AbortController()
    aborted.abort()
    const early = world()
    expect(await early.coordinator.spawnAppRun(job(aborted.signal))).toEqual({ status: 'aborted' })
    expect(early.init()).toBeUndefined()
  })
})
