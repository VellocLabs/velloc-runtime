// Breaks a shell line into its simple commands at `;`, `|`, `&&` and `||`.
// Quoted text and backslash-escaped characters never split; each piece is
// trimmed and empty pieces are discarded. Not a full shell parser.
export function splitCommandSimple(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let i = 0

  while (i < command.length) {
    const ch = command[i]!

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      current += ch
      i++
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      current += ch
      i++
      continue
    }
    if (ch === '\\' && !inSingle && i + 1 < command.length) {
      current += ch + command[i + 1]!
      i += 2
      continue
    }

    if (!inSingle && !inDouble) {
      if (
        (ch === '&' && command[i + 1] === '&') ||
        (ch === '|' && command[i + 1] === '|')
      ) {
        segments.push(current)
        current = ''
        i += 2
        continue
      }
      if (ch === ';' || ch === '|') {
        segments.push(current)
        current = ''
        i++
        continue
      }
    }

    current += ch
    i++
  }
  segments.push(current)
  return segments.map(s => s.trim()).filter(s => s.length > 0)
}

// Returns a short description when a bash line opens with `sleep N` (N >= 2),
// or null when the line is allowed. The description says whether the sleep
// stands alone or is chained before other commands.
export function idleWaitRejection(command: string): string | null {
  const parts = splitCommandSimple(command)
  if (parts.length === 0) return null
  const first = parts[0]?.trim() ?? ''
  const m = /^sleep\s+(\d+)\s*$/.exec(first)
  if (!m) return null
  const secs = parseInt(m[1]!, 10)
  if (secs < 2) return null

  const rest = parts.slice(1).join(' ').trim()
  return rest ? `sleep ${secs} followed by: ${rest}` : `standalone sleep ${secs}`
}

// PowerShell counterpart: matches `Start-Sleep` / `sleep` with an optional
// -s / -Seconds flag, case-insensitively, at the start of the line.
export function detectBlockedSleepPatternPS(command: string): string | null {
  const first = command.trim().split(/[;|&\r\n]/)[0]?.trim() ?? ''
  const m = /^(?:start-sleep|sleep)(?:\s+-s(?:econds)?)?\s+(\d+)\s*$/i.exec(first)
  if (!m) return null
  const secs = parseInt(m[1]!, 10)
  if (secs < 2) return null

  const rest = command.trim().slice(first.length).replace(/^[\s;|&]+/, '')
  return rest
    ? `Start-Sleep ${secs} followed by: ${rest}`
    : `standalone Start-Sleep ${secs}`
}

// Command-name buckets used to classify a bash line for display.
const SHELL_FINDER_WORDS = new Set([
  'ack',
  'ag',
  'find',
  'grep',
  'locate',
  'rg',
  'whereis',
  'which',
])

const SHELL_VIEWER_WORDS = new Set([
  'awk',
  'cat',
  'cut',
  'file',
  'head',
  'jq',
  'less',
  'more',
  'sort',
  'stat',
  'strings',
  'tail',
  'tr',
  'uniq',
  'wc',
])

const SHELL_LISTER_WORDS = new Set([
  'du',
  'ls',
  'tree',
])

// Commands that never change a line's classification on their own.
const SHELL_PASSTHRU_WORDS = new Set([
  ':',
  'echo',
  'false',
  'printf',
  'true',
])

// Commands that normally succeed without printing anything.
const SHELL_QUIET_WORDS = new Set([
  'cd',
  'chgrp',
  'chmod',
  'chown',
  'cp',
  'export',
  'ln',
  'mkdir',
  'mv',
  'rm',
  'rmdir',
  'touch',
  'unset',
  'wait',
])

// Classifies a bash line as search, read and/or list when every non-neutral
// command in it belongs to those buckets. Any other command, or a line made
// only of neutral commands, yields all three flags false.
export function classifyShellLine(command: string): {
  isSearch: boolean
  isRead: boolean
  isList: boolean
} {
  let parts: string[]
  try {
    parts = splitCommandSimple(command)
  } catch {
    return { isSearch: false, isRead: false, isList: false }
  }
  if (parts.length === 0) {
    return { isSearch: false, isRead: false, isList: false }
  }

  let hasSearch = false
  let hasRead = false
  let hasList = false
  let hasNonNeutralCommand = false

  for (const part of parts) {
    const baseCommand = part.trim().split(/\s+/)[0]
    if (!baseCommand) continue
    if (SHELL_PASSTHRU_WORDS.has(baseCommand)) continue
    hasNonNeutralCommand = true
    const isPartSearch = SHELL_FINDER_WORDS.has(baseCommand)
    const isPartRead = SHELL_VIEWER_WORDS.has(baseCommand)
    const isPartList = SHELL_LISTER_WORDS.has(baseCommand)
    if (!isPartSearch && !isPartRead && !isPartList) {
      return { isSearch: false, isRead: false, isList: false }
    }
    if (isPartSearch) hasSearch = true
    if (isPartRead) hasRead = true
    if (isPartList) hasList = true
  }

  if (!hasNonNeutralCommand) {
    return { isSearch: false, isRead: false, isList: false }
  }
  return { isSearch: hasSearch, isRead: hasRead, isList: hasList }
}

// True when the line has at least one non-neutral command and every such
// command is in the silent bucket, so empty output is the expected result.
export function expectsNoOutput(command: string): boolean {
  let parts: string[]
  try {
    parts = splitCommandSimple(command)
  } catch {
    return false
  }
  if (parts.length === 0) return false

  let hasNonFallbackCommand = false
  for (const part of parts) {
    const baseCommand = part.trim().split(/\s+/)[0]
    if (!baseCommand) continue
    if (SHELL_PASSTHRU_WORDS.has(baseCommand)) continue
    hasNonFallbackCommand = true
    if (!SHELL_QUIET_WORDS.has(baseCommand)) return false
  }
  return hasNonFallbackCommand
}
