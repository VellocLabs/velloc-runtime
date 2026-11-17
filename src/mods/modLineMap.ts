/**
 * Where a line of a compiled hooks module came from (F-25): the linker's
 * output line → the source file and its 1-based line, so a failure names the
 * line the author wrote.
 */

/** One source file's run of lines in the linked output. */
export type ModLineMapFile = {
  path: string
  /** The output line (1-based) of the file's first compiled line. */
  start: number
  /** `lines[i]`: the source line of output line `start + i`; 0 when unknown. */
  lines: number[]
}

export type ModLineMap = { files: ModLineMapFile[] }

/** A position in the module the worker ran (1-based line and column). */
export type ModFrame = { line: number; column: number }

/** A source location: the file and its 1-based line. */
export type ModSourceLocation = { file: string; line: number }

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const DIGIT = new Map([...BASE64].map((char, index) => [char, index]))

/** The values of one source-map segment (base64 VLQ). Null when malformed. */
function decodeSegment(segment: string): number[] | null {
  const values: number[] = []
  let value = 0
  let shift = 0
  for (const char of segment) {
    const digit = DIGIT.get(char)
    if (digit === undefined) return null
    value += (digit & 31) << shift
    if (digit & 32) {
      shift += 5
      // A value past 32 bits is not a line: the map is malformed.
      if (shift > 30) return null
      continue
    }
    values.push(value & 1 ? -(value >>> 1) : value >>> 1)
    value = 0
    shift = 0
  }
  return shift === 0 ? values : null
}

/**
 * The source line of each generated line of one file's source map
 * (`mappings`): the first segment that names a source wins; 0 where none does.
 * Contract: never throws; a malformed map answers what it could read.
 */
export function sourceLinesOfMappings(mappings: string): number[] {
  const out: number[] = []
  let sourceLine = 0
  for (const line of mappings.split(';')) {
    let found = 0
    for (const segment of line.split(',')) {
      if (segment === '') continue
      const values = decodeSegment(segment)
      if (!values) return out
      if (values.length >= 4) {
        sourceLine += values[2]!
        if (found === 0) found = sourceLine + 1
      }
    }
    out.push(found)
  }
  return out
}

/** The source location of output line `line`, or undefined when the line is
 *  the linker's own or the map does not know it. */
export function sourceLocationOf(map: ModLineMap, line: number): ModSourceLocation | undefined {
  for (const file of map.files) {
    const index = line - file.start
    if (index < 0 || index >= file.lines.length) continue
    const sourceLine = file.lines[index]!
    return sourceLine > 0 ? { file: file.path, line: sourceLine } : undefined
  }
  return undefined
}

/** Whether `value` is a line map as stored (a build record read back). */
export function isModLineMap(value: unknown): value is ModLineMap {
  if (typeof value !== 'object' || value === null) return false
  const files = (value as { files?: unknown }).files
  return (
    Array.isArray(files) &&
    files.every(
      file =>
        typeof file?.path === 'string' &&
        typeof file.start === 'number' &&
        Array.isArray(file.lines) &&
        file.lines.every((line: unknown) => typeof line === 'number'),
    )
  )
}

/** The name the worker gives its module (`//# sourceURL`), so a stack frame
 *  does not spell out the whole `data:` URL. */
export const MOD_MODULE_SOURCE_URL = 'velloc-mod-module.js'

const DATA_MODULE_FRAME = /(?:data:text\/javascript;base64,[A-Za-z0-9+/=]*|velloc-mod-module\.js):(\d+):(\d+)/g
const MAX_FRAMES = 8

/**
 * The positions an error's stack names inside the worker's module (loaded
 * from a `data:` URL), innermost first, at most a few. Empty when the stack
 * names none or is absent.
 */
export function moduleFramesOf(stack: unknown): ModFrame[] {
  if (typeof stack !== 'string') return []
  const frames: ModFrame[] = []
  for (const match of stack.matchAll(DATA_MODULE_FRAME)) {
    frames.push({ line: Number(match[1]), column: Number(match[2]) })
    if (frames.length >= MAX_FRAMES) break
  }
  return frames
}

/** The frames a rebuilt error carries (set by the instance from the wire). */
const FRAMES = Symbol('modFrames')

export function withModFrames<E extends Error>(error: E, frames: readonly ModFrame[] | undefined): E {
  if (frames && frames.length > 0) Object.defineProperty(error, FRAMES, { value: frames })
  return error
}

export function modFramesOfError(error: unknown): readonly ModFrame[] | undefined {
  return typeof error === 'object' && error !== null
    ? ((error as { [FRAMES]?: readonly ModFrame[] })[FRAMES] ?? undefined)
    : undefined
}
