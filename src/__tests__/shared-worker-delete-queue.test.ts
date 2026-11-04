import { describe, expect, it, vi } from 'vitest'
import { SharedWorkerSessionManager } from '../browser/worker/SharedWorkerSessionManager'

// The runtime runs `session.delete` requests one at a time, in arrival order,
// whichever client sends them; a failed delete does not stop the ones behind it. (F-17)

function createPort() {
  const handlers: Array<(event: MessageEvent) => void> = []
  const port = {
    addEventListener: (type: string, handler: (event: MessageEvent) => void) => {
      if (type === 'message') handlers.push(handler)
    },
    removeEventListener: () => {},
    postMessage: () => {},
    start: () => {},
    close: () => {},
    onmessage: null,
    onmessageerror: null,
    dispatchEvent: () => true,
  } as unknown as MessagePort
  const send = (data: unknown) => {
    for (const handler of handlers) handler({ data, ports: [] } as unknown as MessageEvent)
  }
  return { port, send }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 10))

describe('the runtime delete queue', () => {
  it('runs session deletes one at a time, in arrival order, and goes on past a failed one', async () => {
    const manager = new SharedWorkerSessionManager({
      createWorker: () => {
        throw new Error('no session worker in this test')
      },
    })
    const { port, send } = createPort()
    manager.handleConnect(port)
    const events: string[] = []
    const releases = new Map<string, () => void>()
    const internals = manager as unknown as {
      handleSessionDelete(port: unknown, sessionId: string): Promise<void>
    }
    internals.handleSessionDelete = (_port, sessionId) => {
      events.push(`start ${sessionId}`)
      return new Promise<void>((resolve, reject) => {
        releases.set(sessionId, () => {
          events.push(`end ${sessionId}`)
          if (sessionId === 'a') reject(new Error('row delete failed'))
          else resolve()
        })
      })
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const id of ['a', 'b', 'c']) send({ type: 'session.delete', sessionId: id })
      await tick()
      expect(events).toEqual(['start a'])
      releases.get('a')!()
      await tick()
      expect(events).toEqual(['start a', 'end a', 'start b'])
      releases.get('b')!()
      await tick()
      releases.get('c')!()
      await tick()
      expect(events).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
      expect(warn.mock.calls.some(call => String(call[0]).includes('delete of a failed'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })
})
