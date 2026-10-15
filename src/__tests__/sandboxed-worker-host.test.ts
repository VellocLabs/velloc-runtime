/**
 * The sandboxed worker host, both sides, with fakes for the DOM: the PAGE side (`SandboxedWorkerHost`: frame,
 * handshake, control-port transfer, no-fallback failure) and the FRAME side (`spawnerFrame`: whose init it accepts,
 * what it will spawn). The opaque origin and the frame's CSP are for the e2e.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  modSpawnerFrameSrcdoc,
  modWorkerUrl,
  runJsWorkerUrl,
  spawnerFrameSrcdoc,
} from 'virtual:isolated-worker-sources'
import { RUN_JS_WORKER_KIND } from '../browser/runJs/runJsProtocol'
import { installKernelWindowHost } from '../browser/workerKernel/KernelWindowHost'
import { MOD_WORKER_KIND } from '../mods/modTypes'
import {
  SANDBOX_FRAME_FAILED_MESSAGE,
  installSandboxedWorkerHost,
  installSandboxedWorkerHosts,
} from '../browser/workerKernel/SandboxedWorkerHost'

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5))
import { installSpawnerFrame, workerNameOf } from '../browser/workerKernel/spawnerFrame'

type Listener = (event: MessageEvent) => void

function makeFrame() {
  const contentWindow = {
    posts: [] as Array<{ message: unknown; targetOrigin: string; transfer: unknown[] }>,
    postMessage(message: unknown, targetOrigin: string, transfer: unknown[] = []) {
      this.posts.push({ message, targetOrigin, transfer })
    },
  }
  return {
    attributes: {} as Record<string, string>,
    style: {} as Record<string, string>,
    srcdoc: '',
    contentWindow,
    removed: 0,
    setAttribute(name: string, value: string) {
      this.attributes[name] = value
    },
    remove() {
      this.removed += 1
    },
  }
}

function makeDom() {
  const frames: ReturnType<typeof makeFrame>[] = []
  const appended: unknown[] = []
  const listeners = new Set<Listener>()
  const pageHide = new Set<(event: Event) => void>()
  const doc = {
    createElement(tag: string) {
      expect(tag).toBe('iframe')
      const frame = makeFrame()
      frames.push(frame)
      return frame
    },
    body: {
      appendChild(node: unknown) {
        appended.push(node)
      },
    },
  }
  const win = {
    addEventListener(type: string, fn: Listener) {
      if (type === 'pagehide') pageHide.add(fn as unknown as (event: Event) => void)
      else listeners.add(fn)
    },
    removeEventListener(type: string, fn: Listener) {
      if (type === 'pagehide') pageHide.delete(fn as unknown as (event: Event) => void)
      else listeners.delete(fn)
    },
  }
  return {
    doc: doc as unknown as Document,
    win: win as unknown as Window,
    frames,
    appended,
    /** Deliver a window `message` event from `source`. */
    deliver(source: unknown, data: unknown) {
      for (const fn of [...listeners]) fn({ source, data } as unknown as MessageEvent)
    },
    /** Fire the window's `pagehide` (`persisted`: into the back/forward cache). */
    hidePage(persisted: boolean) {
      for (const fn of [...pageHide]) fn({ persisted } as unknown as Event)
    },
    get listening() {
      return listeners.size
    },
    get hideListening() {
      return pageHide.size
    },
  }
}

function makeControlPort() {
  let listener: Listener | null = null
  return {
    posts: [] as Array<Record<string, unknown>>,
    started: false,
    addEventListener(_type: string, fn: Listener) {
      listener = fn
    },
    removeEventListener() {
      listener = null
    },
    start() {
      this.started = true
    },
    postMessage(message: unknown) {
      this.posts.push(message as Record<string, unknown>)
    },
    deliver(data: unknown, ports: unknown[] = []) {
      listener?.({ data, ports } as unknown as MessageEvent)
    },
    get listening() {
      return listener !== null
    },
  }
}

const URLS = { probe: 'data:text/javascript;base64,AAAA' }

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('SandboxedWorkerHost (page side)', () => {
  it('creates ONE hidden frame sandboxed to scripts only, holding the given document', () => {
    const dom = makeDom()
    const control = makeControlPort()
    installSandboxedWorkerHost(control as unknown as MessagePort, {
      srcdoc: '<doc>',
      workerUrls: URLS,
      document: dom.doc,
      window: dom.win,
    })
    expect(dom.frames).toHaveLength(1)
    const frame = dom.frames[0]!
    // Exactly `allow-scripts`: `allow-same-origin` here would give the frame —
    // and every worker it spawns — the app's origin back.
    expect(frame.attributes.sandbox).toBe('allow-scripts')
    expect(frame.style.display).toBe('none')
    expect(frame.srcdoc).toBe('<doc>')
    expect(dom.appended).toEqual([frame])
    // The page itself never listens on the control port: it is the frame's.
    expect(control.listening).toBe(false)
    expect(control.started).toBe(false)
  })

  it('hands the frame the control port and the worker URLs once it announces itself', () => {
    const dom = makeDom()
    const control = makeControlPort()
    installSandboxedWorkerHost(control as unknown as MessagePort, {
      srcdoc: '<doc>',
      workerUrls: URLS,
      document: dom.doc,
      window: dom.win,
    })
    const frame = dom.frames[0]!
    dom.deliver(frame.contentWindow, { type: 'workerHost.frameReady' })
    expect(frame.contentWindow.posts).toEqual([
      {
        message: { type: 'workerHost.frameInit', workerUrls: URLS },
        targetOrigin: '*',
        transfer: [control],
      },
    ])
    // One transfer: the listener is gone, and a repeat is ignored.
    expect(dom.listening).toBe(0)
    dom.deliver(frame.contentWindow, { type: 'workerHost.frameReady' })
    expect(frame.contentWindow.posts).toHaveLength(1)
  })

  it('ignores a ready that is not from its own frame, or is not a ready', () => {
    const dom = makeDom()
    const control = makeControlPort()
    installSandboxedWorkerHost(control as unknown as MessagePort, {
      srcdoc: '<doc>',
      workerUrls: URLS,
      document: dom.doc,
      window: dom.win,
    })
    const frame = dom.frames[0]!
    dom.deliver({ some: 'other window' }, { type: 'workerHost.frameReady' })
    dom.deliver(frame.contentWindow, { type: 'something.else' })
    dom.deliver(frame.contentWindow, null)
    expect(frame.contentWindow.posts).toEqual([])
    expect(dom.listening).toBe(1)
  })

  it('has NO same-origin fallback: a frame that never starts fails every spawn with the reason', () => {
    vi.useFakeTimers()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dom = makeDom()
    const control = makeControlPort()
    installSandboxedWorkerHost(control as unknown as MessagePort, {
      srcdoc: '<doc>',
      workerUrls: URLS,
      document: dom.doc,
      window: dom.win,
      readyTimeoutMs: 1_000,
    })
    vi.advanceTimersByTime(999)
    expect(control.listening).toBe(false)
    vi.advanceTimersByTime(1)
    expect(error).toHaveBeenCalledOnce()
    expect(control.started).toBe(true)
    control.deliver({ type: 'worker.spawn', key: 'probe-1', kind: 'probe', init: null }, [{}])
    control.deliver({ type: 'worker.terminate', key: 'probe-1' })
    expect(control.posts).toEqual([
      { type: 'worker.error', key: 'probe-1', message: SANDBOX_FRAME_FAILED_MESSAGE },
    ])
    // A ready that arrives after the deadline does not get the port: the page
    // has already answered for the frame.
    dom.deliver(dom.frames[0]!.contentWindow, { type: 'workerHost.frameReady' })
    expect(dom.frames[0]!.contentWindow.posts).toEqual([])
  })

  it('a frame that announces itself in time cancels the deadline', () => {
    vi.useFakeTimers()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dom = makeDom()
    const control = makeControlPort()
    installSandboxedWorkerHost(control as unknown as MessagePort, {
      srcdoc: '<doc>',
      workerUrls: URLS,
      document: dom.doc,
      window: dom.win,
      readyTimeoutMs: 1_000,
    })
    dom.deliver(dom.frames[0]!.contentWindow, { type: 'workerHost.frameReady' })
    vi.advanceTimersByTime(5_000)
    expect(error).not.toHaveBeenCalled()
    expect(control.listening).toBe(false)
  })

  it('dispose removes the frame, stops listening and disarms the deadline', () => {
    vi.useFakeTimers()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dom = makeDom()
    const control = makeControlPort()
    const handle = installSandboxedWorkerHost(control as unknown as MessagePort, {
      srcdoc: '<doc>',
      workerUrls: URLS,
      document: dom.doc,
      window: dom.win,
      readyTimeoutMs: 1_000,
    })
    handle.dispose()
    handle.dispose()
    expect(dom.frames[0]!.removed).toBe(1)
    expect(dom.listening).toBe(0)
    vi.advanceTimersByTime(5_000)
    expect(error).not.toHaveBeenCalled()
    expect(control.listening).toBe(false)
  })
})

describe('installSandboxedWorkerHosts — several frames behind one control port (F-25)', () => {
  /** The frame's end of its channel, as the fake frame receives it: the page
   *  transferred a real MessagePort, so listen on it. */
  function frameEnd(frame: ReturnType<typeof makeFrame>) {
    const port = frame.contentWindow.posts[0]!.transfer[0] as MessagePort
    const received: Array<{ data: unknown; ports: number }> = []
    port.addEventListener('message', (event: MessageEvent) => {
      received.push({ data: event.data, ports: event.ports.length })
    })
    port.start()
    return { port, received }
  }

  function twoFrames(options: { readyTimeoutMs?: number } = {}) {
    const dom = makeDom()
    const control = makeControlPort()
    const handle = installSandboxedWorkerHosts(control as unknown as MessagePort, {
      frames: [
        { srcdoc: '<runjs>', workerUrls: { runjs: URLS.probe } },
        { srcdoc: '<mod>', workerUrls: { mod: URLS.probe } },
      ],
      document: dom.doc,
      window: dom.win,
      ...options,
    })
    return { dom, control, handle }
  }

  it('creates one frame per document, each handed a port of its own, and keeps the kernel port itself', () => {
    const { dom, control } = twoFrames()
    expect(dom.frames.map(f => f.srcdoc)).toEqual(['<runjs>', '<mod>'])
    expect(dom.frames.every(f => f.attributes.sandbox === 'allow-scripts')).toBe(true)
    // The page listens on the kernel's port now: it is the relay.
    expect(control.listening).toBe(true)
    expect(control.started).toBe(true)
    for (const frame of dom.frames) dom.deliver(frame.contentWindow, { type: 'workerHost.frameReady' })
    const ports = dom.frames.map(f => f.contentWindow.posts[0]!.transfer[0])
    expect(ports[0]).toBeInstanceOf(MessagePort)
    expect(ports[0]).not.toBe(ports[1])
    expect(ports[0]).not.toBe(control)
    expect(dom.frames[0]!.contentWindow.posts[0]!.message).toEqual({
      type: 'workerHost.frameInit',
      workerUrls: { runjs: URLS.probe },
    })
    expect(dom.frames[1]!.contentWindow.posts[0]!.message).toEqual({
      type: 'workerHost.frameInit',
      workerUrls: { mod: URLS.probe },
    })
  })

  it('routes a spawn to the frame of its kind with the data port, a terminate to the frame that spawned the key, and answers back to the kernel', async () => {
    const { dom, control } = twoFrames()
    for (const frame of dom.frames) dom.deliver(frame.contentWindow, { type: 'workerHost.frameReady' })
    const runjs = frameEnd(dom.frames[0]!)
    const mod = frameEnd(dom.frames[1]!)
    const peer = new MessageChannel()
    control.deliver({ type: 'worker.spawn', key: 'mod-1', kind: 'mod', init: { a: 1 } }, [peer.port1])
    control.deliver({ type: 'worker.spawn', key: 'runjs-1', kind: 'runjs', init: null }, [peer.port2])
    await tick()
    expect(mod.received).toEqual([
      { data: { type: 'worker.spawn', key: 'mod-1', kind: 'mod', init: { a: 1 } }, ports: 1 },
    ])
    expect(runjs.received).toEqual([
      { data: { type: 'worker.spawn', key: 'runjs-1', kind: 'runjs', init: null }, ports: 1 },
    ])
    control.deliver({ type: 'worker.terminate', key: 'mod-1' })
    control.deliver({ type: 'worker.terminate', key: 'never-spawned' })
    await tick()
    expect(mod.received).toHaveLength(2)
    expect(mod.received[1]).toEqual({ data: { type: 'worker.terminate', key: 'mod-1' }, ports: 0 })
    expect(runjs.received).toHaveLength(1)
    // What a frame answers reaches the kernel.
    mod.port.postMessage({ type: 'worker.spawned', key: 'mod-1' })
    runjs.port.postMessage({ type: 'worker.error', key: 'runjs-1', message: 'boom' })
    runjs.port.postMessage({ type: 'something.else' })
    await tick()
    // Two ports, so no order between them.
    expect(control.posts).toHaveLength(2)
    expect(control.posts).toEqual(
      expect.arrayContaining([
        { type: 'worker.spawned', key: 'mod-1' },
        { type: 'worker.error', key: 'runjs-1', message: 'boom' },
      ]),
    )
    // A spawn that failed is forgotten: its key no longer routes a terminate.
    control.deliver({ type: 'worker.terminate', key: 'runjs-1' })
    await tick()
    expect(runjs.received).toHaveLength(1)
  })

  it('answers a kind no frame has with worker.error, by name', () => {
    const { control } = twoFrames()
    control.deliver({ type: 'worker.spawn', key: 'x-1', kind: 'x', init: null }, [new MessageChannel().port1])
    expect(control.posts).toEqual([
      { type: 'worker.error', key: 'x-1', message: 'no worker host is installed for kind "x"' },
    ])
  })

  it("a frame that never starts fails ITS kinds' spawns with the reason; the other frame's go on", async () => {
    vi.useFakeTimers()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { dom, control } = twoFrames({ readyTimeoutMs: 1_000 })
    // The run_js frame announces itself; the mod frame never does.
    dom.deliver(dom.frames[0]!.contentWindow, { type: 'workerHost.frameReady' })
    vi.advanceTimersByTime(1_000)
    expect(error).toHaveBeenCalledOnce()
    vi.useRealTimers()
    const runjs = frameEnd(dom.frames[0]!)
    control.deliver({ type: 'worker.spawn', key: 'mod-1', kind: 'mod', init: null }, [new MessageChannel().port1])
    control.deliver({ type: 'worker.spawn', key: 'runjs-1', kind: 'runjs', init: null }, [new MessageChannel().port1])
    await tick()
    expect(control.posts).toEqual([
      { type: 'worker.error', key: 'mod-1', message: SANDBOX_FRAME_FAILED_MESSAGE },
    ])
    expect(runjs.received.map(r => (r.data as { key: string }).key)).toEqual(['runjs-1'])
  })

  it('tells the kernel when the window goes away — but not when it is only frozen in the back/forward cache', () => {
    const { dom, control } = twoFrames()
    dom.hidePage(true)
    expect(control.posts).toEqual([])
    dom.hidePage(false)
    expect(control.posts).toEqual([{ type: 'window.leaving' }])
  })

  it('dispose removes every frame and stops relaying', () => {
    const { dom, control, handle } = twoFrames()
    handle.dispose()
    handle.dispose()
    expect(dom.frames.map(f => f.removed)).toEqual([1, 1])
    expect(control.listening).toBe(false)
    expect(dom.hideListening).toBe(0)
  })
})

describe('installKernelWindowHost', () => {
  it('gives run_js and mod a frame each — the mod frame under the policy without unsafe-eval', () => {
    const dom = makeDom()
    const control = makeControlPort()
    installKernelWindowHost(control as unknown as MessagePort, { document: dom.doc, window: dom.win })
    expect(dom.frames).toHaveLength(2)
    const [runjs, mod] = dom.frames
    expect(runjs!.srcdoc).toBe(spawnerFrameSrcdoc)
    expect(mod!.srcdoc).toBe(modSpawnerFrameSrcdoc)
    expect(mod!.srcdoc).not.toContain('unsafe-eval')
    dom.deliver(runjs!.contentWindow, { type: 'workerHost.frameReady' })
    dom.deliver(mod!.contentWindow, { type: 'workerHost.frameReady' })
    expect(runjs!.contentWindow.posts[0]!.message).toEqual({
      type: 'workerHost.frameInit',
      workerUrls: { [RUN_JS_WORKER_KIND]: runJsWorkerUrl },
    })
    expect(mod!.contentWindow.posts[0]!.message).toEqual({
      type: 'workerHost.frameInit',
      workerUrls: { [MOD_WORKER_KIND]: modWorkerUrl },
    })
    expect([RUN_JS_WORKER_KIND, MOD_WORKER_KIND]).toEqual(['runjs', 'mod'])
  })
})

describe('spawnerFrame (frame side)', () => {
  function makeScope() {
    let listener: Listener | null = null
    const parent = {
      posts: [] as Array<{ message: unknown; targetOrigin: string }>,
      postMessage(message: unknown, targetOrigin: string) {
        this.posts.push({ message, targetOrigin })
      },
    }
    const created: Array<{ url: string; kind: string; name?: string; worker: ReturnType<typeof makeWorker> }> = []
    const scope = {
      parent,
      addEventListener(_type: 'message', fn: Listener) {
        listener = fn
      },
    }
    installSpawnerFrame(scope, (url, kind, name) => {
      const worker = makeWorker()
      created.push({ url, kind, ...(name !== undefined ? { name } : {}), worker })
      return worker as unknown as Worker
    })
    return {
      parent,
      created,
      deliver(source: unknown, data: unknown, ports: unknown[] = []) {
        listener?.({ source, data, ports } as unknown as MessageEvent)
      },
    }
  }

  function makeWorker() {
    return {
      posts: [] as Array<{ message: unknown; transfer: unknown[] }>,
      onerror: null as unknown,
      postMessage(message: unknown, transfer: unknown[] = []) {
        this.posts.push({ message, transfer })
      },
      terminate() {},
    }
  }

  const INIT = {
    type: 'workerHost.frameInit',
    workerUrls: {
      runjs: 'data:text/javascript;base64,AAAA',
      evil: 'https://example.com/worker.js',
      blob: 'blob:https://app.example/abc',
    },
  }

  it('announces itself to its parent', () => {
    const { parent } = makeScope()
    expect(parent.posts).toEqual([
      { message: { type: 'workerHost.frameReady' }, targetOrigin: '*' },
    ])
  })

  it('takes its init from the parent only', () => {
    const { parent, deliver } = makeScope()
    const stranger = makeControlPort()
    deliver({ not: 'the parent' }, INIT, [stranger])
    expect(stranger.listening).toBe(false)
    // Not an init, or an init with no port: ignored, and still waiting.
    deliver(parent, { type: 'other' }, [stranger])
    deliver(parent, INIT, [])
    expect(stranger.listening).toBe(false)
    const control = makeControlPort()
    deliver(parent, INIT, [control])
    expect(control.listening).toBe(true)
    expect(control.started).toBe(true)
  })

  it('takes its init ONCE', () => {
    const { parent, deliver } = makeScope()
    const first = makeControlPort()
    const second = makeControlPort()
    deliver(parent, INIT, [first])
    deliver(parent, INIT, [second])
    expect(first.listening).toBe(true)
    expect(second.listening).toBe(false)
  })

  it('spawns a data: worker for its kind, hands it init + port, and acks', () => {
    const { parent, deliver, created } = makeScope()
    const control = makeControlPort()
    deliver(parent, INIT, [control])
    const peer = { peer: true }
    control.deliver({ type: 'worker.spawn', key: 'runjs-1', kind: 'runjs', init: { code: 'x' } }, [peer])
    expect(created.map(c => [c.url, c.kind])).toEqual([
      ['data:text/javascript;base64,AAAA', 'runjs'],
    ])
    expect(created[0]!.worker.posts).toEqual([
      { message: { type: 'worker.init', init: { code: 'x' } }, transfer: [peer] },
    ])
    expect(control.posts).toEqual([{ type: 'worker.spawned', key: 'runjs-1' }])
  })

  it('names a worker by its kind, and by the name its spawn gives (a mod: its plugin)', () => {
    const { parent, deliver, created } = makeScope()
    const control = makeControlPort()
    deliver(parent, INIT, [control])
    control.deliver({ type: 'worker.spawn', key: 'runjs-1', kind: 'runjs', init: null, name: 'task-queue' }, [{}])
    control.deliver({ type: 'worker.spawn', key: 'runjs-2', kind: 'runjs', init: null }, [{}])
    expect(created.map(c => c.name)).toEqual(['task-queue', undefined])
    // What DevTools lists them as.
    expect(workerNameOf('mod', 'task-queue')).toBe('nexus-mod: task-queue')
    expect(workerNameOf('runjs')).toBe('nexus-runjs')
    expect(workerNameOf('mod', '  ')).toBe('nexus-mod')
    expect(workerNameOf('mod', 'x'.repeat(200))).toBe(`nexus-mod: ${'x'.repeat(80)}`)
  })

  it('will not spawn a kind whose URL is not data:', () => {
    const { parent, deliver, created } = makeScope()
    const control = makeControlPort()
    deliver(parent, INIT, [control])
    control.deliver({ type: 'worker.spawn', key: 'evil-1', kind: 'evil', init: null }, [{}])
    control.deliver({ type: 'worker.spawn', key: 'blob-1', kind: 'blob', init: null }, [{}])
    expect(created).toEqual([])
    expect(control.posts.map(p => [p.type, p.key])).toEqual([
      ['worker.error', 'evil-1'],
      ['worker.error', 'blob-1'],
    ])
  })
})
