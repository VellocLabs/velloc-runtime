import type { NativeStreamChild, NativeStreamHandlers } from '../browser/bridge/nativePrimitives'

export type GitStreamSpawner = (
  spec: { file: string; args: string[]; cwd: string; env: Record<string, string> },
  handlers: NativeStreamHandlers,
) => Promise<NativeStreamChild>

/** Host-resolved real paths, authorized before construction; gitDir may differ in a worktree. */
export interface AuthorizedGitRoot {
  root: string
  gitDir: string
  commonDir: string
}
export interface GitRunnerOptions {
  authorizeRoot: () => Promise<AuthorizedGitRoot>
  maxOutputBytes?: number
  timeoutMs?: number
}
export type GitQuery =
  | { kind: 'resolve'; ref: string }
  | { kind: 'upstream'; ref: string }
  | { kind: 'default-branch' }
  | { kind: 'merge-base'; left: string; right: string }
  | { kind: 'parents'; oid: string }
  | { kind: 'empty-tree' }
  | { kind: 'tree'; oid: string }
  | { kind: 'tracked' }
  | { kind: 'index-entries' }
  | { kind: 'file-mode' }
  | { kind: 'blob'; oid: string }
  | { kind: 'diff'; base: string; head: string; paths?: string[] }
  | { kind: 'remotes' }
export interface GitResult { stdout: Uint8Array; exitCode: number }
export interface ReviewGitRunner {
  readonly root: string
  query(query: GitQuery, signal?: AbortSignal): Promise<GitResult>
}
export class GitAdapterError extends Error {
  constructor(readonly code: 'invalid-ref' | 'invalid-oid' | 'invalid-path' | 'invalid-root' | 'output-limit' | 'cancelled' | 'timeout' | 'spawn-failed' | 'query-failed') { super(code) }
}
export function validateGitOid(oid: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) throw new GitAdapterError('invalid-oid')
  return oid
}
// Security: an allow-list, not git's own ref grammar. On Windows the host may
// run a `git.bat` wrapper through cmd.exe, where `& | < > ( ) ^ % ! "` would
// split or run commands; ASCII only, since a code-page conversion can map
// other characters onto those. A name may end in `~` / `~<n>` ancestry steps.
const REF_CHARS = /^[A-Za-z0-9._/+#@-]+$/
const ANCESTRY = /^(?:~[0-9]*)*$/
export function isGitRefSyntax(ref: string): boolean {
  const tilde = ref.indexOf('~')
  const name = tilde < 0 ? ref : ref.slice(0, tilde)
  return ref.length <= 1024 && REF_CHARS.test(name) && ANCESTRY.test(ref.slice(name.length)) && !name.startsWith('-') && !name.includes('..') && !name.includes('@{') && !name.endsWith('.') && !name.endsWith('/') && !name.includes('//')
}
export function validateGitRef(ref: string): string {
  if (!isGitRefSyntax(ref)) throw new GitAdapterError('invalid-ref')
  return ref
}
export function validateReviewPath(path: string): string {
  if (!path || path.length > 4096 || /[\x00-\x1f\x7f\\]/.test(path) || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').some(p => !p || p === '..' || p === '.' || p.toLowerCase() === '.git')) throw new GitAdapterError('invalid-path')
  return path
}
const config = [
  'core.fsmonitor=false', 'core.hooksPath=/dev/null', 'core.pager=', 'core.askPass=',
  'credential.helper=', 'credential.interactive=false', 'diff.external=',
  'diff.trustExitCode=false', 'diff.ignoreSubmodules=all', 'submodule.recurse=false',
  'core.quotePath=true', 'color.ui=false', 'protocol.allow=never', 'core.sshCommand=false',
  'fetch.recurseSubmodules=false', 'maintenance.auto=false', 'gc.auto=0',
]
const prefix = ['--no-pager', '--no-optional-locks', '--no-replace-objects', '--literal-pathspecs', ...config.flatMap(c => ['-c', c])]
function argv(q: GitQuery): string[] {
  switch (q.kind) {
    // Peeled with `~0`, not `^{commit}`: a batch-file git wrapper on PATH runs
    // through cmd.exe, which strips the caret. Exit 1 = no such commit.
    case 'resolve': return ['rev-parse', '--verify', '--quiet', '--end-of-options', `${validateGitRef(q.ref)}~0`]
    case 'upstream': return ['rev-parse', '--verify', '--quiet', '--end-of-options', `${validateGitRef(q.ref)}@{upstream}~0`]
    case 'default-branch': return ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']
    case 'merge-base': return ['merge-base', '--all', validateGitOid(q.left), validateGitOid(q.right)]
    case 'parents': return ['rev-list', '--parents', '-n', '1', validateGitOid(q.oid), '--']
    case 'empty-tree': return ['hash-object', '-t', 'tree', '--stdin']
    case 'tree': return ['ls-tree', '-r', '-z', '--full-tree', validateGitOid(q.oid)]
    case 'tracked': return ['ls-files', '--cached', '-z', '--']
    case 'index-entries': return ['ls-files', '--stage', '-z', '--']
    case 'file-mode': return ['config', '--bool', '--get', 'core.filemode']
    case 'blob': return ['cat-file', 'blob', validateGitOid(q.oid)]
    case 'diff': return ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', validateGitOid(q.base), validateGitOid(q.head), '--', ...(q.paths ?? []).map(validateReviewPath)]
    case 'remotes': return ['config', '--local', '-z', '--get-regexp', 'remote\\..*\\.url$']
  }
}
/** The URLs of `remote.<name>.url` keys in the `remotes` query's output:
 *  NUL-ended records, key and value split at the first newline. The query
 *  carries no `^` anchor, so the key is matched here. */
export function remoteUrlsOf(output: string): string[] {
  const urls: string[] = []
  for (const record of output.split('\0')) {
    const split = record.indexOf('\n')
    if (split < 0) continue
    if (/^remote\.[^.\s]+\.url$/.test(record.slice(0, split))) urls.push(record.slice(split + 1))
  }
  return urls
}
/** A repository name from the `remotes` query's output: the last path segment of `origin`'s URL, else of the first
 *  remote's, without `.git`. Undefined when no remote yields a plain name. */
export function repositoryNameOf(output: string): string | undefined {
  const remotes: Array<[string, string]> = []
  for (const record of output.split('\0')) {
    const split = record.indexOf('\n')
    const key = split < 0 ? null : /^remote\.([^.\s]+)\.url$/.exec(record.slice(0, split))
    if (key) remotes.push([key[1], record.slice(split + 1)])
  }
  const url = (remotes.find(([name]) => name === 'origin') ?? remotes[0])?.[1]
  const name = url?.trim().replace(/[\\/]+$/, '').split(/[\\/:]/).at(-1)?.replace(/\.git$/i, '')
  return name && /^[A-Za-z0-9_.-]{1,100}$/.test(name) && name !== '.' && name !== '..' ? name : undefined
}
function absolute(path: string): boolean { return /^(?:[A-Za-z]:[\\/]|\/)/.test(path) && !/[\x00\r\n]/.test(path) && !path.split(/[\\/]/).includes('..') }

/** Security: only fixed object/index queries; working-tree conversion and arbitrary commands are unavailable. */
export async function createGitArgvRunner(spawn: GitStreamSpawner, options: GitRunnerOptions): Promise<ReviewGitRunner> {
  const authorized = await options.authorizeRoot()
  if (![authorized.root, authorized.gitDir, authorized.commonDir].every(absolute)) throw new GitAdapterError('invalid-root')
  const { root, gitDir, commonDir } = authorized
  const maxBytes = options.maxOutputBytes ?? 8 * 1024 * 1024
  const timeout = options.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeout) || timeout < 1) throw new GitAdapterError('invalid-root')
  const env = {
    GIT_DIR: gitDir, GIT_COMMON_DIR: commonDir, GIT_WORK_TREE: root,
    GIT_INDEX_FILE: `${gitDir}/index`, GIT_OBJECT_DIRECTORY: `${commonDir}/objects`,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '', GIT_CONFIG_COUNT: '0', GIT_CONFIG_PARAMETERS: '',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1', GIT_EXTERNAL_DIFF: '', GIT_DIFF_OPTS: '', GIT_PAGER: '', PAGER: '',
    GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never',
    GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0',
    GIT_ALLOW_PROTOCOL: '', GIT_SSH_COMMAND: 'false', LC_ALL: 'C',
  }
  return {
    root,
    async query(query, signal) {
      const args = [...prefix, ...argv(query)]
      if (signal?.aborted) throw new GitAdapterError('cancelled')
      return new Promise<GitResult>((resolve, reject) => {
        let child: NativeStreamChild | undefined
        let settled = false
        let stop = false
        let bytes = 0
        const chunks: Uint8Array[] = []
        const terminate = () => { if (child) { void child.kill().catch(() => {}); child.detach() } }
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
        const fail = (code: GitAdapterError['code']) => {
          if (settled) return
          settled = true; stop = true; cleanup(); terminate(); reject(new GitAdapterError(code))
        }
        const abort = () => fail('cancelled')
        const timer = setTimeout(() => fail('timeout'), timeout)
        signal?.addEventListener('abort', abort, { once: true })
        const handlers: NativeStreamHandlers = {
          onOutput(stream, data) {
            if (settled) return
            bytes += data.byteLength
            if (bytes > maxBytes) { fail('output-limit'); return }
            if (stream === 'stdout') chunks.push(data.slice())
          },
          onExit(exit) {
            if (settled) return
            if (exit.timedOut || exit.killed || exit.exitCode < 0) { fail(exit.timedOut ? 'timeout' : 'query-failed'); return }
            settled = true; cleanup()
            const stdout = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0))
            let offset = 0
            for (const chunk of chunks) { stdout.set(chunk, offset); offset += chunk.length }
            resolve({ stdout, exitCode: exit.exitCode })
          },
        }
        Promise.resolve().then(() => {
          if (settled) return
          return spawn({ file: 'git', args, cwd: root, env: { ...env } }, handlers)
        }).then(handle => {
          if (!handle) return
          child = handle
          if (stop) terminate()
          else if (!settled) void child.closeStdin().catch(() => fail('spawn-failed'))
        }, () => fail('spawn-failed'))
      })
    },
  }
}

export async function gitText(git: ReviewGitRunner, query: GitQuery, signal?: AbortSignal): Promise<string> {
  const result = await git.query(query, signal)
  if (result.exitCode !== 0) throw new GitAdapterError('query-failed')
  return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout)
}
