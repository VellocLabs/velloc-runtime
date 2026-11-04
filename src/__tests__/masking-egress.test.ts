import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { openRawProviderStream } from '../browser/bridge/rawProviderStream'
import '../models/drivers/builtinDrivers'
import { DriverStreamHost } from '../models/drivers/driverStreamHost'
import { createModelProvider } from '../models/drivers/modelProvider'
import { registerProviderDriver } from '../models/drivers/driverRegistry'
import type { DriverStreamEvent, ProviderDriver } from '../models/drivers/driverTypes'
import { findEgressResidual, MaskingResidualError, MaskingUnavailableError } from '../models/masking/egressGuard'
import { MASKING_READ_RETRY_MS, modelMasking } from '../models/masking/maskingHolder'
import { maskingRefusalOf } from '../utils/maskingRefusal'
import { MaskingLogWriter, formatLogLine, type MaskingLogSink } from '../models/masking/maskingLog'
import { compileMasking } from '../models/masking/maskingRules'

const RULES = [
  { match: 'AcmeCo', alias: 'Northwind' },
  { match: 'café', alias: 'bistro' },
]

// A codec that sends the payload as JSON and reads newline-separated events.
const echoCodec: ProviderDriver = {
  id: 'masking-echo',
  auth: {},
  buildRequest: (payload, context) => ({
    url: `${context.baseUrl}/v1/chat`,
    headers: { 'content-type': 'application/json', 'x-key': '{{secret:acmeco_key}}' },
    body: new TextEncoder().encode(JSON.stringify(payload)),
  }),
  createDecoder: () => {
    const text = new TextDecoder()
    let buffered = ''
    const drain = (): DriverStreamEvent[] => {
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      return lines.filter(Boolean).map(l => JSON.parse(l) as DriverStreamEvent)
    }
    return {
      push: bytes => {
        buffered += text.decode(bytes, { stream: true })
        return drain()
      },
      end: () => {
        buffered += '\n'
        return drain()
      },
    }
  },
  errorFromResponse: ({ status }) => ({ type: 'error', message: `HTTP ${status}`, httpStatus: status }),
}
registerProviderDriver(echoCodec)

type Opened = { url: string; headers: Record<string, string>; body: string }

function recordingTransport(responseEvents: DriverStreamEvent[]) {
  const opened: Opened[] = []
  const bytes = new TextEncoder().encode(responseEvents.map(e => JSON.stringify(e)).join('\n') + '\n')
  let offset = 0
  const transport: BrowserBridgeTransport = {
    async request(req: any) {
      if (req.route.action === 'rawStreamOpen') {
        opened.push({
          url: req.payload.url,
          headers: req.payload.headers,
          body: new TextDecoder().decode(req.payload.body),
        })
        return { ok: true, result: { streamId: 'r', status: 200, statusText: '', finalUrl: 'u', headers: {} } } as any
      }
      if (req.route.action === 'rawStreamCancel') return { ok: true, result: { ok: true } } as any
      // Three bytes per read, so aliases arrive split.
      const chunk = bytes.slice(offset, offset + 3)
      offset += 3
      return { ok: true, result: { done: offset >= bytes.length, chunk } } as any
    },
  }
  return { transport, opened }
}

async function drain(host: DriverStreamHost, streamId: string) {
  const chunks: any[] = []
  for (let i = 0; i < 1000; i += 1) {
    const read = await host.read(streamId, 1000)
    chunks.push(...read.chunks)
    if (read.done) return chunks
  }
  throw new Error('stream never finished')
}

function memorySink() {
  const files = new Map<string, string>()
  const calls = { append: 0, write: 0 }
  const bytes = (text: string) => new TextEncoder().encode(text).length
  const sink: MaskingLogSink = {
    async append(path, text) {
      calls.append += 1
      files.set(path, (files.get(path) ?? '') + text)
    },
    async size(path) {
      const text = files.get(path)
      return text === undefined ? undefined : bytes(text)
    },
    async read(path) {
      return files.get(path)
    },
    async write(path, text) {
      calls.write += 1
      files.set(path, text)
    },
  }
  return { sink, files, calls }
}

const provider = () => createModelProvider({ id: 'masking-p', format: 'masking-echo', baseUrl: 'https://llm.example.com' })

afterEach(() => {
  modelMasking.configure(undefined)
  modelMasking.setLogSink(undefined)
})

describe('findEgressResidual', () => {
  const masking = compileMasking(RULES)
  const body = (text: string) => new TextEncoder().encode(text)

  it('finds a match in the url, a header, a query value and the body', () => {
    expect(findEgressResidual(masking, { url: 'https://acmeco.example/AcmeCo' })).toEqual({ where: 'url', rule: 0 })
    expect(findEgressResidual(masking, { url: 'https://x', headers: { 'User-Agent': 'AcmeCo/1' } }))
      .toEqual({ where: 'header:user-agent', rule: 0 })
    expect(findEgressResidual(masking, { url: 'https://x', queryParams: { q: 'AcmeCo' } })).toEqual({ where: 'query:q', rule: 0 })
    expect(findEgressResidual(masking, { url: 'https://x', body: body('{"a":"AcmeCo"}') })).toEqual({ where: 'body', rule: 0 })
  })

  it('finds a JSON-escaped match and a match inside binary bytes', () => {
    expect(findEgressResidual(masking, { url: 'https://x', body: body('{"a":"caf\\u00e9"}') })).toEqual({ where: 'body', rule: 1 })
    const proto = new Uint8Array([0x0a, 0x86, 0xff, ...new TextEncoder().encode('AcmeCo'), 0x12])
    expect(findEgressResidual(masking, { url: 'https://x', body: proto })).toEqual({ where: 'body', rule: 0 })
  })

  it('does not scan host-side placeholders', () => {
    expect(findEgressResidual(masking, { url: 'https://x', headers: { auth: 'Bearer {{secret:AcmeCo_key}}' } })).toBeUndefined()
  })
})

describe('the egress check on openRawProviderStream', () => {
  it('stops a request that still holds a match before it reaches the host', async () => {
    modelMasking.configure({ enabled: true, rules: RULES })
    const { transport, opened } = recordingTransport([])
    await expect(
      openRawProviderStream(transport, { providerId: 'p', url: 'https://x/AcmeCo' }),
    ).rejects.toBeInstanceOf(MaskingResidualError)
    expect(opened).toEqual([])
  })

  it('is removed when masking is turned off', async () => {
    modelMasking.configure({ enabled: true, rules: RULES })
    modelMasking.configure({ enabled: false, rules: RULES })
    const { transport, opened } = recordingTransport([])
    await openRawProviderStream(transport, { providerId: 'p', url: 'https://x/AcmeCo' })
    expect(opened).toHaveLength(1)
  })
})

describe('DriverStreamHost with masking on', () => {
  it('sends aliases, restores the reply, and logs both directions', async () => {
    const { sink, files } = memorySink()
    modelMasking.setLogSink(sink)
    modelMasking.configure({ enabled: true, rules: RULES, logPath: '/logs/masking.log' })
    const { transport, opened } = recordingTransport([
      { type: 'text_delta', text: 'Northwind ships the bistro build' },
      { type: 'tool_call_start', id: 't1', name: 'Write' },
      { type: 'tool_call_delta', id: 't1', argsTextDelta: '{"content":"Northwind"}' },
      { type: 'finish', finishReason: 'tool_calls' },
    ])
    const host = new DriverStreamHost(transport)
    const { streamId } = host.start(
      provider(),
      { messages: [{ role: 'user', content: 'Ship the AcmeCo café build' }], systemPrompt: 'You are AcmeCo\'s agent' },
      'm',
    )
    const chunks = await drain(host, streamId)

    expect(opened).toHaveLength(1)
    expect(opened[0]!.body).toContain('Ship the Northwind bistro build')
    expect(opened[0]!.body).not.toContain('AcmeCo')
    const text = chunks
      .filter(c => c.type === 'content_block_delta' && c.delta?.type === 'text_delta')
      .map(c => c.delta.text)
      .join('')
    expect(text).toBe('AcmeCo ships the café build')
    const call = chunks.find(c => c.type === 'content_block_start' && c.content_block?.type === 'tool-call')
    expect(call.content_block.args).toEqual({ content: 'AcmeCo' })

    await vi.waitFor(() => expect(files.get('/logs/masking.log')?.split('|in|').length).toBeGreaterThan(1))
    const lines = (files.get('/logs/masking.log') ?? '').trimEnd().split('\n').map(line => line.split('|'))
    // Date, direction, where, original, replaced: nothing else is logged.
    expect(lines.every(fields => fields.length === 5 && new Date(fields[0]!).toISOString() === fields[0])).toBe(true)
    expect(lines).toHaveLength(6)
    const rows = lines.map(fields => fields.slice(1))
    const swap = ['Ship the AcmeCo café build', 'Ship the Northwind bistro build']
    expect(rows).toEqual(expect.arrayContaining([
      ['out', 'messages', ...swap],
      ['out', 'system', "You are AcmeCo's agent", "You are Northwind's agent"],
      ['in', 'text', 'Northwind ships the bistro build', 'AcmeCo ships the café build'],
      ['in', 'tool_args', '{"content":"Northwind"}', '{"content":"AcmeCo"}'],
    ]))
    // Outbound lines are written before the reply is read.
    expect(rows.slice(0, 3).every(row => row[0] === 'out')).toBe(true)
  })

  it('fails the stream without retry when the request would leak, and sends nothing', async () => {
    modelMasking.configure({ enabled: true, rules: RULES })
    const { transport, opened } = recordingTransport([])
    const host = new DriverStreamHost(transport)
    const leaky = createModelProvider({ id: 'masking-p', format: 'masking-echo', baseUrl: 'https://acmeco.example.com/AcmeCo' })
    const { streamId } = host.start(leaky, { messages: [{ role: 'user', content: 'hi' }] }, 'm')
    const chunks = await drain(host, streamId)
    expect(opened).toEqual([])
    const error = chunks.find(c => c.type === 'error')
    expect(maskingRefusalOf(error.error.message)).toEqual({ kind: 'residual', rule: 1, where: 'url' })
    expect(error.httpStatus ?? error.error.httpStatus).toBe(400)
  })

  it('sends the request unchanged when masking is off', async () => {
    modelMasking.configure({ enabled: false, rules: RULES })
    const { transport, opened } = recordingTransport([{ type: 'finish', finishReason: 'stop' }])
    const host = new DriverStreamHost(transport)
    const { streamId } = host.start(provider(), { messages: [{ role: 'user', content: 'AcmeCo' }] }, 'm')
    await drain(host, streamId)
    expect(opened[0]!.body).toContain('AcmeCo')
  })

  it('waits for the first settings read before sending', async () => {
    modelMasking.resetForTest()
    let release!: () => void
    const read = new Promise<{ enabled: boolean; rules: typeof RULES }>(resolve => {
      release = () => resolve({ enabled: true, rules: RULES })
    })
    const loaded = modelMasking.load(() => read)
    const { transport, opened } = recordingTransport([{ type: 'finish', finishReason: 'stop' }])
    const host = new DriverStreamHost(transport)
    const { streamId } = host.start(provider(), { messages: [{ role: 'user', content: 'AcmeCo' }] }, 'm')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(opened).toEqual([])
    release()
    await loaded
    await drain(host, streamId)
    expect(opened[0]!.body).toContain('Northwind')
  })
})

describe('MaskingLogWriter', () => {
  const entry = (n: number) => ({ at: Date.UTC(2026, 10, 4, 1, 2, 3, 456) + n, dir: 'out' as const, where: 'messages', original: `o${n}`, replaced: `r${n}` })
  const line = (n: number) => formatLogLine(entry(n))

  it('writes the date, direction, where, original and replaced text, one line each', () => {
    expect(line(0)).toBe('2026-11-04T01:02:03.456Z|out|messages|o0|r0\n')
  })

  it('removes line breaks from the logged text, and writes a pipe as an escaped pipe', () => {
    const text = formatLogLine({ at: 0, dir: 'in', where: 'text', original: 'a|b\r\nc\nd\re', replaced: 'x' })
    expect(text).toBe('1970-01-01T00:00:00.000Z|in|text|a\\|b c d e|x\n')
  })

  it('appends while under 5000 lines, and rewrites the file only to drop the oldest', async () => {
    const { sink, files, calls } = memorySink()
    const writer = new MaskingLogWriter(sink, () => {})
    await writer.append('/l', Array.from({ length: 4990 }, (_, n) => line(n)))
    await writer.append('/l', Array.from({ length: 10 }, (_, n) => line(4990 + n)))
    expect(calls).toEqual({ append: 2, write: 0 })
    expect(files.get('/l')!.trimEnd().split('\n')).toHaveLength(5000)

    await writer.append('/l', [line(5000), line(5001)])
    expect(calls.write).toBe(1)
    const kept = files.get('/l')!.trimEnd().split('\n')
    expect(kept).toHaveLength(5000)
    expect(kept[0]).toBe(line(2).trimEnd())
    expect(kept.at(-1)).toBe(line(5001).trimEnd())

    await writer.append('/l', [line(5002)])
    expect(files.get('/l')!.trimEnd().split('\n')).toHaveLength(5000)
    expect(files.get('/l')!.endsWith(line(5002))).toBe(true)
  })

  it('keeps the newest 5000 of one batch larger than the file allows', async () => {
    const { sink, files } = memorySink()
    const writer = new MaskingLogWriter(sink, () => {})
    await writer.append('/l', ['old\n'])
    await writer.append('/l', Array.from({ length: 5003 }, (_, n) => line(n)))
    const kept = files.get('/l')!.trimEnd().split('\n')
    expect(kept).toHaveLength(5000)
    expect(kept[0]).toBe(line(3).trimEnd())
  })

  it('counts again when the file was changed outside', async () => {
    const { sink, files } = memorySink()
    const writer = new MaskingLogWriter(sink, () => {})
    await writer.append('/l', [line(0)])
    files.set('/l', Array.from({ length: 4999 }, (_, n) => line(n)).join(''))
    await writer.append('/l', [line(1), line(2)])
    const kept = files.get('/l')!.trimEnd().split('\n')
    expect(kept).toHaveLength(5000)
    expect(kept.at(-1)).toBe(line(2).trimEnd())
    files.delete('/l')
    await writer.append('/l', [line(7)])
    expect(files.get('/l')).toBe(line(7))
  })

  it('reports a write failure without throwing', async () => {
    const errors: string[] = []
    const writer = new MaskingLogWriter(
      {
        append: async () => { throw new Error('disk full') },
        size: async () => undefined,
        read: async () => undefined,
        write: async () => {},
      },
      error => errors.push((error as Error).message),
    )
    await writer.append('/l', ['x\n'])
    expect(errors).toEqual(['disk full'])
  })
})
