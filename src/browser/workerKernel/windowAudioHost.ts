/**
 * The window's audio player for `$.audio` (F-25): hears `audio.play` /
 * `audio.speak` / `audio.stop` on the kernel's control port and answers each
 * id with one `audio.ended`.
 */

/**
 * Contract:
 *   - a clip given as bytes plays through Web Audio (any gain 0–4, looped
 *     sample-exact); a clip given as a URL through a media element (its
 *     gain capped at 1 — a cross-origin element cannot be amplified);
 *   - clips play together; utterances wait for the ones before them;
 *   - a stopped clip or utterance ends without an error;
 *   - a page the browser will not let play sound yet (no person has
 *     interacted with it) answers `NotAllowedError`.
 */

import type {
  WindowAudioEndedMessage,
  WindowAudioPlayMessage,
  WindowAudioSpeakMessage,
  WindowAudioToWindow,
} from './kernelProtocol'

/** How long a suspended audio context may take to start before the page is
 *  taken to be one that may not play sound. */
export const WINDOW_AUDIO_RESUME_WAIT_MS = 1_000
/** How long the synthesizer's voice list may take to arrive. */
export const WINDOW_AUDIO_VOICES_WAIT_MS = 1_000

type Ended = WindowAudioEndedMessage['error']

/** What the player needs of the page; the real one by default. */
export type WindowAudioDeps = {
  audioContext?: () => AudioContext
  mediaElement?: (url: string) => HTMLAudioElement
  speech?: SpeechSynthesis
  utterance?: (text: string) => SpeechSynthesisUtterance
  resumeWaitMs?: number
  voicesWaitMs?: number
}

export type WindowAudioHostHandle = { dispose(): void }

function failure(name: string, message: string): NonNullable<Ended> {
  return { name, message }
}

function base64Bytes(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function installWindowAudioHost(port: MessagePort, deps: WindowAudioDeps = {}): WindowAudioHostHandle {
  const resumeWaitMs = deps.resumeWaitMs ?? WINDOW_AUDIO_RESUME_WAIT_MS
  const voicesWaitMs = deps.voicesWaitMs ?? WINDOW_AUDIO_VOICES_WAIT_MS
  const speech = deps.speech ?? (typeof speechSynthesis !== 'undefined' ? speechSynthesis : undefined)
  let context: AudioContext | undefined
  /** Each live clip or utterance's stop. */
  const stops = new Map<string, () => void>()
  /** Utterances not yet begun, in order; the head is speaking. */
  const queue: Array<{ id: string; message: WindowAudioSpeakMessage; stopped: boolean }> = []
  let disposed = false

  const ended = (id: string, error?: Ended): void => {
    if (!stops.has(id)) return
    stops.delete(id)
    try {
      port.postMessage({ type: 'audio.ended', id, ...(error ? { error } : {}) } satisfies WindowAudioEndedMessage)
    } catch {
      // The kernel's end is gone; nothing waits.
    }
  }

  const contextOf = (): AudioContext => {
    if (!context) context = deps.audioContext ? deps.audioContext() : new AudioContext()
    return context
  }

  const running = async (ctx: AudioContext): Promise<boolean> => {
    if (ctx.state === 'running') return true
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      ctx.resume().catch(() => undefined),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, resumeWaitMs)
      }),
    ])
    clearTimeout(timer)
    // `resume` changed it; the narrowing above does not know.
    return (ctx.state as AudioContextState) === 'running'
  }

  const playBytes = async (message: WindowAudioPlayMessage & { source: { base64: string; mime: string } }): Promise<void> => {
    const { id } = message
    let stopped = false
    let source: AudioBufferSourceNode | undefined
    stops.set(id, () => {
      stopped = true
      try {
        source?.stop()
      } catch {
        // Not started yet, or already over.
      }
      ended(id)
    })
    try {
      const ctx = contextOf()
      if (!(await running(ctx))) {
        ended(id, failure('NotAllowedError', 'the window may not play sound until the person interacts with it'))
        return
      }
      const buffer = await ctx.decodeAudioData(base64Bytes(message.source.base64))
      if (stopped) return
      const gain = ctx.createGain()
      gain.gain.value = message.gain
      gain.connect(ctx.destination)
      source = ctx.createBufferSource()
      source.buffer = buffer
      source.loop = message.loop
      source.connect(gain)
      source.onended = () => {
        gain.disconnect()
        ended(id)
      }
      source.start()
    } catch (error) {
      ended(id, failure('EncodingError', `the clip could not be decoded (${message.source.mime}): ${messageOf(error)}`))
    }
  }

  const playUrl = (message: WindowAudioPlayMessage & { source: { url: string } }): void => {
    const { id } = message
    const element = deps.mediaElement ? deps.mediaElement(message.source.url) : new Audio(message.source.url)
    element.loop = message.loop
    element.volume = Math.min(1, message.gain)
    stops.set(id, () => {
      element.pause()
      element.removeAttribute('src')
      ended(id)
    })
    element.addEventListener('ended', () => ended(id), { once: true })
    element.addEventListener(
      'error',
      () => ended(id, failure('NetworkError', `the clip could not be loaded from ${message.source.url}`)),
      { once: true },
    )
    element.play().catch((error: unknown) => {
      const name = error instanceof Error && error.name === 'NotAllowedError' ? 'NotAllowedError' : 'NotSupportedError'
      ended(
        id,
        failure(
          name,
          name === 'NotAllowedError'
            ? 'the window may not play sound until the person interacts with it'
            : `the clip could not play: ${messageOf(error)}`,
        ),
      )
    })
  }

  const voices = async (): Promise<SpeechSynthesisVoice[]> => {
    const now = speech!.getVoices()
    if (now.length > 0) return now
    return new Promise(resolve => {
      const done = (): void => {
        clearTimeout(timer)
        speech!.removeEventListener('voiceschanged', done)
        resolve(speech!.getVoices())
      }
      const timer = setTimeout(done, voicesWaitMs)
      speech!.addEventListener('voiceschanged', done)
    })
  }

  const speakNext = async (): Promise<void> => {
    const head = queue[0]
    if (!head || disposed) return
    const { id, message } = head
    const next = (error?: Ended): void => {
      // A stopped head was already removed and its successor started.
      if (queue[0] !== head) {
        ended(id, error)
        return
      }
      queue.shift()
      ended(id, error)
      void speakNext()
    }
    let voice: SpeechSynthesisVoice | undefined
    if (message.voice !== undefined) {
      voice = (await voices()).find(v => v.name === message.voice)
      if (head.stopped) return
      if (!voice) {
        next(failure('NotFoundError', `the voice "${message.voice}" is not installed`))
        return
      }
    }
    const utterance = deps.utterance ? deps.utterance(message.text) : new SpeechSynthesisUtterance(message.text)
    if (voice) utterance.voice = voice
    utterance.onend = () => next()
    utterance.onerror = (event: SpeechSynthesisErrorEvent) => {
      if (head.stopped || event.error === 'interrupted' || event.error === 'canceled') next()
      else if (event.error === 'not-allowed') next(failure('NotAllowedError', 'the window may not speak until the person interacts with it'))
      else next(failure('OperationError', `the utterance failed: ${event.error}`))
    }
    speech!.speak(utterance)
  }

  const speak = (message: WindowAudioSpeakMessage): void => {
    const { id } = message
    if (!speech) {
      stops.set(id, () => ended(id))
      ended(id, failure('NotSupportedError', 'this window has no speech synthesizer'))
      return
    }
    const entry = { id, message, stopped: false }
    stops.set(id, () => {
      entry.stopped = true
      const speaking = queue[0] === entry
      const at = queue.indexOf(entry)
      if (at !== -1) queue.splice(at, 1)
      ended(id)
      // Only ours is ever handed to the synthesizer, one at a time.
      if (speaking) {
        speech.cancel()
        void speakNext()
      }
    })
    queue.push(entry)
    if (queue.length === 1) void speakNext()
  }

  const onMessage = (event: MessageEvent): void => {
    const msg = event.data as WindowAudioToWindow | null
    if (!msg || typeof msg !== 'object' || disposed) return
    if (msg.type === 'audio.play') {
      if ('base64' in msg.source) void playBytes(msg as WindowAudioPlayMessage & { source: { base64: string; mime: string } })
      else playUrl(msg as WindowAudioPlayMessage & { source: { url: string } })
    } else if (msg.type === 'audio.speak') {
      speak(msg)
    } else if (msg.type === 'audio.stop') {
      stops.get(msg.id)?.()
    }
  }
  port.addEventListener('message', onMessage)

  return {
    dispose: () => {
      if (disposed) return
      for (const stop of [...stops.values()]) stop()
      disposed = true
      port.removeEventListener('message', onMessage)
      void context?.close().catch(() => undefined)
    },
  }
}
