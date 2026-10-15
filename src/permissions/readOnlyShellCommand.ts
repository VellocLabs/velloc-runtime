// Security: deny-by-default read-only shell classifier for plan mode: read-only
// only if EVERY pipe segment is a known-safe read command with safe flags and
// there is no redirection, chaining or substitution. It may false-reject;
// it must never pass a mutation.

/**
 * Single commands whose entire invocation is read-only regardless of args (we
 * still reject shell operators globally). Lowercased; covers POSIX/bash and the
 * read-only PowerShell cmdlets + aliases. EXCLUDES anything that can write or
 * execute (sed/awk/tee/xargs/cp/mv/rm/curl/wget/find/eval/python/node/…).
 */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  // POSIX / bash reads
  'ls', 'cat', 'head', 'tail', 'wc', 'echo', 'printf', 'pwd', 'which', 'type',
  'file', 'stat', 'basename', 'dirname', 'realpath', 'readlink', 'env',
  'printenv', 'date', 'whoami', 'hostname', 'uname', 'df', 'du', 'tree', 'grep',
  'egrep', 'fgrep', 'rg', 'ripgrep', 'sort', 'uniq', 'cut', 'column', 'nl',
  'tac', 'rev', 'fold', 'paste', 'comm', 'cmp', 'diff', 'tr', 'od', 'xxd',
  'hexdump', 'strings', 'base64', 'cksum', 'md5sum', 'sha1sum', 'sha256sum',
  'id', 'groups', 'ps', 'seq', 'true', 'false',
  // PowerShell read-only cmdlets + aliases
  'get-childitem', 'gci', 'dir', 'get-content', 'gc', 'get-location', 'gl',
  'get-item', 'gi', 'get-itemproperty', 'gp', 'test-path', 'resolve-path',
  'select-string', 'sls', 'get-command', 'gcm', 'get-member', 'gm',
  'measure-object', 'measure', 'select-object', 'select', 'where-object',
  'where', 'sort-object', 'format-list', 'fl', 'format-table', 'ft',
  'get-process', 'get-date', 'write-output', 'write-host', 'get-help', 'help',
  'get-alias', 'get-variable', 'out-string',
])

/** ALWAYS read-only `git <sub>` subcommands (barring `--output`, screened in
 *  isReadOnlySegment).
 *  `branch`/`tag`/`remote`/`config` are CONDITIONALLY read-only (list/get forms
 *  only) and handled separately; everything that mutates (push/pull/fetch/commit/
 *  add/checkout/reset/stash/clean/merge/rebase…) is absent entirely. */
const GIT_READ_ONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'describe', 'blame', 'ls-files',
  'ls-tree', 'cat-file', 'shortlog', 'reflog', 'whatchanged', 'version',
])

/** Read-only `gh <noun> <verb>` verbs (e.g. `gh pr view`, `gh run list`).
 *  Excludes create/merge/close/edit/delete and `gh api` (can POST). */
const GH_READ_ONLY_VERBS: ReadonlySet<string> = new Set([
  'view', 'list', 'status', 'diff',
])

/** Replace single-quoted spans with empty quotes. Single quotes are LITERAL in
 *  POSIX shells (no expansion/substitution), so their contents are safe to drop
 *  for structural analysis. */
function stripSingleQuoted(s: string): string {
  return s.replace(/'[^']*'/g, "''")
}

/** Replace single- AND double-quoted spans. Shell OPERATORS (`>`, `;`, `&`, …)
 *  are literal inside any quotes, so strip both before the operator/pipe scan.
 *  (Command SUBSTITUTION is still active inside double quotes — that check runs
 *  on the single-quote-only-stripped form, before this.) */
function stripQuoted(s: string): string {
  return s.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')
}

/**
 * True iff `rawCommand` is a read-only shell command per the conservative
 * allowlist above. Deny-by-default: a non-string, an empty command, any
 * redirection/chaining/substitution/sudo, an empty pipe segment, or any segment
 * whose command is not allowlisted → false.
 */
export function isReadOnlyShellCommand(rawCommand: unknown): boolean {
  if (typeof rawCommand !== 'string') return false
  const command = rawCommand.trim()
  if (command.length === 0) return false
  // A newline could hide a second command on the next line.
  if (/[\r\n]/.test(command)) return false
  // Command substitution `$( … )` / backticks runs arbitrary commands — and is
  // active even inside double quotes, so only single-quoted spans are dropped
  // before this check.
  if (/\$\(|`/.test(stripSingleQuoted(command))) return false
  // Operators are literal inside quotes, so strip all quoted spans first.
  let stripped = stripQuoted(command)
  // Output-discarding / fd-duplication redirects (`2>$null`, `>/dev/null`,
  // `2>&1`, `2>&-`) are harmless — strip them before the redirect reject so a
  // command that just silences/merges stderr stays read-only. The `>&` form is
  // stripped ONLY when it targets a fd (a digit or `-`): `cmd >&file` is a real
  // file redirect (writes the file), NOT an fd dup, so it must fall through to
  // the reject below. A plain file redirect (`> out.txt`) is likewise rejected.
  stripped = stripped
    .replace(/\d?>\s*(?:\$null|\/dev\/null|nul)\b/gi, ' ')
    .replace(/\d?>&[\d-]/g, ' ')
  // Any OTHER redirection is never read-only.
  if (/[<>]/.test(stripped)) return false
  if (/\bsudo\b/i.test(stripped)) return false
  // Chaining: allow `&&`, `||`, `;`, and `|` between segments — each segment is
  // validated independently below, so a chain can't smuggle a mutation in
  // (`git log && rm x` rejects on the `rm` segment). A LONE `&` is backgrounding
  // (fire-and-forget) → reject; normalize the chain operators to `;` first so a
  // remaining `&` can only be a background.
  stripped = stripped.replace(/&&/g, ';').replace(/\|\|/g, ';')
  if (/&/.test(stripped)) return false
  // Each segment must independently be a read-only command. An empty segment
  // means a dangling `;`/`|` (e.g. `ls |`, `;;`).
  const segments = stripped.split(/[;|]/)
  if (segments.some(s => s.trim().length === 0)) return false
  return segments.every(isReadOnlySegment)
}

/**
 * Git global flags that take a value, skipped to find the subcommand.
 * Security: `-c` is NOT here (it can inject a command via config), so
 * `git -c …` fails closed.
 */
const GIT_GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path',
  '--super-prefix',
])
function gitSubcommand(rest: string[]): { sub?: string; subArgs: string[] } {
  let i = 0
  while (i < rest.length) {
    const t = rest[i]!
    if (!t.startsWith('-')) break // the subcommand
    if (GIT_GLOBAL_VALUE_FLAGS.has(t)) i += 2 // flag + its value
    else i += 1 // `--git-dir=x` or a valueless global flag (--no-pager, -p, …)
  }
  return { sub: rest[i]?.toLowerCase(), subArgs: rest.slice(i + 1) }
}

/** git args that mutate refs/worktree/config — their presence blocks a
 *  conditional read-only subcommand (branch/tag/remote). */
const GIT_MUTATION_FLAGS: ReadonlySet<string> = new Set([
  '-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f',
  '--force', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description',
  '--create-reflog', '--add', '--unset', '--unset-all', '--replace-all',
])

/** True iff a conditional git subcommand (branch/tag/remote) is read-only: no
 *  mutation flag AND no bare positional (a positional names a create/rename
 *  target, e.g. `git branch foo`). Lists like `git branch --show-current`,
 *  `git branch -a`, `git remote -v` are flag-only → allowed. */
function gitListOnly(subArgs: string[]): boolean {
  return subArgs.every(a => a.startsWith('-') && !GIT_MUTATION_FLAGS.has(a))
}

function isReadOnlySegment(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/).filter(Boolean)
  // Skip leading env-var assignments (`FOO=bar cmd`).
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][\w]*=/.test(tokens[i]!)) i++
  if (i >= tokens.length) return false
  const cmd = tokens[i]!.toLowerCase()
  const rest = tokens.slice(i + 1)
  if (cmd === 'git') {
    const { sub, subArgs } = gitSubcommand(rest)
    if (sub === undefined) return false
    if (GIT_READ_ONLY_SUBCOMMANDS.has(sub)) {
      // `log`/`diff`/`show`/`whatchanged` share git's diff options, and
      // `--output=<file>` writes the whole result to a file. git accepts any
      // unambiguous prefix of a long option, so `--ou…` is refused, not just
      // the full spelling.
      return !subArgs.some(a => a.toLowerCase().startsWith('--ou'))
    }
    // Conditionally read-only — list/show forms only (no create/mutate).
    if (sub === 'branch' || sub === 'tag' || sub === 'remote') {
      return gitListOnly(subArgs)
    }
    if (sub === 'config') {
      // Read-only only with an explicit get/list flag (writes have neither).
      return subArgs.some(
        a =>
          a === '--get' ||
          a === '--get-all' ||
          a === '--get-regexp' ||
          a === '--list' ||
          a === '-l',
      )
    }
    return false
  }
  if (cmd === 'gh') {
    // `gh <noun> <verb> …` — the verb (2nd positional) must be read-only.
    const positional = rest
      .filter(t => !t.startsWith('-'))
      .map(t => t.toLowerCase())
    return positional.length >= 2 && GH_READ_ONLY_VERBS.has(positional[1]!)
  }
  return READ_ONLY_COMMANDS.has(cmd)
}
