/**
 * Contract: `extractShellWriteCandidates` is a pure, static read of a shell
 * command line for the files it may write (F-6): redirect targets, the
 * operands of known writing commands, and, as weaker `argument` candidates,
 * the plain file operands of commands not known to be read-only — resolved
 * against the call's cwd with `cd` tracked along a chain. It never touches
 * the filesystem or expands `$vars`, globs or substitutions (such words are
 * not candidates); it leans towards over-reporting, which the caller prunes.
 */
import {
  basenameRuntimePath,
  dirnameRuntimePath,
  joinRuntimePath,
  resolveRuntimePath,
} from '../../utils/runtimePaths'
import { isNativeWindowsAbsolute, shellPathToWindows } from '../../utils/hostPathForm'
import { normalizePathKey } from '../../utils/paths'

export type ShellKind = 'bash' | 'powershell'

/** How strongly the command line names the path as a write target.
 *  `redirect`/`writer`: a redirect target or a writing command's operand —
 *  captured whether or not the file exists. `argument`: a plain operand of a
 *  command whose effect is unknown — captured only when it is an existing,
 *  reasonably small file. */
export type ShellWriteSource = 'redirect' | 'writer' | 'argument'

export type ShellWriteCandidate = {
  /** Absolute runtime path. */
  path: string
  source: ShellWriteSource
  /** What to do when the path is a directory: `tree` captures its files
   *  (a recursive removal or a move), `skip` ignores it. */
  onDirectory: 'skip' | 'tree'
}

export type ShellWriteOptions = {
  shell: ShellKind
  /** The directory the command starts in (absolute). */
  cwd: string
  /** Expands a leading `~`; without it such words are dropped. */
  homeDir?: string
}

/** Candidates per command line, strongest first; the rest are dropped. */
export const MAX_WRITE_CANDIDATES = 64
/** Weak (`argument`) candidates per simple command. */
export const MAX_ARGUMENT_CANDIDATES = 32
const MAX_WORD_LENGTH = 512
const MAX_NESTING = 4

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type Word = {
  kind: 'word'
  /** The word with quotes removed. */
  text: string
  /** False when the word carries an expansion or a glob the shell would
   *  rewrite — never a candidate, but still an operand for structure. */
  literal: boolean
  /** PowerShell: this word continues the previous word's list (`a, b`). */
  continues?: boolean
}
type Op = { kind: 'op'; text: string }
type Redirect = { kind: 'redirect'; op: string }
type Token = Word | Op | Redirect

type Tokenized = {
  tokens: Token[]
  /** Command substitutions and script blocks, analysed as nested lines. */
  nested: string[]
}

const BASH_OPS = ['||', '&&', ';;', '|', ';', '&', '(', ')'] as const

function readBalanced(src: string, start: number, open: string, close: string): number {
  let depth = 0
  let i = start
  let quote: string | null = null
  while (i < src.length) {
    const ch = src[i]!
    if (quote) {
      if (ch === '\\' && quote === '"') i++
      else if (ch === quote) quote = null
    } else if (ch === "'" || ch === '"') {
      quote = ch
    } else if (ch === '\\') {
      i++
    } else if (ch === open) {
      depth++
    } else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return src.length
}

function tokenizeBash(command: string): Tokenized {
  const tokens: Token[] = []
  const nested: string[] = []
  let buf = ''
  let hasWord = false
  let literal = true
  let pendingHeredocs: Array<{ delimiter: string; stripTabs: boolean }> = []
  let expectHeredocDelimiter: boolean | 'strip' = false

  const flush = (): void => {
    if (!hasWord) return
    if (expectHeredocDelimiter) {
      pendingHeredocs.push({ delimiter: buf, stripTabs: expectHeredocDelimiter === 'strip' })
      expectHeredocDelimiter = false
    } else {
      tokens.push({ kind: 'word', text: buf, literal })
    }
    buf = ''
    hasWord = false
    literal = true
  }
  const skipHeredocBodies = (from: number): number => {
    let i = from
    for (const { delimiter, stripTabs } of pendingHeredocs) {
      while (i < command.length) {
        let end = command.indexOf('\n', i)
        if (end === -1) end = command.length
        let line = command.slice(i, end)
        if (stripTabs) line = line.replace(/^\t+/, '')
        i = end + 1
        if (line === delimiter) break
      }
    }
    pendingHeredocs = []
    return Math.min(i, command.length)
  }

  let i = 0
  while (i < command.length) {
    const ch = command[i]!
    const next = command[i + 1]
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flush()
      i++
      continue
    }
    if (ch === '\n') {
      flush()
      tokens.push({ kind: 'op', text: ';' })
      i++
      if (pendingHeredocs.length > 0) i = skipHeredocBodies(i)
      continue
    }
    if (ch === '#' && !hasWord) {
      while (i < command.length && command[i] !== '\n') i++
      continue
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1)
      const body = end === -1 ? command.slice(i + 1) : command.slice(i + 1, end)
      buf += body
      hasWord = true
      i = end === -1 ? command.length : end + 1
      continue
    }
    if (ch === '"') {
      i++
      hasWord = true
      while (i < command.length && command[i] !== '"') {
        const c = command[i]!
        if (c === '\\' && i + 1 < command.length && '"\\$`\n'.includes(command[i + 1]!)) {
          if (command[i + 1] !== '\n') buf += command[i + 1]!
          i += 2
          continue
        }
        if (c === '$' && command[i + 1] === '(') {
          const close = readBalanced(command, i + 1, '(', ')')
          nested.push(command.slice(i + 2, close))
          literal = false
          i = close + 1
          continue
        }
        if (c === '`') {
          const close = command.indexOf('`', i + 1)
          nested.push(close === -1 ? command.slice(i + 1) : command.slice(i + 1, close))
          literal = false
          i = close === -1 ? command.length : close + 1
          continue
        }
        if (c === '$') literal = false
        buf += c
        i++
      }
      i++
      continue
    }
    if (ch === '\\') {
      if (next === undefined) {
        i++
        continue
      }
      if (next !== '\n') {
        buf += next
        hasWord = true
      }
      i += 2
      continue
    }
    if (ch === '$') {
      hasWord = true
      literal = false
      if (next === '(') {
        const close = readBalanced(command, i + 1, '(', ')')
        nested.push(command.slice(i + 2, close))
        i = close + 1
        continue
      }
      if (next === '{') {
        const close = command.indexOf('}', i)
        i = close === -1 ? command.length : close + 1
        continue
      }
      i++
      while (i < command.length && /[A-Za-z0-9_@#?!*$-]/.test(command[i]!)) i++
      continue
    }
    if (ch === '`') {
      const close = command.indexOf('`', i + 1)
      nested.push(close === -1 ? command.slice(i + 1) : command.slice(i + 1, close))
      hasWord = true
      literal = false
      i = close === -1 ? command.length : close + 1
      continue
    }
    if (ch === '*' || ch === '?' || ch === '[') {
      literal = false
      buf += ch
      hasWord = true
      i++
      continue
    }
    // Redirections, with an optional leading descriptor glued to the word.
    if (ch === '<' || ch === '>' || (ch === '&' && (next === '>' ))) {
      const fdPrefixed = hasWord && /^\d+$/.test(buf)
      if (fdPrefixed) {
        buf = ''
        hasWord = false
      } else {
        flush()
      }
      let op = ch
      if (ch === '&') op = command[i + 2] === '>' ? '&>>' : '&>'
      else if (ch === '>') {
        if (next === '>') op = '>>'
        else if (next === '|') op = '>|'
        else if (next === '&') op = '>&'
      } else if (ch === '<') {
        if (next === '<') op = command[i + 2] === '<' ? '<<<' : command[i + 2] === '-' ? '<<-' : '<<'
        else if (next === '&') op = '<&'
      }
      i += op.length
      if (op === '<<' || op === '<<-') {
        expectHeredocDelimiter = op === '<<-' ? 'strip' : true
        continue
      }
      tokens.push({ kind: 'redirect', op })
      continue
    }
    let matchedOp: string | null = null
    for (const op of BASH_OPS) {
      if (command.startsWith(op, i)) {
        matchedOp = op
        break
      }
    }
    if (matchedOp) {
      flush()
      tokens.push({ kind: 'op', text: matchedOp })
      i += matchedOp.length
      continue
    }
    buf += ch
    hasWord = true
    i++
  }
  flush()
  return { tokens, nested }
}

const PS_OPS = ['||', '&&', '|', ';'] as const

function tokenizePowerShell(command: string): Tokenized {
  const tokens: Token[] = []
  const nested: string[] = []
  let buf = ''
  let hasWord = false
  let literal = true
  // A comma joins list elements (`a.txt,b.txt`, `a.txt, b.txt`): the parts
  // after the first continue the list.
  let continues = false
  const flush = (): void => {
    if (!hasWord) return
    const parts = buf.split(',')
    parts.forEach((part, index) => {
      if (part.length === 0) return
      tokens.push({ kind: 'word', text: part, literal, ...(continues || index > 0 ? { continues: true } : {}) })
    })
    continues = buf.endsWith(',')
    buf = ''
    hasWord = false
    literal = true
  }
  let i = 0
  while (i < command.length) {
    const ch = command[i]!
    const next = command[i + 1]
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flush()
      i++
      continue
    }
    if (ch === '\n') {
      flush()
      tokens.push({ kind: 'op', text: ';' })
      i++
      continue
    }
    if (ch === '#' && !hasWord) {
      while (i < command.length && command[i] !== '\n') i++
      continue
    }
    if (ch === '<' && next === '#') {
      const close = command.indexOf('#>', i + 2)
      i = close === -1 ? command.length : close + 2
      continue
    }
    if (ch === "'") {
      i++
      hasWord = true
      while (i < command.length) {
        if (command[i] === "'") {
          if (command[i + 1] === "'") {
            buf += "'"
            i += 2
            continue
          }
          break
        }
        buf += command[i]!
        i++
      }
      i++
      continue
    }
    if (ch === '"') {
      i++
      hasWord = true
      while (i < command.length && command[i] !== '"') {
        const c = command[i]!
        if (c === '`' && i + 1 < command.length) {
          buf += command[i + 1]!
          i += 2
          continue
        }
        if (c === '"' ) break
        if (c === '$') {
          literal = false
          if (command[i + 1] === '(') {
            const close = readBalanced(command, i + 1, '(', ')')
            nested.push(command.slice(i + 2, close))
            i = close + 1
            continue
          }
        }
        buf += c
        i++
      }
      i++
      continue
    }
    if (ch === '`') {
      if (next !== undefined && next !== '\n') {
        buf += next
        hasWord = true
      }
      i += 2
      continue
    }
    if (ch === '$' || ch === '@') {
      if (next === '(' || (ch === '@' && next === '{')) {
        const close = readBalanced(command, i + 1, next, next === '(' ? ')' : '}')
        if (next === '(') nested.push(command.slice(i + 2, close))
        hasWord = true
        literal = false
        i = close + 1
        continue
      }
      if (ch === '$') {
        hasWord = true
        literal = false
        i++
        while (i < command.length && /[A-Za-z0-9_:.]/.test(command[i]!)) i++
        continue
      }
    }
    if (ch === '(' || ch === '{') {
      const close = readBalanced(command, i, ch, ch === '(' ? ')' : '}')
      const inner = command.slice(i + 1, close)
      if (ch === '(' && hasWord) {
        // A method call: its arguments are this command's words.
        flush()
        for (const token of tokenizePowerShell(inner).tokens) {
          if (token.kind === 'word') tokens.push(token)
        }
      } else {
        nested.push(inner)
        flush()
        if (ch === '(') tokens.push({ kind: 'word', text: '', literal: false })
      }
      i = close + 1
      continue
    }
    if (ch === '*' || ch === '?' || ch === '[') {
      if (ch === '*' && next === '>') {
        flush()
        const op = command[i + 2] === '>' ? '>>' : '>'
        tokens.push({ kind: 'redirect', op })
        i += op.length + 1
        continue
      }
      literal = false
      buf += ch
      hasWord = true
      i++
      continue
    }
    if (ch === '>') {
      const fdPrefixed = hasWord && /^\d+$/.test(buf)
      if (fdPrefixed) {
        buf = ''
        hasWord = false
      } else {
        flush()
      }
      const op = next === '>' ? '>>' : '>'
      tokens.push({ kind: 'redirect', op })
      i += op.length
      continue
    }
    let matchedOp: string | null = null
    for (const op of PS_OPS) {
      if (command.startsWith(op, i)) {
        matchedOp = op
        break
      }
    }
    if (matchedOp) {
      flush()
      tokens.push({ kind: 'op', text: matchedOp })
      i += matchedOp.length
      continue
    }
    buf += ch
    hasWord = true
    i++
  }
  flush()
  return { tokens, nested }
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

const SOURCE_RANK: Record<ShellWriteSource, number> = { redirect: 0, writer: 1, argument: 2 }

class Collector {
  readonly byKey = new Map<string, ShellWriteCandidate>()
  readonly homeDir?: string
  readonly shell: ShellKind
  constructor(opts: ShellWriteOptions) {
    this.homeDir = opts.homeDir
    this.shell = opts.shell
  }

  add(
    word: Word | string | undefined,
    cwd: string,
    source: ShellWriteSource,
    onDirectory: 'skip' | 'tree' = 'skip',
  ): void {
    if (word === undefined) return
    const text = typeof word === 'string' ? word : word.text
    if (typeof word !== 'string' && !word.literal) return
    const abs = resolveShellWord(text, cwd, this.homeDir, this.shell)
    if (!abs) return
    const key = normalizePathKey(abs)
    const prior = this.byKey.get(key)
    if (prior) {
      if (SOURCE_RANK[source] < SOURCE_RANK[prior.source]) prior.source = source
      if (onDirectory === 'tree') prior.onDirectory = 'tree'
      return
    }
    this.byKey.set(key, { path: abs, source, onDirectory })
  }

  result(): ShellWriteCandidate[] {
    return [...this.byKey.values()]
      .sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source])
      .slice(0, MAX_WRITE_CANDIDATES)
  }
}

const WINDOWS_DEVICE_NAMES = new Set(['nul', 'con', 'prn', 'aux'])

/** A word → an absolute runtime path, or null when it cannot name a host
 *  file: empty, `-`, a device, an unexpandable `~user`, a URL, or a POSIX
 *  absolute path that is not a drive on a Windows host. */
export function resolveShellWord(
  word: string,
  cwd: string,
  homeDir: string | undefined,
  shell: ShellKind,
): string | null {
  if (word.length === 0 || word.length > MAX_WORD_LENGTH || word === '-') return null
  if (word.includes('://')) return null
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) && !/[\\/]/.test(word)) return null
  const lower = word.toLowerCase()
  if (
    WINDOWS_DEVICE_NAMES.has(lower) ||
    lower === '$null' ||
    lower.startsWith('/dev/') ||
    lower.startsWith('/proc/')
  ) {
    return null
  }
  let p = word
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    if (!homeDir) return null
    p = homeDir + p.slice(1)
  } else if (p.startsWith('~')) {
    return null
  }
  const windowsHost = isNativeWindowsAbsolute(cwd)
  if (windowsHost && p.startsWith('/')) {
    if (/^\/[A-Za-z](\/|$)/.test(p) || p.startsWith('/cygdrive/')) {
      p = shellPathToWindows(p)
    } else {
      return null
    }
  }
  if (windowsHost && /^[A-Za-z]:$/.test(p)) return null
  if (shell === 'powershell') {
    // Provider-qualified paths name a drive we can read (`Filesystem::C:\x`).
    p = p.replace(/^(?:Microsoft\.PowerShell\.Core\\)?FileSystem::/i, '')
    if (/^[A-Za-z]+::/.test(p)) return null
  }
  return resolveRuntimePath(cwd, p)
}

// ---------------------------------------------------------------------------
// Bash
// ---------------------------------------------------------------------------

type Simple = { words: Word[]; redirects: Array<{ op: string; target: Word | null }> }

function splitSimple(tokens: Token[], acceptsRedirectWord: (op: string) => boolean): Simple[] {
  const out: Simple[] = []
  let current: Simple = { words: [], redirects: [] }
  const close = (): void => {
    if (current.words.length > 0 || current.redirects.length > 0) out.push(current)
    current = { words: [], redirects: [] }
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.kind === 'op') {
      close()
      continue
    }
    if (token.kind === 'redirect') {
      const nextToken = tokens[i + 1]
      if (acceptsRedirectWord(token.op) && nextToken?.kind === 'word') {
        current.redirects.push({ op: token.op, target: nextToken })
        i++
      } else {
        current.redirects.push({ op: token.op, target: null })
      }
      continue
    }
    current.words.push(token)
  }
  close()
  return out
}

const BASH_WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '>&'])

/** Commands whose operands are only read; their arguments are never
 *  candidates. Writing forms (`sort -o`, `curl -o`, …) have their own rule. */
const BASH_READ_ONLY = new Set([
  'cat', 'less', 'more', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack',
  'ls', 'll', 'find', 'wc', 'diff', 'cmp', 'comm', 'stat', 'file', 'md5sum', 'sha1sum',
  'sha256sum', 'sha512sum', 'cksum', 'echo', 'printf', 'test', 'which', 'type', 'whereis',
  'pwd', 'true', 'false', 'sleep', 'cut', 'uniq', 'tr', 'xxd', 'od', 'hexdump', 'strings',
  'du', 'df', 'ps', 'kill', 'pkill', 'killall', 'date', 'uname', 'whoami', 'hostname', 'env',
  'printenv', 'read', 'basename', 'dirname', 'realpath', 'readlink', 'tree', 'column', 'nl',
  'tac', 'rev', 'paste', 'fold', 'seq', 'bc', 'expr', 'jq', 'open', 'xdg-open', 'start',
  'clear', 'history', 'man', 'help', 'info', 'ping', 'nslookup', 'dig', 'ssh', 'id', 'groups',
  'lsof', 'netstat', 'ss', 'top', 'free', 'uptime', 'wait', 'exit', 'return', 'shift', 'set',
  'unset', 'export', 'local', 'declare', 'typeset', 'readonly', 'alias', 'unalias', 'trap',
  'source', '.', 'eval', 'ulimit', 'umask', 'hash', 'getopts', 'let', 'mkdir', 'rmdir',
  'chmod', 'chown', 'chgrp', 'mkfifo', 'mktemp', 'code', 'yes', 'nproc', 'tty',
  'stty', 'tput', 'gh', 'docker', 'kubectl',
])

/** Words that open a compound command; the real command follows them. */
const BASH_PREFIX_WORDS = new Set([
  'if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{', 'time', 'nohup', 'command',
  'builtin', 'exec', 'nice', 'ionice', 'caffeinate', 'strace', 'ltrace',
])
const BASH_STOP_WORDS = new Set(['fi', 'done', 'esac', '}', 'for', 'in', 'case', 'select', 'function', '[', '[[', ']]', ']'])

const GIT_READ_ONLY = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'describe', 'blame', 'ls-files', 'ls-tree',
  'cat-file', 'shortlog', 'reflog', 'whatchanged', 'version', 'branch', 'tag', 'remote',
  'config', 'fetch', 'push', 'add', 'commit', 'grep', 'bisect', 'worktree', 'submodule',
  'notes', 'help', 'init', 'clone', 'archive', 'bundle', 'count-objects', 'fsck', 'gc',
  'for-each-ref', 'name-rev', 'merge-base', 'rev-list', 'symbolic-ref', 'update-index', 'stash',
])
const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])

type ParsedArgs = {
  positional: Word[]
  /** Flag words as written (`-rf`, `--in-place=.bak`). */
  flags: string[]
  /** Values of the flags named in `valueFlags`, by flag. */
  values: Map<string, Word[]>
}

/** Split operands from flags. A flag in `valueFlags` takes the next word (or
 *  its `=` tail); `--` ends flag parsing. */
function parseArgs(args: Word[], valueFlags: ReadonlySet<string> = new Set()): ParsedArgs {
  const positional: Word[] = []
  const flags: string[] = []
  const values = new Map<string, Word[]>()
  const addValue = (flag: string, value: Word | undefined): void => {
    if (!value) return
    const list = values.get(flag) ?? []
    list.push(value)
    values.set(flag, list)
  }
  let onlyPositional = false
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!
    const text = word.text
    if (onlyPositional || text === '-' || !text.startsWith('-') || text.length < 2) {
      positional.push(word)
      continue
    }
    if (text === '--') {
      onlyPositional = true
      continue
    }
    flags.push(text)
    const eq = text.indexOf('=')
    if (text.startsWith('--')) {
      const name = eq === -1 ? text : text.slice(0, eq)
      if (valueFlags.has(name)) {
        if (eq !== -1) addValue(name, { kind: 'word', text: text.slice(eq + 1), literal: word.literal })
        else addValue(name, args[++i])
      }
      continue
    }
    // Short flags: `-o FILE`, `-oFILE`, `-xo FILE` (the value flag last).
    for (let j = 1; j < text.length; j++) {
      const short = `-${text[j]!}`
      if (!valueFlags.has(short)) continue
      const rest = text.slice(j + 1)
      if (rest.length > 0) addValue(short, { kind: 'word', text: rest, literal: word.literal })
      else addValue(short, args[++i])
      break
    }
  }
  return { positional, flags, values }
}

function hasShortFlag(flags: readonly string[], letter: string, longForms: readonly string[] = []): boolean {
  return flags.some(flag => {
    if (flag.startsWith('--')) return longForms.some(long => flag === long || flag.startsWith(`${long}=`))
    const letters = /^-([A-Za-z]+)/.exec(flag)?.[1] ?? ''
    return letters.includes(letter)
  })
}

type BashRule = (parsed: ParsedArgs, add: (word: Word | string | undefined, source: ShellWriteSource, onDirectory?: 'skip' | 'tree') => void, cwd: string) => void

function copyLikeDestinations(
  parsed: ParsedArgs,
  add: Parameters<BashRule>[1],
  cwd: string,
  opts: { targetDirFlags: string[]; sourcesMove: boolean; treeSources: boolean },
): void {
  const targetDir = opts.targetDirFlags.map(f => parsed.values.get(f)?.[0]).find(Boolean)
  const operands = parsed.positional
  const sources = targetDir ? operands : operands.slice(0, -1)
  const dest = targetDir ?? operands[operands.length - 1]
  if (!dest || sources.length === 0) return
  for (const src of sources) {
    if (opts.sourcesMove) add(src, 'writer', opts.treeSources ? 'tree' : 'skip')
    // The destination is the file itself, or the file placed inside a
    // destination directory; the caller resolves which exists.
    if (src.literal && dest.literal) {
      const destAbs = resolveShellWord(dest.text, cwd, undefined, 'bash')
      if (destAbs) add(joinRuntimePath(destAbs, basenameRuntimePath(src.text)), 'writer')
    }
  }
  add(dest, 'writer')
}

const BASH_WRITERS: Record<string, { valueFlags?: string[]; rule: BashRule }> = {
  tee: { rule: (p, add) => p.positional.forEach(w => add(w, 'writer')) },
  touch: {
    valueFlags: ['-d', '-r', '-t', '--date', '--reference'],
    rule: (p, add) => p.positional.forEach(w => add(w, 'writer')),
  },
  truncate: { valueFlags: ['-s', '--size', '-r', '--reference'], rule: (p, add) => p.positional.forEach(w => add(w, 'writer')) },
  shred: { valueFlags: ['-n', '-s', '--iterations', '--size'], rule: (p, add) => p.positional.forEach(w => add(w, 'writer')) },
  unlink: { rule: (p, add) => p.positional.forEach(w => add(w, 'writer')) },
  ln: {
    valueFlags: ['-t', '--target-directory', '-S', '--suffix'],
    rule: (p, add) => {
      const targetDir = p.values.get('-t')?.[0] ?? p.values.get('--target-directory')?.[0]
      if (targetDir) return
      add(p.positional[p.positional.length - 1], 'writer')
    },
  },
  rm: {
    rule: (p, add) => {
      const recursive = hasShortFlag(p.flags, 'r', ['--recursive']) || hasShortFlag(p.flags, 'R')
      p.positional.forEach(w => add(w, 'writer', recursive ? 'tree' : 'skip'))
    },
  },
  cp: {
    valueFlags: ['-t', '--target-directory', '-S', '--suffix'],
    rule: (p, add, cwd) => copyLikeDestinations(p, add, cwd, { targetDirFlags: ['-t', '--target-directory'], sourcesMove: false, treeSources: false }),
  },
  install: {
    valueFlags: ['-t', '--target-directory', '-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group'],
    rule: (p, add, cwd) => copyLikeDestinations(p, add, cwd, { targetDirFlags: ['-t', '--target-directory'], sourcesMove: false, treeSources: false }),
  },
  mv: {
    valueFlags: ['-t', '--target-directory', '-S', '--suffix'],
    rule: (p, add, cwd) => copyLikeDestinations(p, add, cwd, { targetDirFlags: ['-t', '--target-directory'], sourcesMove: true, treeSources: true }),
  },
  dd: {
    rule: (p, add) => {
      for (const w of p.positional) {
        if (w.text.startsWith('of=')) add({ ...w, text: w.text.slice(3) }, 'writer')
      }
    },
  },
  sort: { valueFlags: ['-o', '--output', '-k', '-t', '-S', '-T'], rule: (p, add) => (p.values.get('-o') ?? p.values.get('--output') ?? []).forEach(w => add(w, 'writer')) },
  curl: {
    valueFlags: ['-o', '--output', '-d', '--data', '-H', '--header', '-X', '--request', '-u', '--user', '-A', '--user-agent', '-e', '--referer', '-F', '--form', '-T', '--upload-file', '-b', '--cookie', '-c', '--cookie-jar', '-m', '--max-time', '-w', '--write-out', '-K', '--config', '-x', '--proxy', '--retry', '--connect-timeout'],
    rule: (p, add) => {
      ;(p.values.get('-o') ?? []).concat(p.values.get('--output') ?? []).forEach(w => add(w, 'writer'))
      ;(p.values.get('-c') ?? []).concat(p.values.get('--cookie-jar') ?? []).forEach(w => add(w, 'writer'))
    },
  },
  wget: {
    valueFlags: ['-O', '--output-document', '-P', '--directory-prefix', '-o', '--output-file', '-a', '--append-output', '-U', '--user-agent', '-T', '--timeout', '-t', '--tries', '--header', '--post-data', '--post-file'],
    rule: (p, add) => (p.values.get('-O') ?? []).concat(p.values.get('--output-document') ?? []).forEach(w => add(w, 'writer')),
  },
  sed: {
    valueFlags: ['-e', '--expression', '-f', '--file', '-l', '--line-length'],
    rule: (p, add) => {
      const inPlace = hasShortFlag(p.flags, 'i', ['--in-place'])
      if (!inPlace) return
      const scriptGiven = p.values.has('-e') || p.values.has('--expression') || p.values.has('-f') || p.values.has('--file')
      const files = scriptGiven ? p.positional : p.positional.slice(1)
      files.forEach(w => add(w, 'writer'))
    },
  },
  perl: {
    valueFlags: ['-e', '-E', '-I', '-M', '-m', '-C', '-x'],
    rule: (p, add) => {
      if (!hasShortFlag(p.flags, 'i')) return
      const scriptGiven = p.values.has('-e') || p.values.has('-E')
      const files = scriptGiven ? p.positional : p.positional.slice(1)
      files.forEach(w => add(w, 'writer'))
    },
  },
  awk: {
    valueFlags: ['-f', '-v', '-F', '-i', '--include', '-W'],
    rule: (p, add) => {
      const inPlace = (p.values.get('-i') ?? []).some(w => w.text === 'inplace')
      if (!inPlace) return
      const files = p.values.has('-f') ? p.positional : p.positional.slice(1)
      files.forEach(w => add(w, 'writer'))
    },
  },
  yq: {
    valueFlags: ['-o', '--output-format', '-p', '--input-format', '--indent', '-f', '--from-file'],
    rule: (p, add) => {
      if (!hasShortFlag(p.flags, 'i', ['--inplace'])) return
      const files = p.values.has('-f') ? p.positional : p.positional.slice(1)
      files.forEach(w => add(w, 'writer'))
    },
  },
  patch: {
    valueFlags: ['-i', '--input', '-p', '--strip', '-d', '--directory', '-o', '--output', '-r', '--reject-file', '-D', '--ifdef', '-F', '--fuzz', '-B', '--prefix', '-z', '--suffix'],
    rule: (p, add) => {
      add(p.positional[0], 'writer')
      ;(p.values.get('-o') ?? []).concat(p.values.get('--output') ?? []).forEach(w => add(w, 'writer'))
    },
  },
  gzip: { valueFlags: ['-S', '--suffix'], rule: (p, add) => p.positional.forEach(w => { add(w, 'writer'); add({ ...w, text: `${w.text}.gz` }, 'writer') }) },
  gunzip: { valueFlags: ['-S', '--suffix'], rule: (p, add) => p.positional.forEach(w => { add(w, 'writer'); add({ ...w, text: w.text.replace(/\.gz$/, '') }, 'writer') }) },
  bzip2: { rule: (p, add) => p.positional.forEach(w => { add(w, 'writer'); add({ ...w, text: `${w.text}.bz2` }, 'writer') }) },
  bunzip2: { rule: (p, add) => p.positional.forEach(w => { add(w, 'writer'); add({ ...w, text: w.text.replace(/\.bz2$/, '') }, 'writer') }) },
  xz: { rule: (p, add) => p.positional.forEach(w => { add(w, 'writer'); add({ ...w, text: `${w.text}.xz` }, 'writer') }) },
  unxz: { rule: (p, add) => p.positional.forEach(w => { add(w, 'writer'); add({ ...w, text: w.text.replace(/\.xz$/, '') }, 'writer') }) },
  zstd: { valueFlags: ['-o', '-T', '--threads'], rule: (p, add) => { (p.values.get('-o') ?? []).forEach(w => add(w, 'writer')); p.positional.forEach(w => add({ ...w, text: `${w.text}.zst` }, 'writer')) } },
  zip: { valueFlags: ['-b', '-t', '-tt', '-x', '-i', '-n'], rule: (p, add) => add(p.positional[0], 'writer') },
  tar: {
    valueFlags: ['-f', '--file', '-C', '--directory', '-T', '--files-from', '-X', '--exclude-from', '--exclude', '--transform', '--owner', '--group', '--mode', '--mtime'],
    rule: (p, add) => {
      const modeWord = p.positional[0]?.text ?? ''
      const creates = hasShortFlag(p.flags, 'c', ['--create']) || (/^[a-z]+$/.test(modeWord) && modeWord.includes('c'))
      if (!creates) return
      ;(p.values.get('-f') ?? []).concat(p.values.get('--file') ?? []).forEach(w => add(w, 'writer'))
      if (!p.values.has('-f') && !p.values.has('--file') && /^[a-z]+$/.test(modeWord) && modeWord.includes('f')) add(p.positional[1], 'writer')
    },
  },
}

/** `cmd` builtins of the Windows shell (`cmd /c …`), read with the bash tokenizer. */
const CMD_WRITERS: Record<string, BashRule> = {
  copy: (p, add, cwd) => copyLikeDestinations(p, add, cwd, { targetDirFlags: [], sourcesMove: false, treeSources: false }),
  move: (p, add, cwd) => copyLikeDestinations(p, add, cwd, { targetDirFlags: [], sourcesMove: true, treeSources: true }),
  del: (p, add) => p.positional.forEach(w => add(w, 'writer')),
  erase: (p, add) => p.positional.forEach(w => add(w, 'writer')),
  rd: (p, add) => p.positional.forEach(w => add(w, 'writer', 'tree')),
  ren: (p, add, cwd) => {
    const [from, to] = p.positional
    add(from, 'writer')
    if (from?.literal && to?.literal) {
      const fromAbs = resolveShellWord(from.text, cwd, undefined, 'bash')
      if (fromAbs) add(joinRuntimePath(dirnameRuntimePath(fromAbs), to.text), 'writer')
    }
  },
}

/** Wrappers whose operands precede the real command. Each maps to the flags
 *  that take a value, so `sudo -u root cmd` finds `cmd`. */
const BASH_WRAPPERS: Record<string, {
  valueFlags: string[]
  /** Operands to step over before the command (`timeout 30 cmd`). */
  positionalSkip?: number
  envAssignments?: boolean
  /** Only a wrapper when its first operand is one of these (`npm exec cmd`);
   *  otherwise an ordinary command. */
  onlyWhenSecondWord?: string[]
}> = {
  sudo: { valueFlags: ['-u', '-g', '-p', '-C', '-h', '-r', '-t', '-U', '--user', '--group'] },
  doas: { valueFlags: ['-u'] },
  env: { valueFlags: ['-u', '-C', '-S', '--unset', '--chdir', '--split-string'], envAssignments: true },
  nice: { valueFlags: ['-n', '--adjustment'] },
  ionice: { valueFlags: ['-c', '-n', '-p'] },
  nohup: { valueFlags: [] },
  time: { valueFlags: ['-f', '-o'] },
  command: { valueFlags: [] },
  builtin: { valueFlags: [] },
  exec: { valueFlags: ['-a'] },
  stdbuf: { valueFlags: ['-i', '-o', '-e'] },
  timeout: { valueFlags: ['-s', '-k', '--signal', '--kill-after'], positionalSkip: 1 },
  caffeinate: { valueFlags: ['-t', '-w'] },
  xargs: { valueFlags: ['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a', '--arg-file', '--delimiter', '--max-args', '--max-lines', '--max-procs', '--replace'] },
  strace: { valueFlags: ['-o', '-e', '-p', '-s'] },
  // Package runners: the tool they start is the command.
  npx: { valueFlags: ['-p', '--package', '-c', '--call', '--shell'] },
  bunx: { valueFlags: ['-p', '--package'] },
  uvx: { valueFlags: ['--from', '--with', '-p', '--python'] },
  poetry: { valueFlags: [], positionalSkip: 1, onlyWhenSecondWord: ['run'] },
  uv: { valueFlags: [], positionalSkip: 1, onlyWhenSecondWord: ['run'] },
  pipx: { valueFlags: [], positionalSkip: 1, onlyWhenSecondWord: ['run'] },
  npm: { valueFlags: [], positionalSkip: 1, onlyWhenSecondWord: ['exec', 'x'] },
  pnpm: { valueFlags: [], positionalSkip: 1, onlyWhenSecondWord: ['exec', 'dlx'] },
  yarn: { valueFlags: [], positionalSkip: 1, onlyWhenSecondWord: ['exec', 'dlx'] },
  bun: { valueFlags: [], positionalSkip: 1, onlyWhenSecondWord: ['x'] },
}

/** Interpreters whose `-c`-style flag carries a nested command line. */
const NESTED_SHELLS: Record<string, { flags: string[]; shell: ShellKind }> = {
  bash: { flags: ['-c'], shell: 'bash' },
  sh: { flags: ['-c'], shell: 'bash' },
  zsh: { flags: ['-c'], shell: 'bash' },
  dash: { flags: ['-c'], shell: 'bash' },
  pwsh: { flags: ['-c', '-command', '-Command'], shell: 'powershell' },
  powershell: { flags: ['-c', '-command', '-Command'], shell: 'powershell' },
  cmd: { flags: ['/c', '/C', '/k', '/K'], shell: 'bash' },
}

function commandName(word: Word): string {
  const base = word.text.replace(/\\/g, '/').split('/').pop() ?? ''
  return base.toLowerCase().replace(/\.exe$/, '')
}

function analyzeBash(command: string, opts: ShellWriteOptions, collector: Collector, depth: number, startCwd: string): string {
  if (depth > MAX_NESTING) return startCwd
  const { tokens, nested } = tokenizeBash(command)
  let cwd = startCwd
  for (const simple of splitSimple(tokens, () => true)) {
    cwd = analyzeBashSimple(simple, opts, collector, depth, cwd)
  }
  for (const inner of nested) analyzeBash(inner, opts, collector, depth + 1, cwd)
  return cwd
}

function analyzeBashSimple(simple: Simple, opts: ShellWriteOptions, collector: Collector, depth: number, cwd: string): string {
  const add: Parameters<BashRule>[1] = (word, source, onDirectory) => collector.add(word, cwd, source, onDirectory)
  for (const redirect of simple.redirects) {
    if (!redirect.target || !BASH_WRITE_REDIRECTS.has(redirect.op)) continue
    // `>&2` duplicates a descriptor; `>&file` writes the file.
    if (redirect.op === '>&' && /^\d+$|^-$/.test(redirect.target.text)) continue
    add(redirect.target, 'redirect')
  }
  let words = simple.words
  // Leading assignments and wrappers.
  for (;;) {
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!.text)) words = words.slice(1)
    const head = words[0]
    if (!head) return cwd
    const name = commandName(head)
    if (BASH_STOP_WORDS.has(name) || name === '') return cwd
    if (BASH_PREFIX_WORDS.has(name) && !(name in BASH_WRAPPERS)) {
      words = words.slice(1)
      continue
    }
    const wrapper = BASH_WRAPPERS[name]
    if (
      wrapper &&
      (!wrapper.onlyWhenSecondWord || wrapper.onlyWhenSecondWord.includes(words[1]?.text ?? ''))
    ) {
      const valueFlags = new Set(wrapper.valueFlags)
      let i = 1
      let skipped = 0
      while (i < words.length) {
        const text = words[i]!.text
        if (text === '--') {
          i++
          break
        }
        if (text.startsWith('-') && text.length > 1) {
          const eq = text.indexOf('=')
          const flagName = text.startsWith('--') && eq !== -1 ? text.slice(0, eq) : text
          const takesValue = valueFlags.has(flagName) || (!text.startsWith('--') && text.length === 2 && valueFlags.has(text))
          i += takesValue && eq === -1 ? 2 : 1
          continue
        }
        if (wrapper.envAssignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) {
          i++
          continue
        }
        if (skipped < (wrapper.positionalSkip ?? 0)) {
          skipped++
          i++
          continue
        }
        break
      }
      words = words.slice(i)
      continue
    }
    break
  }
  const head = words[0]!
  const name = commandName(head)
  const args = words.slice(1)

  if (name === 'cd' || name === 'pushd') {
    const target = args.find(w => !w.text.startsWith('-') || w.text === '-')
    if (!target) return opts.homeDir ?? cwd
    if (!target.literal || target.text === '-') return cwd
    const next = resolveShellWord(target.text, cwd, opts.homeDir, 'bash')
    return next ?? cwd
  }
  const nestedShell = NESTED_SHELLS[name]
  if (nestedShell) {
    // The word after the script flag (`-c`, `-Command`, `/c`, or a unique
    // prefix of a long PowerShell flag) is a command line in that shell.
    const flags = nestedShell.flags.map(f => f.toLowerCase())
    const scriptIndex = args.findIndex(w => {
      const text = w.text.toLowerCase()
      return flags.includes(text) || (text.length > 2 && flags.some(f => f.length > 2 && f.startsWith(text)))
    })
    const script = scriptIndex === -1 ? undefined : args[scriptIndex + 1]
    if (script) {
      analyzeLine(script.text, { ...opts, shell: nestedShell.shell }, collector, depth + 1, cwd)
    } else {
      genericArguments(parseArgs(args), add)
    }
    return cwd
  }
  if (name === 'git') {
    analyzeGit(args, add, cwd, opts, collector)
    return cwd
  }
  const writer = BASH_WRITERS[name]
  if (writer) {
    writer.rule(parseArgs(args, new Set(writer.valueFlags ?? [])), add, cwd)
    return cwd
  }
  const cmdWriter = CMD_WRITERS[name]
  if (cmdWriter) {
    cmdWriter(parseArgs(args), add, cwd)
    return cwd
  }
  if (BASH_READ_ONLY.has(name)) return cwd
  genericArguments(parseArgs(args), add)
  return cwd
}

function genericArguments(parsed: ParsedArgs, add: Parameters<BashRule>[1]): void {
  let count = 0
  for (const word of parsed.positional) {
    if (count >= MAX_ARGUMENT_CANDIDATES) break
    if (!word.literal || /^\d+$/.test(word.text)) continue
    add(word, 'argument')
    count++
  }
}

function analyzeGit(args: Word[], add: Parameters<BashRule>[1], cwd: string, opts: ShellWriteOptions, collector: Collector): void {
  let i = 0
  let repoCwd = cwd
  while (i < args.length && args[i]!.text.startsWith('-')) {
    const flag = args[i]!.text
    const eq = flag.indexOf('=')
    const name = eq === -1 ? flag : flag.slice(0, eq)
    if (GIT_GLOBAL_VALUE_FLAGS.has(name)) {
      const value = eq === -1 ? args[i + 1] : { ...args[i]!, text: flag.slice(eq + 1) }
      if (name === '-C' && value?.literal) repoCwd = resolveShellWord(value.text, repoCwd, opts.homeDir, 'bash') ?? repoCwd
      i += eq === -1 ? 2 : 1
      continue
    }
    i++
  }
  const sub = args[i]?.text.toLowerCase()
  if (!sub || GIT_READ_ONLY.has(sub)) return
  const addInRepo: typeof add = (word, source, onDirectory) => collector.add(word, repoCwd, source, onDirectory)
  const rest = args.slice(i + 1)
  if (sub === 'mv') {
    const parsed = parseArgs(rest)
    copyLikeDestinations(parsed, addInRepo, repoCwd, { targetDirFlags: [], sourcesMove: true, treeSources: true })
    return
  }
  if (sub === 'rm') {
    const parsed = parseArgs(rest)
    const recursive = hasShortFlag(parsed.flags, 'r')
    parsed.positional.forEach(w => addInRepo(w, 'writer', recursive ? 'tree' : 'skip'))
    return
  }
  // checkout / restore / reset / apply / clean / merge / rebase / cherry-pick /
  // pull / revert / am / switch: the named paths; whole-tree effects are
  // not visible here.
  const parsed = parseArgs(rest, new Set(['-b', '-B', '--orphan', '--source', '-s', '--pathspec-from-file', '-m', '--message', '--strategy', '-X', '--strategy-option', '--onto', '--directory', '--exclude', '--include', '-p', '--mainline']))
  parsed.positional.forEach(w => addInRepo(w, 'argument'))
}

// ---------------------------------------------------------------------------
// PowerShell
// ---------------------------------------------------------------------------

type PsRule = {
  /** Parameter names (lower-case) in positional order; `null` holes skip a
   *  position that is not a path. */
  positional: Array<string | null>
  /** Parameters whose value is a path to capture, by name. */
  pathParams: string[]
  /** Parameters that take a value but are not paths. */
  valueParams?: string[]
  /** Switch parameters that make a removal recursive. */
  recurseSwitch?: boolean
  /** Other command names this rule answers to. */
  aliases?: string[]
  kind: 'write' | 'remove' | 'copy' | 'move' | 'rename' | 'newitem'
}

const PS_COMMON_VALUE_PARAMS = ['encoding', 'filter', 'include', 'exclude', 'erroraction', 'errorvariable', 'warningaction', 'warningvariable', 'informationaction', 'informationvariable', 'outvariable', 'outbuffer', 'pipelinevariable', 'credential', 'value', 'delimiter', 'width', 'depth', 'stream', 'itemtype', 'notypeinformation', 'compressionlevel', 'uri', 'method', 'body', 'headers', 'useragent', 'timeoutsec', 'maximumredirection', 'proxy', 'variable', 'inputobject', 'property', 'first', 'last', 'skip', 'name']

const PS_WRITERS: Record<string, PsRule> = {
  'set-content': { positional: ['path', 'value'], pathParams: ['path', 'literalpath', 'pspath'], aliases: ['sc'], kind: 'write' },
  'add-content': { positional: ['path', 'value'], pathParams: ['path', 'literalpath', 'pspath'], aliases: ['ac'], kind: 'write' },
  'clear-content': { positional: ['path'], pathParams: ['path', 'literalpath', 'pspath'], aliases: ['clc'], kind: 'write' },
  'out-file': { positional: ['filepath'], pathParams: ['filepath', 'literalpath'], kind: 'write' },
  'tee-object': { positional: ['filepath'], pathParams: ['filepath', 'literalpath'], aliases: ['tee'], kind: 'write' },
  'export-csv': { positional: ['path'], pathParams: ['path', 'literalpath'], aliases: ['epcsv'], kind: 'write' },
  'export-clixml': { positional: ['path'], pathParams: ['path', 'literalpath'], kind: 'write' },
  'set-itemproperty': { positional: [], pathParams: [], kind: 'write' },
  'compress-archive': { positional: [null, 'destinationpath'], pathParams: ['destinationpath'], kind: 'write' },
  'invoke-webrequest': { positional: [null], pathParams: ['outfile'], aliases: ['iwr', 'curl', 'wget'], kind: 'write' },
  'invoke-restmethod': { positional: [null], pathParams: ['outfile'], aliases: ['irm'], kind: 'write' },
  'remove-item': { positional: ['path'], pathParams: ['path', 'literalpath'], recurseSwitch: true, aliases: ['rm', 'del', 'erase', 'rd', 'rmdir', 'ri'], kind: 'remove' },
  'copy-item': { positional: ['path', 'destination'], pathParams: ['destination'], aliases: ['cp', 'copy', 'cpi'], kind: 'copy' },
  'move-item': { positional: ['path', 'destination'], pathParams: ['destination'], aliases: ['mv', 'move', 'mi'], kind: 'move' },
  'rename-item': { positional: ['path', 'newname'], pathParams: [], valueParams: ['newname'], aliases: ['ren', 'rni'], kind: 'rename' },
  'new-item': { positional: ['path'], pathParams: ['path'], aliases: ['ni'], kind: 'newitem' },
}
/** Alias → rule name, inverted from each writer's `aliases`. */
const PS_WRITER_BY_ALIAS: ReadonlyMap<string, string> = new Map(
  Object.entries(PS_WRITERS).flatMap(([name, rule]) => (rule.aliases ?? []).map(alias => [alias, name] as const)),
)
const PS_READ_ONLY = new Set([
  'get-content', 'gc', 'cat', 'type', 'get-childitem', 'gci', 'ls', 'dir', 'select-string', 'sls',
  'test-path', 'get-item', 'gi', 'get-itemproperty', 'gp', 'resolve-path', 'rvpa', 'get-location', 'gl',
  'pwd', 'write-output', 'echo', 'write', 'write-host', 'write-error', 'write-warning', 'write-verbose',
  'measure-object', 'measure', 'select-object', 'select', 'where-object', 'where', 'foreach-object',
  'foreach', '%', '?', 'sort-object', 'sort', 'format-list', 'fl', 'format-table', 'ft', 'format-wide',
  'out-string', 'out-host', 'out-null', 'compare-object', 'diff', 'compare', 'join-path', 'split-path',
  'get-process', 'gps', 'ps', 'get-service', 'get-date', 'get-command', 'gcm', 'get-member', 'gm',
  'get-help', 'help', 'man', 'get-alias', 'get-variable', 'gv', 'get-host', 'get-random', 'get-filehash',
  'convertfrom-json', 'convertto-json', 'convertfrom-csv', 'convertto-csv', 'import-csv', 'ipcsv',
  'start-sleep', 'sleep', 'exit', 'return', 'break', 'continue', 'throw', 'param', 'function', 'if',
  'elseif', 'else', 'while', 'do', 'until', 'switch', 'try', 'catch', 'finally', 'begin', 'process', 'end',
  'new-object', 'set-variable', 'sv', 'set', 'clear-host', 'cls', 'clear', 'get-error', 'test-connection',
  'ping', 'mkdir', 'md', 'new-item-directory', 'set-location', 'sl', 'cd', 'chdir', 'push-location', 'pushd',
  'pop-location', 'popd', 'start-process', 'saps', 'start', 'invoke-expression', 'iex', 'invoke-command', 'icm',
  'import-module', 'ipmo', 'get-module', 'gmo', 'set-strictmode', 'add-type', 'read-host', 'test-json',
  'select-xml', 'set-alias', 'sal', 'out-gridview', 'ogv', 'get-eventlog', 'get-wmiobject', 'get-ciminstance',
])
const PS_SWITCHES = new Set([
  'recurse', 'force', 'whatif', 'confirm', 'append', 'noclobber', 'raw', 'passthru', 'nonewline',
  'asbytestream', 'wait', 'verbose', 'debug', 'container', 'notypeinformation', 'usequotes',
  'asplaintext', 'skipcertificatecheck', 'usebasicparsing', 'allowunencryptedauthentication',
  'update', 'noheader',
])

function psParamName(word: Word): { name: string; inlineValue?: string } | null {
  if (!/^-[A-Za-z]/.test(word.text)) return null
  const colon = word.text.indexOf(':')
  if (colon !== -1) return { name: word.text.slice(1, colon).toLowerCase(), inlineValue: word.text.slice(colon + 1) }
  return { name: word.text.slice(1).toLowerCase() }
}

function psResolveParam(name: string, known: readonly string[]): string | null {
  if (known.includes(name)) return name
  const matches = known.filter(k => k.startsWith(name))
  return matches.length === 1 ? matches[0]! : null
}

function analyzePowerShell(command: string, opts: ShellWriteOptions, collector: Collector, depth: number, startCwd: string): string {
  if (depth > MAX_NESTING) return startCwd
  const { tokens, nested } = tokenizePowerShell(command)
  let cwd = startCwd
  for (const simple of splitSimple(tokens, () => true)) {
    cwd = analyzePowerShellSimple(simple, opts, collector, depth, cwd)
  }
  for (const inner of nested) analyzePowerShell(inner, opts, collector, depth + 1, cwd)
  return cwd
}

function analyzePowerShellSimple(simple: Simple, opts: ShellWriteOptions, collector: Collector, depth: number, cwd: string): string {
  const add = (word: Word | string | undefined, source: ShellWriteSource, onDirectory: 'skip' | 'tree' = 'skip'): void =>
    collector.add(word, cwd, source, onDirectory)
  for (const redirect of simple.redirects) {
    if (redirect.target && (redirect.op === '>' || redirect.op === '>>')) add(redirect.target, 'redirect')
  }
  let words = simple.words.filter(w => w.text.length > 0 || !w.literal)
  while (words.length > 0 && (words[0]!.text === '&' || words[0]!.text === '.' || words[0]!.text === '')) words = words.slice(1)
  const head = words[0]
  // No command, or an expression (`(…) -replace 'a','b'`): nothing is run.
  if (!head || head.text.startsWith('-')) return cwd
  const rawName = commandName(head)
  const name = PS_WRITER_BY_ALIAS.get(rawName) ?? rawName
  const args = words.slice(1)

  // Static .NET file writes name their path first.
  const dotnetWrite = /^\[(?:System\.)?IO\.(?:File|Directory)\]::(Write|Append|Create|Delete|Move|Copy|Replace)/i.exec(head.text)
  if (dotnetWrite) {
    const target = args[0]
    if (target && target.text !== '') add(target, 'writer')
    return cwd
  }

  if (name === 'set-location' || name === 'cd' || name === 'chdir' || name === 'sl' || name === 'push-location' || name === 'pushd') {
    const target = args.find(w => !w.text.startsWith('-'))
    if (!target) return opts.homeDir ?? cwd
    if (!target.literal) return cwd
    return resolveShellWord(target.text, cwd, opts.homeDir, 'powershell') ?? cwd
  }
  const rule = PS_WRITERS[name]
  if (rule) {
    applyPsRule(rule, args, add, cwd)
    return cwd
  }
  if (PS_READ_ONLY.has(name)) return cwd
  // External commands: the same reading as under bash (wrappers, git, the
  // writer table, the generic operands).
  return analyzeBashSimple({ words, redirects: [] }, opts, collector, depth, cwd)
}

function applyPsRule(rule: PsRule, args: Word[], add: (word: Word | string | undefined, source: ShellWriteSource, onDirectory?: 'skip' | 'tree') => void, cwd: string): void {
  const known = [...new Set([...rule.pathParams, ...(rule.valueParams ?? []), ...rule.positional.filter((p): p is string => p !== null), ...PS_COMMON_VALUE_PARAMS])]
  const byParam = new Map<string, Word[]>()
  const positional: Word[] = []
  let recurse = false
  const push = (param: string, value: Word): void => {
    const list = byParam.get(param) ?? []
    list.push(value)
    byParam.set(param, list)
  }
  // Where a list continuation (`a, b`) goes: the parameter it started under.
  let listParam: string | null = null
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!
    const param = psParamName(word)
    if (!param) {
      if (word.continues && listParam) push(listParam, word)
      else positional.push(word)
      continue
    }
    listParam = null
    if (param.name === 'recurse' || param.name === 'r' || param.name === 'rec') recurse = true
    if (PS_SWITCHES.has(param.name) || param.name.startsWith('recurse') || param.name === 'r') continue
    const resolved = psResolveParam(param.name, known)
    if (param.inlineValue !== undefined) {
      if (resolved) push(resolved, { kind: 'word', text: param.inlineValue, literal: word.literal })
      continue
    }
    const value = args[i + 1]
    if (!value || psParamName(value)) continue
    i++
    if (resolved) {
      push(resolved, value)
      listParam = resolved
    }
  }
  // Positional operands fill the rule's positions in order; a comma list
  // occupies one position with all its elements.
  const groups: Word[][] = []
  for (const word of positional) {
    if (word.continues && groups.length > 0) groups[groups.length - 1]!.push(word)
    else groups.push([word])
  }
  rule.positional.forEach((param, index) => {
    const group = groups[index]
    if (param && group && !byParam.has(param)) group.forEach(w => push(param, w))
  })
  const valuesOf = (...names: string[]): Word[] => names.flatMap(n => byParam.get(n) ?? [])
  switch (rule.kind) {
    case 'write':
      rule.pathParams.forEach(p => valuesOf(p).forEach(w => add(w, 'writer')))
      return
    case 'remove':
      valuesOf('path', 'literalpath').forEach(w => add(w, 'writer', recurse ? 'tree' : 'skip'))
      return
    case 'copy':
    case 'move': {
      const sources = valuesOf('path', 'literalpath')
      const dest = valuesOf('destination')[0]
      for (const src of sources) {
        if (rule.kind === 'move') add(src, 'writer', 'tree')
        if (dest?.literal && src.literal) {
          const destAbs = resolveShellWord(dest.text, cwd, undefined, 'powershell')
          if (destAbs) add(joinRuntimePath(destAbs, basenameRuntimePath(src.text)), 'writer')
        }
      }
      add(dest, 'writer')
      return
    }
    case 'rename': {
      const from = valuesOf('path', 'literalpath')[0]
      const to = valuesOf('newname')[0]
      add(from, 'writer', 'tree')
      if (from?.literal && to?.literal) {
        const fromAbs = resolveShellWord(from.text, cwd, undefined, 'powershell')
        if (fromAbs) add(joinRuntimePath(dirnameRuntimePath(fromAbs), to.text), 'writer')
      }
      return
    }
    case 'newitem': {
      const type = valuesOf('itemtype')[0]?.text.toLowerCase()
      if (type === 'directory' || type === 'dir') return
      const paths = valuesOf('path')
      const nameWord = valuesOf('name')[0]
      for (const p of paths) {
        if (nameWord?.literal && p.literal) {
          const dirAbs = resolveShellWord(p.text, cwd, undefined, 'powershell')
          if (dirAbs) add(joinRuntimePath(dirAbs, nameWord.text), 'writer')
        } else {
          add(p, 'writer')
        }
      }
      return
    }
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function analyzeLine(command: string, opts: ShellWriteOptions, collector: Collector, depth: number, cwd: string): void {
  if (opts.shell === 'powershell') analyzePowerShell(command, opts, collector, depth, cwd)
  else analyzeBash(command, opts, collector, depth, cwd)
}

/** The files `command` may write, resolved against `opts.cwd` (see the
 *  module contract). Never throws on malformed input. */
export function extractShellWriteCandidates(command: string, opts: ShellWriteOptions): ShellWriteCandidate[] {
  if (typeof command !== 'string' || command.trim().length === 0) return []
  const collector = new Collector(opts)
  try {
    analyzeLine(command, opts, collector, 0, opts.cwd)
  } catch {
    // A tokenizer edge case must never fail the command; what was collected
    // so far is still useful.
  }
  return collector.result()
}
