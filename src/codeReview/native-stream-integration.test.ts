import { describe, expect, it } from 'vitest'
import { BridgeRequestRouter } from '../browser/worker/BridgeRequestRouter'
import type { AgentWorkerInboundMessage } from '../browser/worker/workerProtocol'
import { createNativePrimitives, bytesToBase64 } from '../browser/bridge/nativePrimitives'
import type { BrowserBridgeRequest } from '../browser/bridge/browserBridgeProtocol'
import { createGitArgvRunner } from './git-adapter'

describe('review Git native stream integration', () => {
  it('receives output and exit after spawn and stdin-close replies without broadcasting source to sessions', async () => {
    const channel = new MessageChannel()
    const received = new Map<string, AgentWorkerInboundMessage[]>([['review-session', []], ['other-session', []]])
    const router = new BridgeRequestRouter({
      getSessionWorker: id => ({ receiveFrame: async message => { received.get(id)!.push(message) } }),
      listSessionIds: () => received.keys(),
      onDirectTransportChanged: () => {},
    })
    router.setHostPort(channel.port1)
    const requests: BrowserBridgeRequest[] = []
    channel.port2.onmessage = event => {
      const request = JSON.parse(event.data) as BrowserBridgeRequest
      requests.push(request)
      channel.port2.postMessage(JSON.stringify({
        hostBridge: true, direction: 'response', id: request.id, route: request.route, ok: true,
        result: request.route.action === 'spawn' ? { streamId: 'git-stream' } : { found: true },
      }))
    }
    const direct = router.getDirectTransport()!
    const native = createNativePrimitives({ transport: direct, createRequestId: () => crypto.randomUUID(),
      manifest: { capabilities: ['shell'], primitives: ['shell.spawn.argv'] } })
    let closed!: () => void
    const stdinClosed = new Promise<void>(resolve => { closed = resolve })
    const cancel = new AbortController()
    const git = await createGitArgvRunner(async (spec, handlers) => {
      const child = await native.shell.spawnArgvStream(spec, handlers)
      return { ...child, async closeStdin() {
        const found = await child.closeStdin()
        closed()
        return found
      } }
    }, { authorizeRoot: async () => ({ root: 'D:/repo', gitDir: 'D:/repo/.git', commonDir: 'D:/repo/.git' }), timeoutMs: 2000 })
    const running = git.query({ kind: 'resolve', ref: 'HEAD' }, cancel.signal)
    // Observe rejection immediately, even if a failed assertion aborts the query.
    const completed = running.then(value => ({ value }), error => ({ error }))
    try {
      await stdinClosed
      expect(requests.map(request => request.route.action)).toEqual(['spawn', 'closeStdin'])
      const payload = requests[0]!.payload as { file: string; args: string[] }
      expect(payload.file).toBe('git')
      expect(payload.args.slice(-5)).toEqual(['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'])
      const send = (action: string, payload: unknown) => channel.port2.postMessage(JSON.stringify({
        hostBridge: true, direction: 'event', route: { namespace: 'nexus', capability: 'shell', action }, payload,
      }))
      send('onStreamOutput', { streamId: 'unrelated-stream', stream: 'stdout', dataBase64: bytesToBase64(new TextEncoder().encode('not ours')) })
      const expected = 'a'.repeat(40) + '\n'
      send('onStreamOutput', { streamId: 'git-stream', stream: 'stdout', dataBase64: bytesToBase64(new TextEncoder().encode(expected)) })
      send('onStreamExit', { streamId: 'git-stream', exitCode: 0, timedOut: false, killed: false, durationMs: 1 })
      const result = await completed
      if ('error' in result) throw result.error
      expect(result.value.exitCode).toBe(0)
      expect(new TextDecoder().decode(result.value.stdout)).toBe(expected)
      expect(received.get('review-session')).toEqual([])
      expect(received.get('other-session')).toEqual([])
      expect(requests.map(request => request.route.action)).toEqual(['spawn', 'closeStdin'])
    } finally {
      cancel.abort()
      direct.dispose()
      channel.port1.close()
      channel.port2.close()
    }
  })
})
