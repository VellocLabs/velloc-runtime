/**
 * `$.audio.play` and `$.audio.speak` (F-25): each an op event, so a plugin
 * above mutes or rewrites another plugin's sound. Core hands the sound to a
 * Velloc window (`browser/workerKernel/windowAudio.ts`): a plugin's `asset`
 * is read from its own directory here and travels as bytes; a URL is loaded
 * by the window's media element.
 */

import type { WindowAudioSource } from '../browser/workerKernel/kernelProtocol'
import type { WindowAudioPlayer } from '../browser/workerKernel/windowAudio'

/** "What to say, as plain text, of at most 4096 characters." */
export const AUDIO_SPEAK_MAX_CHARS = 4096
/** "Linear gain, from 0 to 4." */
export const AUDIO_MAX_GAIN = 4

/** `$.audio.play`'s clip, as the event carries it. */
export type AudioClip = { asset: string } | { url: string } | { base64: string; mime: string }

/** The `audio.play` event's `e`. The caller's `signal` does not cross: the
 *  worker turns its abort into the call's abandonment. */
export type AudioPlayEvent = { clip: AudioClip; shouldLoop: boolean; gain: number }

/** The `audio.speak` event's `e`. */
export type AudioSpeakEvent = { text: string; voice?: string }

/** What `$.audio.speak` resolves with. */
export type AudioSpeakResult = { via: 'system' }

/** What the two nouns need of the slot (`ModRuntime` supplies it). */
export type ModAudioHost = {
  player: WindowAudioPlayer
  /** `plugin`'s directory, absolute; undefined for a plugin not loaded here. */
  root(plugin: string): string | undefined
  /** The plugin's file as bytes (`$.fs.read(path, { as: 'bytes' })`'s reader). */
  readBytes(path: string): Promise<{ base64: string }>
}

const EXTENSION_MIME: Readonly<Record<string, string>> = Object.freeze({
  wav: 'audio/wav',
  wave: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  webm: 'audio/webm',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function named(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

/** Security: an asset names a file inside the plugin's directory — relative,
 *  no `.` / `..` segment, no drive or root. */
export function checkAssetPath(asset: string): string {
  if (asset === '' || /^[\\/]/.test(asset) || /^[A-Za-z]:/.test(asset)) {
    throw new TypeError(`$.audio.play: asset "${asset}" must be a path relative to the plugin's directory`)
  }
  const parts = asset.split(/[\\/]/)
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new TypeError(`$.audio.play: asset "${asset}" may not hold an empty, "." or ".." segment`)
  }
  return parts.join('/')
}

function checkClip(value: unknown): AudioClip {
  if (!isRecord(value)) throw new TypeError('$.audio.play(clip): clip must be { asset }, { url } or { base64, mime }')
  const forms = ['asset', 'url', 'base64'].filter(key => value[key] !== undefined)
  if (forms.length !== 1) throw new TypeError('$.audio.play(clip): give exactly one of asset, url or base64')
  if (value.asset !== undefined) {
    if (typeof value.asset !== 'string') throw new TypeError('$.audio.play: asset must be a string')
    return { asset: checkAssetPath(value.asset) }
  }
  if (value.url !== undefined) {
    if (typeof value.url !== 'string') throw new TypeError('$.audio.play: url must be a string')
    let parsed: URL
    try {
      parsed = new URL(value.url)
    } catch {
      throw new TypeError(`$.audio.play: url "${value.url}" is not a URL`)
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new TypeError(`$.audio.play: url must be http or https, not ${parsed.protocol}`)
    }
    return { url: parsed.href }
  }
  if (typeof value.base64 !== 'string' || value.base64 === '') {
    throw new TypeError('$.audio.play: base64 must be a non-empty string')
  }
  if (typeof value.mime !== 'string' || !/^audio\/[\w.+-]+$/.test(value.mime)) {
    throw new TypeError('$.audio.play: mime must name an audio type (audio/mpeg, audio/wav)')
  }
  return { base64: value.base64, mime: value.mime }
}

function checkGain(value: unknown): number {
  if (value === undefined) return 1
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > AUDIO_MAX_GAIN) {
    throw new RangeError(`$.audio.play: gain must be a number from 0 to ${AUDIO_MAX_GAIN}`)
  }
  return value
}

/** The `audio.play` event's `e` from `$.audio.play(clip, options)`. */
export function audioPlayInput(args: readonly unknown[]): AudioPlayEvent {
  const options = args[1]
  if (options !== undefined && !isRecord(options)) throw new TypeError('$.audio.play: options must be an object')
  return {
    clip: checkClip(args[0]),
    shouldLoop: options?.shouldLoop === true,
    gain: checkGain(options?.gain),
  }
}

/** `e` as it reached core: a hook above may have rewritten it. */
export function checkAudioPlayEvent(e: unknown): AudioPlayEvent {
  if (!isRecord(e)) throw new TypeError('audio.play: e must be { clip, shouldLoop, gain }')
  return { clip: checkClip(e.clip), shouldLoop: e.shouldLoop === true, gain: checkGain(e.gain) }
}

/** The `audio.speak` event's `e` from `$.audio.speak(text, options)`. */
export function audioSpeakInput(args: readonly unknown[]): AudioSpeakEvent {
  const options = args[1]
  if (options !== undefined && !isRecord(options)) throw new TypeError('$.audio.speak: options must be an object')
  return checkAudioSpeakEvent({ text: args[0], ...(options?.voice !== undefined ? { voice: options.voice } : {}) })
}

export function checkAudioSpeakEvent(e: unknown): AudioSpeakEvent {
  if (!isRecord(e) || typeof e.text !== 'string') throw new TypeError('$.audio.speak(text): text must be a string')
  if (e.text.length > AUDIO_SPEAK_MAX_CHARS) {
    throw new RangeError(`$.audio.speak: text is ${e.text.length} characters, over the ${AUDIO_SPEAK_MAX_CHARS} allowed`)
  }
  if (e.voice !== undefined && (typeof e.voice !== 'string' || e.voice === '')) {
    throw new TypeError('$.audio.speak: voice must be a voice name')
  }
  return { text: e.text, ...(e.voice !== undefined ? { voice: e.voice as string } : {}) }
}

function mimeOfAsset(asset: string): string {
  const dot = asset.lastIndexOf('.')
  const mime = dot === -1 ? undefined : EXTENSION_MIME[asset.slice(dot + 1).toLowerCase()]
  if (!mime) throw new TypeError(`$.audio.play: asset "${asset}" is not a sound file this engine knows (wav, mp3, ogg, m4a, aac, flac, webm)`)
  return mime
}

/** Core of `audio.play`: resolves when the clip has ended or was stopped. */
export async function playClip(
  e: AudioPlayEvent,
  plugin: string,
  host: ModAudioHost,
  signal?: AbortSignal,
): Promise<void> {
  let source: WindowAudioSource
  if ('asset' in e.clip) {
    const root = host.root(plugin)
    if (root === undefined) throw named('NotFoundError', `$.audio.play: the plugin "${plugin}" has no directory here`)
    const path = `${root.replace(/[\\/]+$/, '')}/${e.clip.asset}`
    const mime = mimeOfAsset(e.clip.asset)
    source = { base64: (await host.readBytes(path)).base64, mime }
  } else {
    source = e.clip
  }
  await host.player.play({ source, loop: e.shouldLoop, gain: e.gain }, signal)
}

/** Core of `audio.speak`: resolves once the utterance has ended. */
export async function speakText(e: AudioSpeakEvent, host: ModAudioHost, signal?: AbortSignal): Promise<AudioSpeakResult> {
  await host.player.speak(e, signal)
  return { via: 'system' }
}
