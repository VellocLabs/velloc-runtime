// Reuse of a surface id in a block (F-1). A bare `surface("<id>")` line for a
// surface that already exists continues that surface, so a later block can
// redefine its components in place: the line is read as
// `surface("<id>", update=true)`. A new id, an id the block deleted on an
// earlier line, and a `surface()` call with other arguments are left as written.

import { SURFACE_ID } from './a2uiBlocks'

const BARE_SURFACE = new RegExp(String.raw`^(\s*surface\(\s*${SURFACE_ID})\s*\)\s*$`)
const ANY_SURFACE = new RegExp(String.raw`^\s*surface\(\s*${SURFACE_ID}`)
const DELETE_SURFACE = new RegExp(String.raw`^\s*deleteSurface\(\s*${SURFACE_ID}`)
const DIRECTIVES = ['surface(', 'deleteSurface(']

/** Whether the surface exists before the block: the compiler state's view. */
export type SurfaceExists = (surfaceId: string) => boolean

function literalId(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    return raw
  }
}

/** Reads a block's lines in order and returns each one as the compiler should see it. */
function createLineReader(exists: SurfaceExists): (line: string) => string {
  // What this block's own lines did to a surface: made it (true) or deleted it.
  const own = new Map<string, boolean>()
  return line => {
    const deleted = DELETE_SURFACE.exec(line)
    if (deleted) {
      own.set(literalId(deleted[1]), false)
      return line
    }
    const bare = BARE_SURFACE.exec(line)
    if (bare) {
      const id = literalId(bare[2])
      const live = own.get(id) ?? exists(id)
      own.set(id, true)
      return live ? `${bare[1]}, update=true)` : line
    }
    const named = ANY_SURFACE.exec(line)
    if (named) own.set(literalId(named[1]), true)
    return line
  }
}

/** A whole block body with its reused surface ids continued. */
export function continueReusedSurfaces(body: string, exists: SurfaceExists): string {
  const read = createLineReader(exists)
  return body.split('\n').map(read).join('\n')
}

export type SurfaceLineFilter = {
  /** The text to pass on for `chunk`; a line that may still be a surface directive is held to its end. */
  push(chunk: string): string
  /** The held rest of the last line, at the block's end. */
  flush(): string
}

/** `continueReusedSurfaces` for a block read chunk by chunk. */
export function createSurfaceLineFilter(exists: SurfaceExists): SurfaceLineFilter {
  const read = createLineReader(exists)
  let held = ''
  let atLineStart = true
  const mayBeDirective = (text: string) => {
    const start = text.trimStart()
    return DIRECTIVES.some(directive => directive.startsWith(start) || start.startsWith(directive))
  }
  return {
    push(chunk) {
      let text = held + chunk
      held = ''
      let out = ''
      while (text) {
        const end = text.indexOf('\n')
        if (!atLineStart) {
          if (end < 0) return out + text
          out += text.slice(0, end + 1)
          text = text.slice(end + 1)
          atLineStart = true
          continue
        }
        if (end >= 0) {
          out += `${read(text.slice(0, end))}\n`
          text = text.slice(end + 1)
          continue
        }
        if (mayBeDirective(text)) {
          held = text
          return out
        }
        atLineStart = false
        return out + text
      }
      return out
    },
    flush() {
      const rest = held
      held = ''
      return rest ? read(rest) : ''
    },
  }
}
