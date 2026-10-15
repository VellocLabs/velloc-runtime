/**
 * The runtime's end of the window audio player (`$.audio`, F-25): a clip or
 * an utterance goes to the newest window of the kernel's control-port pool,
 * which plays it (`windowAudioHost.ts`). One window plays each request, so
 * two windows open on the session do not double it; a window the browser
 * will not let play yet hands the request to the next one.
 */

/**
 * Contract: `play` / `speak` resolve when the window reports the sound over;
 * they reject with the window's error, `NotSupportedError` when no window is
 * attached, `AbortError` when `signal` aborts (the window is told to stop),
 * and `AbortError` when the window playing it goes away.
 */

import {
  addKernelWindowListener,
  kernelControlPortsNewestFirst,
  type KernelWindowListener,
} from './IsolatedWorkerKernel'
import type {
  WindowAudioPlayMessage,
  WindowAudioSource,
  WindowAudioSpeakMessage,
  WindowAudioToWindow,
} from './kernelProtocol'

export type WindowAudioPlayRequest = { source: WindowAudioSource; loop: boolean; gain: number }
export type WindowAudioSpeakRequest = { text: string; voice?: string }

export type WindowAudioPlayer = {
  play(request: WindowAudioPlayRequest, signal?: AbortSignal): Promise<void>
  speak(request: WindowAudioSpeakRequest, signal?: AbortSignal): Promise<void>
}

/** The pool the player rides; the kernel's own by default, a fake in tests. */
export type WindowAudioPool = {
  /** Every attached window's port, the one new work goes to first. */
  ports(): MessagePort[]
  listen(listener: KernelWindowListener): () => void
}

const KERNEL_POOL: WindowAudioPool = {
  ports: kernelControlPortsNewestFirst,
  listen: addKernelWindowListener,
}

function named(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

export function createWindowAudioPlayer(pool: WindowAudioPool = KERNEL_POOL): WindowAudioPlayer {
  const pending = new Map<string, { port: MessagePort; settle: (error?: Error) => void }>()
  let seq = 0
  let unlisten: (() => void) | undefined

  const listen = (): void => {
    if (unlisten) return
    unlisten = pool.listen({
      audioEnded: (port, message) => {
        const waiting = pending.get(message.id)
        if (!waiting || waiting.port !== port) return
        waiting.settle(message.error ? named(message.error.name, message.error.message) : undefined)
      },
      left: port => {
        for (const waiting of [...pending.values()]) {
          if (waiting.port === port) waiting.settle(named('AbortError', 'the window playing the sound went away'))
        }
      },
    })
  }

  type Outgoing = Omit<WindowAudioPlayMessage, 'id'> | Omit<WindowAudioSpeakMessage, 'id'>

  const send = async (message: Outgoing, signal?: AbortSignal): Promise<void> => {
    const ports = pool.ports()
    if (ports.length === 0) throw named('NotSupportedError', 'no Velloc window is open to play sound')
    for (let i = 0; ; i++) {
      try {
        return await sendTo(ports[i]!, message, signal)
      } catch (error) {
        // A window no person has interacted with may not play; another may.
        if (!(error instanceof Error && error.name === 'NotAllowedError') || i === ports.length - 1) throw error
      }
    }
  }

  const sendTo = (port: MessagePort, message: Outgoing, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(named('AbortError', 'the sound was stopped'))
    listen()
    const id = `a${++seq}`
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        try {
          port.postMessage({ type: 'audio.stop', id } satisfies WindowAudioToWindow)
        } catch {
          // The window is gone; its `left` settles nothing more for this id.
        }
        settle(named('AbortError', 'the sound was stopped'))
      }
      const settle = (error?: Error): void => {
        if (!pending.delete(id)) return
        // Listen only while a sound is out, so a gone runtime leaves no listener.
        if (pending.size === 0) {
          unlisten?.()
          unlisten = undefined
        }
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve()
      }
      pending.set(id, { port, settle })
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        port.postMessage({ ...message, id } as WindowAudioToWindow)
      } catch (error) {
        settle(named('NotSupportedError', `the window could not be asked to play: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
  }

  return {
    play: (request, signal) =>
      send({ type: 'audio.play', source: request.source, loop: request.loop, gain: request.gain }, signal),
    speak: (request, signal) =>
      send({ type: 'audio.speak', text: request.text, ...(request.voice !== undefined ? { voice: request.voice } : {}) }, signal),
  }
}
