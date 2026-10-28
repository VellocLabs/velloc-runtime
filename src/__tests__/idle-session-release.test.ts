import { afterEach, describe, expect, it, vi } from 'vitest'

import { BridgeFsConversationStorageBackend } from '../browser/storage/BridgeFsSessionStorage'
import { AgentRuntimeWorker, IDLE_PAYLOAD_RELEASE_MS } from '../browser/worker/AgentRuntimeWorker'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { Message } from '../runtime/RuntimeTypes'
import { BrowserConversationStore } from '../sessions/sessionStore'
import { sanitizeMessageForPersistence, sanitizeMessageForUi } from '../utils/toolCallDetails'

vi.mock('../browser/runtime/createAgentRuntime', () => ({
  createAgentRuntime: vi.fn(),
  createBrowserRuntime: vi.fn(),
}))

// ── An in-memory filesystem behind the bridge transport ──────────────────

function fakeFs() {
  const files = new Map<string, Uint8Array>()
  const transport = {
    async request(request: { id: string; route: { capability: string; action: string }; payload: any }) {
      await Promise.resolve()
      const p = request.payload ?? {}
      const ok = (result: unknown) => ({ id: request.id, ok: true, result })
      switch (`${request.route.capability}.${request.route.action}`) {
        case 'fs.appendFile': {
          const prev = files.get(p.path) ?? new Uint8Array(0)
          const next = new Uint8Array(prev.length + p.data.length)
          next.set(prev)
          next.set(p.data, prev.length)
          files.set(p.path, next)
          return ok(null)
        }
        case 'fs.writeFile':
          files.set(p.path, p.content)
          return ok(null)
        case 'fs.readFile': {
          const f = files.get(p.path)
          return f ? ok(f) : { id: request.id, ok: false, error: { code: 'NOT_FOUND', message: 'nf' } }
        }
        case 'fs.readBatch': {
          const parts: Uint8Array[] = []
          let total = 0
          const entries = p.items.map((it: { path: string }) => {
            const f = files.get(it.path)
            if (!f) return { path: it.path, ok: false, byteOffset: 0, byteLength: 0, error: 'NOT_FOUND' }
            const e = { path: it.path, ok: true, byteOffset: total, byteLength: f.length }
            parts.push(f)
            total += f.length
            return e
          })
          const blob = new Uint8Array(total)
          let at = 0
          for (const part of parts) {
            blob.set(part, at)
            at += part.length
          }
          return ok({ entries, totalBytes: total, truncated: false, blob })
        }
        default:
          return ok(null)
      }
    },
  }
  return { files, backend: () => new BridgeFsConversationStorageBackend({ transport: transport as never, basePath: '/p' }) }
}

const runtimeConfig = (): RuntimeConfig => {
  let n = 0
  return { createUUID: () => `uuid-${n++}`, createTimestamp: () => '2026-10-01T00:00:00.000Z', now: () => 1_000 } as unknown as RuntimeConfig
}

const T0 = '2026-10-01T00:00:00.000Z'
const PAYLOAD = (i: number) => `PAYLOAD-${i}-` + 'x'.repeat(200)

function readTurn(i: number): Message[] {
  const args = { file_path: `/src/${i}.ts` }
  const result = PAYLOAD(i)
  return [
    { type: 'assistant', uuid: `a${i}`, timestamp: T0, message: { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text: `Reading ${i}` }, { type: 'tool-call', toolCallId: `t${i}`, toolName: 'Read', args }] } },
    {
      type: 'user', uuid: `u${i}`, timestamp: T0,
      message: { role: 'user', content: [{ type: 'tool-result', toolCallId: `t${i}`, toolName: 'Read', result }] },
      toolCallDetailRef: { toolCallId: `t${i}`, toolName: 'Read' },
      toolCallDetail: { toolCallId: `t${i}`, toolName: 'Read', args, result },
    },
  ] as unknown as Message[]
}

function bashTurn(i: number): Message[] {
  const args = { command: `ls ${i}` }
  const result = { stdout: `out ${i}`, stderr: '', exitCode: 0 }
  return [
    { type: 'assistant', uuid: `ba${i}`, timestamp: T0, message: { id: `bm${i}`, role: 'assistant', content: [{ type: 'tool-call', toolCallId: `b${i}`, toolName: 'Bash', args }] } },
    {
      type: 'user', uuid: `bu${i}`, timestamp: T0,
      message: { role: 'user', content: [{ type: 'tool-result', toolCallId: `b${i}`, toolName: 'Bash', result }] },
      toolCallDetailRef: { toolCallId: `b${i}`, toolName: 'Bash' },
      toolCallDetail: { toolCallId: `b${i}`, toolName: 'Bash', args, result },
    },
  ] as unknown as Message[]
}

const prompt = (text: string) =>
  ({ type: 'user', uuid: `p-${text}`, timestamp: T0, message: { role: 'user', content: [{ type: 'text', text }] } }) as unknown as Message

const internals = (s: BrowserConversationStore) =>
  s as unknown as { recordedMessages: Message[]; toolCallDetails: Map<string, unknown> }

afterEach(() => vi.useRealTimers())

// ── The store ────────────────────────────────────────────────────────────

describe('BrowserConversationStore.releaseToolPayloads', () => {
  it('drops the payloads, and the next hydration gives the same conversation', async () => {
    const fs = fakeFs()
    const live = new BrowserConversationStore({ runtimeConfig: runtimeConfig(), sessionId: 'S', storageBackend: fs.backend() })
    const conversation: Message[] = [prompt('go')]
    for (let i = 0; i < 3; i++) {
      conversation.push(...readTurn(i), ...bashTurn(i))
      await live.saveTranscriptRows(conversation)
      await live.hydrateMessagesForModel()
    }
    await live.promoteToolCallDetailToOrigin('t1', 'compacted t1')
    const before = await live.hydrateMessagesForModel()

    expect(live.releaseToolPayloads()).toBe(true)
    expect(internals(live).toolCallDetails.size).toBe(0)
    expect(JSON.stringify(internals(live).recordedMessages)).not.toContain('PAYLOAD-')

    expect(await live.hydrateMessagesForModel()).toStrictEqual(before)
    // …and that is also what a reopened session makes of the same disk (which
    // additionally stamps each message with the line it was read from).
    const reopened = new BrowserConversationStore({ runtimeConfig: runtimeConfig(), sessionId: 'S', storageBackend: fs.backend() })
    const withoutLines = (messages: readonly Message[]) =>
      messages.map(message => {
        const { transcriptLine: _line, ...rest } = message as Message & { transcriptLine?: number }
        return rest
      })
    expect(withoutLines(await reopened.hydrateMessagesForModel())).toStrictEqual(withoutLines(before))
  })

  it('an image result comes back as an image part after the release, not as base64 text', async () => {
    const fs = fakeFs()
    const live = new BrowserConversationStore({ runtimeConfig: runtimeConfig(), sessionId: 'S', storageBackend: fs.backend() })
    const image = 'IMAGE-BYTES-' + 'A'.repeat(4096)
    const args = { file_path: '/shots/frame.jpg' }
    const data = {
      message: 'Media file read: /shots/frame.jpg',
      content_parts: [
        { type: 'text', text: 'Image file read: /shots/frame.jpg' },
        { type: 'image', image, mimeType: 'image/jpeg' },
      ],
    }
    const sent = [
      { type: 'text', text: 'Image file read: /shots/frame.jpg' },
      { type: 'image', image, mimeType: 'image/jpeg' },
    ]
    const turn = [
      { type: 'assistant', uuid: 'ia', timestamp: T0, message: { id: 'im', role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'i0', toolName: 'Read', args }] } },
      {
        type: 'user', uuid: 'iu', timestamp: T0,
        message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'i0', result: sent }] },
        toolUseResult: data.message,
        toolCallDetailRef: { toolCallId: 'i0', toolName: 'Read' },
        toolCallDetail: { toolCallId: 'i0', toolName: 'Read', args, result: data },
      },
    ] as unknown as Message[]
    await live.saveTranscriptRows([prompt('go'), ...turn])
    await live.hydrateMessagesForModel()

    expect(live.releaseToolPayloads()).toBe(true)
    const after = await live.hydrateMessagesForModel()
    const row = after.find(message => message.uuid === 'iu') as unknown as {
      message: { content: Array<{ result?: unknown }> }
      toolUseResult?: unknown
    }
    expect(row.message.content[0].result).toEqual(sent)
    expect(row.toolUseResult).toBe(data.message)
  })

  it('a detail stored for a released id merges with the file, never over it', async () => {
    // After a release the record is on disk in full and out of memory. The
    // transcript service rebuilds a detail from the (now stubbed) messages
    // and saves it; merging that against an empty cache replaced the full
    // file with the stub.
    const fs = fakeFs()
    const live = new BrowserConversationStore({ runtimeConfig: runtimeConfig(), sessionId: 'S', storageBackend: fs.backend() })
    await live.saveTranscriptRows([prompt('go'), ...readTurn(0)])
    await live.hydrateMessagesForModel()
    const path = [...fs.files.keys()].find(p => p.includes('tool-details') && p.endsWith('t0.json'))!
    const before = new TextDecoder().decode(fs.files.get(path)!)
    expect(before).toContain('PAYLOAD-0')

    expect(live.releaseToolPayloads()).toBe(true)
    await live.saveToolCallDetail({ toolCallId: 't0', toolName: 'Read', args: { file_path: '/src/0.ts' } })
    expect(JSON.parse(new TextDecoder().decode(fs.files.get(path)!))).toEqual(JSON.parse(before))
    expect(await live.getToolCallDetail('t0')).toMatchObject({ result: PAYLOAD(0) })
  })

  it('keeps a detail that is not known to be on disk', async () => {
    const fs = fakeFs()
    const backend = fs.backend()
    // A backend that cannot write details: nothing is ever "on disk".
    ;(backend as { saveToolCallDetail?: unknown }).saveToolCallDetail = undefined
    const live = new BrowserConversationStore({ runtimeConfig: runtimeConfig(), sessionId: 'S', storageBackend: backend })
    await live.saveTranscriptRows([prompt('go'), ...readTurn(0)])
    const before = await live.hydrateMessagesForModel()
    live.releaseToolPayloads()
    expect(internals(live).toolCallDetails.size).toBe(1)
    expect(await live.hydrateMessagesForModel()).toStrictEqual(before)
  })

  it('releases nothing when persistence is disabled', async () => {
    const live = new BrowserConversationStore({ runtimeConfig: runtimeConfig(), sessionId: 'S', storageBackend: fakeFs().backend(), persistenceDisabled: true })
    await live.saveTranscriptRows([prompt('go'), ...readTurn(0)])
    const before = await live.hydrateMessagesForModel()
    expect(live.releaseToolPayloads()).toBe(false)
    expect(await live.hydrateMessagesForModel()).toStrictEqual(before)
  })
})

// ── What the UI sees does not change ────────────────────────────────────

describe('a released message renders the same', () => {
  it('sanitizing for the UI after the release equals sanitizing the full message', () => {
    for (const message of [prompt('go'), ...readTurn(0), ...bashTurn(1)]) {
      expect(sanitizeMessageForUi(sanitizeMessageForPersistence(message))).toStrictEqual(sanitizeMessageForUi(message))
    }
  })
})

// ── The worker's idle timer ──────────────────────────────────────────────

function workerWith(runtime: unknown): AgentRuntimeWorker {
  const worker = new AgentRuntimeWorker({ emit: () => {} })
  ;(worker as unknown as { runtimeScope: { runtime: unknown } }).runtimeScope = { runtime }
  return worker
}

function fakeRuntime(opts: { recorded?: (uuid: string) => boolean } = {}) {
  return {
    conversationStore: {
      releaseToolPayloads: vi.fn(() => true),
      isRecordedMessage: vi.fn(opts.recorded ?? (() => true)),
    },
    engine: {
      getMessages: () => [{ uuid: 'a' }, { uuid: 'b' }],
      releaseToolPayloads: vi.fn(),
    },
  }
}

type Timers = { scheduleIdlePayloadRelease(): void; cancelIdlePayloadRelease(): void }

describe('AgentRuntimeWorker idle payload release', () => {
  it('releases the store and the engine once the session has sat idle long enough', () => {
    vi.useFakeTimers()
    const runtime = fakeRuntime()
    const worker = workerWith(runtime) as unknown as Timers
    worker.scheduleIdlePayloadRelease()
    vi.advanceTimersByTime(IDLE_PAYLOAD_RELEASE_MS - 1)
    expect(runtime.conversationStore.releaseToolPayloads).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(runtime.conversationStore.releaseToolPayloads).toHaveBeenCalledTimes(1)
    expect(runtime.engine.releaseToolPayloads).toHaveBeenCalledTimes(1)
  })

  it('does nothing when a turn started in the meantime (the timer is cancelled)', () => {
    vi.useFakeTimers()
    const runtime = fakeRuntime()
    const worker = workerWith(runtime) as unknown as Timers
    worker.scheduleIdlePayloadRelease()
    worker.cancelIdlePayloadRelease()
    vi.advanceTimersByTime(IDLE_PAYLOAD_RELEASE_MS * 2)
    expect(runtime.conversationStore.releaseToolPayloads).not.toHaveBeenCalled()
  })

  it('does nothing to a runtime that replaced the one whose turn armed the timer', () => {
    vi.useFakeTimers()
    const armed = fakeRuntime()
    const rebuilt = fakeRuntime()
    const worker = workerWith(armed)
    ;(worker as unknown as Timers).scheduleIdlePayloadRelease()
    vi.advanceTimersByTime(IDLE_PAYLOAD_RELEASE_MS - 10)
    // A re-init installs a new scope; the old timer is still armed.
    ;(worker as unknown as { runtimeScope: { runtime: unknown } }).runtimeScope = { runtime: rebuilt }
    vi.advanceTimersByTime(IDLE_PAYLOAD_RELEASE_MS)
    expect(rebuilt.conversationStore.releaseToolPayloads).not.toHaveBeenCalled()
    expect(armed.conversationStore.releaseToolPayloads).not.toHaveBeenCalled()
  })

  it('does nothing while a turn is running', () => {
    vi.useFakeTimers()
    const runtime = fakeRuntime()
    const worker = workerWith(runtime)
    ;(worker as unknown as { turns: { isBusy(): boolean } }).turns.isBusy = () => true
    ;(worker as unknown as Timers).scheduleIdlePayloadRelease()
    vi.advanceTimersByTime(IDLE_PAYLOAD_RELEASE_MS)
    expect(runtime.conversationStore.releaseToolPayloads).not.toHaveBeenCalled()
  })

  it('leaves the engine alone while it holds a message the store never recorded (a fork seed)', () => {
    vi.useFakeTimers()
    const runtime = fakeRuntime({ recorded: uuid => uuid !== 'b' })
    const worker = workerWith(runtime) as unknown as Timers
    worker.scheduleIdlePayloadRelease()
    vi.advanceTimersByTime(IDLE_PAYLOAD_RELEASE_MS)
    expect(runtime.conversationStore.releaseToolPayloads).toHaveBeenCalledTimes(1)
    expect(runtime.engine.releaseToolPayloads).not.toHaveBeenCalled()
  })
})
