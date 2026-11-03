import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { openRawProviderStream } from '../browser/bridge/rawProviderStream'
import '../models/drivers/builtinDrivers'
import { DriverStreamHost } from '../models/drivers/driverStreamHost'
import { createModelProvider } from '../models/drivers/modelProvider'
import { registerProviderDriver } from '../models/drivers/driverRegistry'
import type { DriverStreamEvent, ProviderDriver } from '../models/drivers/driverTypes'
import { findEgressResidual, MaskingResidualError } from '../models/masking/egressGuard'
import { modelMasking } from '../models/masking/maskingHolder'
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
  const sink: MaskingLogSink = {
    async append(path, text) {
      files.set(path, (files.get(path) ?? '') + text)
    },
    async size(path) {
      const text = files.get(path)
      return text === undefined ? undefined : text.length
    },
    async rename(from, to) {
      files.set(to, files.get(from)!)
      files.delete(from)
    },
    async remove(path) {
      files.delete(path)
    },
  }
  return { sink, files }
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

    await vi.waitFor(() => expect(files.get('/logs/masking.log')).toMatch(/dir=in/))
    const log = files.get('/logs/masking.log') ?? ''
    expect(log).toMatch(/event=rules_set\|count=2/)
    expect(log).toMatch(new RegExp(`stream=${streamId}\\|provider=masking-p\\|model=m\\|dir=out\\|rule=1\\|n=1\\|where=messages`))
    expect(log).toMatch(/dir=out\|rule=1\|n=1\|where=system/)
    expect(log).toMatch(/dir=in\|rule=1\|n=1\|where=text/)
    expect(log).toMatch(/dir=in\|rule=1\|n=1\|where=tool_args/)
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
    expect(error.error.message).toContain('masking rule 1 (in url)')
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

describe('the rules_set log line', () => {
  it('is written when a table becomes active, not on a change that keeps it', async () => {
    const { sink, files } = memorySink()
    modelMasking.setLogSink(sink)
    modelMasking.configure({ rules: RULES, logPath: '/l' })
    modelMasking.configure({ enabled: true, rules: RULES, logPath: '/l' })
    modelMasking.configure({ enabled: true, rules: RULES, logPath: '/l', logDetail: 'context' })
    await vi.waitFor(() => expect(files.get('/l')).toBeDefined())
    expect(files.get('/l')!.match(/event=rules_set\|count=2/g)).toHaveLength(1)
  })
})

describe('MaskingLogWriter', () => {
  it('formats key=value lines and leaves out empty fields', () => {
    expect(formatLogLine({ ts_ms: 1, event: 'refused', where: 'body', rule: undefined, ctx: 'a|b\nc' }))
      .toBe('ts_ms=1|event=refused|where=body|ctx=a b c\n')
  })

  it('rotates a full log and keeps four older files', async () => {
    const { sink, files } = memorySink()
    const writer = new MaskingLogWriter(sink, () => {})
    files.set('/l', 'x'.repeat(8 * 1024 * 1024))
    for (const n of [1, 2, 3, 4]) files.set(`/l.${n}`, `gen${n}`)
    await writer.append('/l', 'new\n')
    expect(files.get('/l')).toBe('new\n')
    expect(files.get('/l.1')!.length).toBe(8 * 1024 * 1024)
    expect(files.get('/l.2')).toBe('gen1')
    expect(files.get('/l.4')).toBe('gen3')
    expect(files.has('/l.5')).toBe(false)
  })

  it('reports a write failure without throwing', async () => {
    const errors: string[] = []
    const writer = new MaskingLogWriter(
      { append: async () => { throw new Error('disk full') }, size: async () => undefined },
      message => errors.push(message),
    )
    await writer.append('/l', 'x\n')
    expect(errors).toEqual(['disk full'])
  })
})
