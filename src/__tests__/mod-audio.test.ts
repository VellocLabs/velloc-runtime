/**
 * `$.audio.play` / `$.audio.speak` (F-25): the arguments, the runtime's
 * window player over the kernel's pool, the window's own player, and a real
 * module calling the nouns through a slot.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KernelWindowListener } from '../browser/workerKernel/IsolatedWorkerKernel'
import type { WindowAudioToWindow } from '../browser/workerKernel/kernelProtocol'
import { createWindowAudioPlayer, type WindowAudioPlayer } from '../browser/workerKernel/windowAudio'
import { installWindowAudioHost } from '../browser/workerKernel/windowAudioHost'
import { audioPlayInput, audioSpeakInput, checkAssetPath, playClip, type ModAudioHost } from '../mods/modAudio'
import { ModRuntime, type ModModuleRef } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'

const open: MessagePort[] = []
afterEach(() => {
  for (const port of open.splice(0)) port.close()
})

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('$.audio — arguments', () => {
  it('takes the three clip forms, gain 0–4 defaulting to 1', () => {
    expect(audioPlayInput([{ asset: 'fx/open.wav' }])).toEqual({ clip: { asset: 'fx/open.wav' }, shouldLoop: false, gain: 1 })
    expect(audioPlayInput([{ url: 'https://example.com/a.mp3' }, { gain: 4, shouldLoop: true }])).toEqual({
      clip: { url: 'https://example.com/a.mp3' },
      shouldLoop: true,
      gain: 4,
    })
    expect(audioPlayInput([{ base64: 'AAAA', mime: 'audio/wav' }]).clip).toEqual({ base64: 'AAAA', mime: 'audio/wav' })
  })

  it('refuses a clip outside the plugin, a non-http URL, two forms, a gain out of range', () => {
    for (const asset of ['/etc/x.wav', '../x.wav', 'fx/../../x.wav', './x.wav', 'C:/x.wav', '\\\\host\\x.wav', 'fx//x.wav']) {
      expect(() => checkAssetPath(asset), asset).toThrow(TypeError)
    }
    expect(() => audioPlayInput([{ url: 'file:///c:/x.wav' }])).toThrow(/http or https/)
    expect(() => audioPlayInput([{ url: 'https://a/x', asset: 'x.wav' }])).toThrow(/exactly one/)
    expect(() => audioPlayInput([{ base64: 'AAAA', mime: 'text/plain' }])).toThrow(/audio type/)
    expect(() => audioPlayInput([{ asset: 'x.wav' }, { gain: 4.5 }])).toThrow(RangeError)
    expect(() => audioPlayInput([{ asset: 'x.wav' }, { gain: -1 }])).toThrow(RangeError)
  })

  it('speak: plain text up to 4096 characters, an optional voice name', () => {
    expect(audioSpeakInput(['done', { voice: 'Samantha' }])).toEqual({ text: 'done', voice: 'Samantha' })
    expect(audioSpeakInput(['done'])).toEqual({ text: 'done' })
    expect(() => audioSpeakInput(['x'.repeat(4097)])).toThrow(RangeError)
    expect(() => audioSpeakInput([42])).toThrow(TypeError)
  })

  it('an asset is read from the plugin directory as bytes, its type from its extension', async () => {
    const played: unknown[] = []
    const host: ModAudioHost = {
      player: { play: async request => void played.push(request), speak: async () => undefined },
      root: plugin => (plugin === 'chime' ? 'C:\\plugins\\chime\\' : undefined),
      readBytes: async path => ({ base64: `bytes-of:${path}` }),
    }
    await playClip({ clip: { asset: 'fx/done.mp3' }, shouldLoop: false, gain: 0.5 }, 'chime', host)
    expect(played).toEqual([
      { source: { base64: 'bytes-of:C:\\plugins\\chime/fx/done.mp3', mime: 'audio/mpeg' }, loop: false, gain: 0.5 },
    ])
    await expect(playClip({ clip: { asset: 'fx/done.txt' }, shouldLoop: false, gain: 1 }, 'chime', host)).rejects.toThrow(
      /not a sound file/,
    )
    await expect(playClip({ clip: { asset: 'a.wav' }, shouldLoop: false, gain: 1 }, 'other', host)).rejects.toThrow(
      /no directory/,
    )
  })
})

type FakePort = MessagePort & { sent: WindowAudioToWindow[] }

function fakePool() {
  const listeners = new Set<KernelWindowListener>()
  const ports: FakePort[] = []
  const port = (): FakePort => {
    const sent: WindowAudioToWindow[] = []
    const p = { sent, postMessage: (message: WindowAudioToWindow) => sent.push(message) } as unknown as FakePort
    ports.push(p)
    return p
  }
  return {
    port,
    ports,
    pool: {
      ports: () => [...ports].reverse(),
      listen: (listener: KernelWindowListener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    ended: (from: MessagePort, id: string, error?: { name: string; message: string }) => {
      for (const l of listeners) l.audioEnded?.(from, { type: 'audio.ended', id, ...(error ? { error } : {}) })
    },
    left: (from: MessagePort) => {
      for (const l of listeners) l.left?.(from)
    },
    listening: () => listeners.size,
  }
}

describe('the runtime\'s window player', () => {
  it('sends each sound to the newest window alone and settles on its answer', async () => {
    const world = fakePool()
    const older = world.port()
    const newest = world.port()
    const player = createWindowAudioPlayer(world.pool)
    const played = player.play({ source: { url: 'https://a/x.mp3' }, loop: false, gain: 1 }, undefined)
    expect(older.sent).toEqual([])
    expect(newest.sent).toEqual([{ type: 'audio.play', id: 'a1', source: { url: 'https://a/x.mp3' }, loop: false, gain: 1 }])
    // Another window's answer for the same id does not settle it.
    world.ended(older, 'a1')
    world.ended(newest, 'a1')
    await expect(played).resolves.toBeUndefined()

    const spoken = player.speak({ text: 'hi', voice: 'Nope' })
    world.ended(newest, 'a2', { name: 'NotFoundError', message: 'the voice "Nope" is not installed' })
    await expect(spoken).rejects.toMatchObject({ name: 'NotFoundError', message: 'the voice "Nope" is not installed' })
  })

  it('a window that may not play yet hands the sound to the next; any other refusal stands', async () => {
    const world = fakePool()
    const older = world.port()
    const newest = world.port()
    const player = createWindowAudioPlayer(world.pool)
    const played = player.play({ source: { url: 'https://a/x.mp3' }, loop: false, gain: 1 })
    world.ended(newest, 'a1', { name: 'NotAllowedError', message: 'not yet' })
    await Promise.resolve()
    await Promise.resolve()
    expect(older.sent).toEqual([{ type: 'audio.play', id: 'a2', source: { url: 'https://a/x.mp3' }, loop: false, gain: 1 }])
    world.ended(older, 'a2')
    await expect(played).resolves.toBeUndefined()

    const failed = player.play({ source: { url: 'https://a/y.mp3' }, loop: false, gain: 1 })
    world.ended(newest, 'a3', { name: 'NetworkError', message: 'no clip' })
    await expect(failed).rejects.toMatchObject({ name: 'NetworkError' })
    expect(older.sent).toHaveLength(1)

    const nowhere = player.play({ source: { url: 'https://a/z.mp3' }, loop: false, gain: 1 })
    world.ended(newest, 'a4', { name: 'NotAllowedError', message: 'not yet' })
    await Promise.resolve()
    await Promise.resolve()
    world.ended(older, 'a5', { name: 'NotAllowedError', message: 'not yet either' })
    await expect(nowhere).rejects.toMatchObject({ name: 'NotAllowedError', message: 'not yet either' })
  })

  it('no window: NotSupportedError; the window leaving: AbortError; an abort tells the window to stop', async () => {
    const world = fakePool()
    const player = createWindowAudioPlayer(world.pool)
    await expect(player.speak({ text: 'x' })).rejects.toMatchObject({ name: 'NotSupportedError' })

    const port = world.port()
    const playing = player.play({ source: { base64: 'AA==', mime: 'audio/wav' }, loop: true, gain: 1 })
    world.left(port)
    await expect(playing).rejects.toMatchObject({ name: 'AbortError' })

    const controller = new AbortController()
    const looping = player.play({ source: { base64: 'AA==', mime: 'audio/wav' }, loop: true, gain: 1 }, controller.signal)
    controller.abort()
    await expect(looping).rejects.toMatchObject({ name: 'AbortError' })
    expect(port.sent.at(-1)).toEqual({ type: 'audio.stop', id: 'a2' })
  })

  it('listens to the windows only while a sound is out', async () => {
    const world = fakePool()
    const port = world.port()
    const player = createWindowAudioPlayer(world.pool)
    expect(world.listening()).toBe(0)
    const one = player.speak({ text: 'one' })
    const two = player.speak({ text: 'two' })
    expect(world.listening()).toBe(1)
    world.ended(port, 'a1')
    await one
    expect(world.listening()).toBe(1)
    world.ended(port, 'a2')
    await two
    expect(world.listening()).toBe(0)
    const three = player.speak({ text: 'three' })
    expect(world.listening()).toBe(1)
    world.ended(port, 'a3')
    await expect(three).resolves.toBeUndefined()
    expect(world.listening()).toBe(0)
  })
})

// ── the window's player ──

function windowPort() {
  let listener: ((event: MessageEvent) => void) | undefined
  const answers: Array<{ id: string; error?: { name: string } }> = []
  const port = {
    addEventListener: (_type: string, fn: (event: MessageEvent) => void) => {
      listener = fn
    },
    removeEventListener: () => {
      listener = undefined
    },
    postMessage: (message: { id: string; error?: { name: string } }) => answers.push(message),
  } as unknown as MessagePort
  return { port, answers, send: (data: WindowAudioToWindow) => listener?.({ data } as MessageEvent) }
}

function fakeSpeech(voiceNames: string[]) {
  const spoken: Array<SpeechSynthesisUtterance & { text: string }> = []
  const speech = {
    getVoices: () => voiceNames.map(name => ({ name }) as SpeechSynthesisVoice),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    speak: (u: SpeechSynthesisUtterance & { text: string }) => spoken.push(u),
    cancel: vi.fn(),
  } as unknown as SpeechSynthesis
  const utterance = (text: string) => ({ text }) as unknown as SpeechSynthesisUtterance
  return { speech, spoken, utterance }
}

describe('the window\'s player', () => {
  it('plays bytes through Web Audio with the gain and loop asked, and answers when it ends', async () => {
    const started: Array<{ loop: boolean; gain: number }> = []
    let source: { onended?: () => void } = {}
    const gainNode = { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() }
    const ctx = {
      state: 'running',
      destination: {},
      decodeAudioData: async () => ({}),
      createGain: () => gainNode,
      createBufferSource: () => {
        source = {
          connect: vi.fn(),
          start: () => started.push({ loop: (source as { loop: boolean }).loop, gain: gainNode.gain.value }),
        } as never
        return source
      },
    } as unknown as AudioContext
    const { port, answers, send } = windowPort()
    installWindowAudioHost(port, { audioContext: () => ctx })
    send({ type: 'audio.play', id: 'a1', source: { base64: 'AA==', mime: 'audio/wav' }, loop: true, gain: 2.5 })
    await flush()
    expect(started).toEqual([{ loop: true, gain: 2.5 }])
    expect(answers).toEqual([])
    source.onended?.()
    expect(answers).toEqual([{ type: 'audio.ended', id: 'a1' }])
  })

  it('a page that may not play sound yet answers NotAllowedError', async () => {
    const ctx = { state: 'suspended', resume: () => new Promise(() => undefined) } as unknown as AudioContext
    const { port, answers, send } = windowPort()
    installWindowAudioHost(port, { audioContext: () => ctx, resumeWaitMs: 5 })
    send({ type: 'audio.play', id: 'a1', source: { base64: 'AA==', mime: 'audio/wav' }, loop: false, gain: 1 })
    await vi.waitFor(() => expect(answers[0]?.error?.name).toBe('NotAllowedError'))
  })

  it('a URL plays through a media element, its gain capped at 1; a stop ends it without an error', async () => {
    const element = Object.assign(new EventTarget(), {
      loop: false,
      volume: 0,
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      removeAttribute: vi.fn(),
    }) as unknown as HTMLAudioElement
    const { port, answers, send } = windowPort()
    installWindowAudioHost(port, { mediaElement: () => element })
    send({ type: 'audio.play', id: 'a1', source: { url: 'https://a/x.mp3' }, loop: false, gain: 3 })
    expect(element.volume).toBe(1)
    send({ type: 'audio.stop', id: 'a1' })
    expect(element.pause).toHaveBeenCalled()
    expect(answers).toEqual([{ type: 'audio.ended', id: 'a1' }])
  })

  it('utterances wait for the ones before them; a queued one stopped never speaks; an unknown voice is NotFoundError', async () => {
    const { speech, spoken, utterance } = fakeSpeech(['Samantha'])
    const { port, answers, send } = windowPort()
    installWindowAudioHost(port, { speech, utterance })
    send({ type: 'audio.speak', id: 'a1', text: 'one' })
    send({ type: 'audio.speak', id: 'a2', text: 'two' })
    send({ type: 'audio.speak', id: 'a3', text: 'three', voice: 'Samantha' })
    send({ type: 'audio.speak', id: 'a4', text: 'four', voice: 'Nope' })
    await flush()
    expect(spoken.map(u => u.text)).toEqual(['one'])
    send({ type: 'audio.stop', id: 'a2' })
    spoken[0]!.onend?.({} as SpeechSynthesisEvent)
    await flush()
    expect(spoken.map(u => u.text)).toEqual(['one', 'three'])
    expect(spoken[1]!.voice).toEqual({ name: 'Samantha' })
    spoken[1]!.onend?.({} as SpeechSynthesisEvent)
    await flush()
    expect(answers).toEqual([
      { type: 'audio.ended', id: 'a2' },
      { type: 'audio.ended', id: 'a1' },
      { type: 'audio.ended', id: 'a3' },
      { type: 'audio.ended', id: 'a4', error: { name: 'NotFoundError', message: 'the voice "Nope" is not installed' } },
    ])
  })

  it('stopping the utterance being spoken cancels it and speaks the next once', async () => {
    const { speech, spoken, utterance } = fakeSpeech([])
    const { port, answers, send } = windowPort()
    installWindowAudioHost(port, { speech, utterance })
    send({ type: 'audio.speak', id: 'a1', text: 'one' })
    send({ type: 'audio.speak', id: 'a2', text: 'two' })
    await flush()
    send({ type: 'audio.stop', id: 'a1' })
    await flush()
    expect(speech.cancel).toHaveBeenCalledTimes(1)
    // The synthesizer reports the cancelled utterance after the stop.
    spoken[0]!.onerror?.({ error: 'interrupted' } as SpeechSynthesisErrorEvent)
    await flush()
    expect(spoken.map(u => u.text)).toEqual(['one', 'two'])
    spoken[1]!.onend?.({} as SpeechSynthesisEvent)
    await flush()
    expect(answers).toEqual([
      { type: 'audio.ended', id: 'a1' },
      { type: 'audio.ended', id: 'a2' },
    ])
  })
})

// ── through a slot, with a real module ──

function world(sources: Record<string, string>, player: WindowAudioPlayer) {
  const reports: string[] = []
  const modules: ModModuleRef[] = Object.keys(sources).map(path => ({ plugin: path.split('/')[0]!, path, root: `/plugins/${path.split('/')[0]}` }))
  const runtime = new ModRuntime({
    modules,
    readModule: async path => sources[path]!,
    openWorker: async () => {
      const channel = new MessageChannel()
      open.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      return { port: channel.port1, closed: new Promise(() => undefined), close() {} }
    },
    session: {
      id: () => 'session-1',
      cwd: () => '/work/project',
      fs: {
        read: async (path: string) => ({ base64: `bytes:${path}` }),
      } as never,
    },
    audio: player,
    report: line => reports.push(line),
  })
  return { runtime, reports }
}

describe('$.audio through a slot', () => {
  it('plays a plugin asset and speaks; a plugin above may mute another plugin\'s sound', async () => {
    const played: unknown[] = []
    const spoken: unknown[] = []
    const player: WindowAudioPlayer = {
      play: async request => void played.push(request),
      speak: async request => void spoken.push(request),
    }
    const { runtime, reports } = world(
      {
        'chime/hooks/register.js': `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              await $.audio.play({ asset: 'fx/done.wav' }, { gain: 0.5 })
              const said = await $.audio.speak('all done', { voice: 'Samantha' })
              const muted = await $.audio.speak('the secret is out')
              await $.ui.log('spoke via ' + said.via + ', muted via ' + muted.via)
              return next(e)
            })
          }
        `,
        'quiet/hooks/register.js': `
          export function register(on) {
            on('audio.speak', ($, e, next) => (e.text.includes('secret') ? { value: { via: 'system' } } : next(e)))
          }
        `,
      },
      player,
    )
    await runtime.ready
    expect(reports).toEqual([])
    await runtime.promptSubmit('go')
    expect(played).toEqual([
      { source: { base64: 'bytes:/plugins/chime/fx/done.wav', mime: 'audio/wav' }, loop: false, gain: 0.5 },
    ])
    expect(spoken).toEqual([{ text: 'all done', voice: 'Samantha' }])
    expect(reports).toEqual(['chime: spoke via system, muted via system'])
  })

  it('a loop without the signal that ends it is refused in the worker; with one, its abort resolves the call', async () => {
    let stopped: AbortSignal | undefined
    const player: WindowAudioPlayer = {
      play: (_request, signal) =>
        new Promise((_resolve, reject) => {
          stopped = signal
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { name: 'AbortError' })))
        }),
      speak: async () => undefined,
    }
    const { runtime, reports } = world(
      {
        'bed/hooks/register.js': `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              const refused = await $.audio.play({ url: 'https://example.com/bed.mp3' }, { shouldLoop: true }).catch(err => err.message)
              const controller = new AbortController()
              const playing = $.audio.play({ url: 'https://example.com/bed.mp3' }, { shouldLoop: true, signal: controller.signal })
              await $.clock.sleep(20)
              controller.abort()
              await $.ui.log(refused + ' | ' + String(await playing))
              return next(e)
            })
          }
        `,
      },
      player,
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(reports).toEqual(['bed: $.audio.play: a looped clip needs the signal that ends it | undefined'])
    expect(stopped?.aborted).toBe(true)
  })
})
