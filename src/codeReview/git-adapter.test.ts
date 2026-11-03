import { describe, expect, it, vi } from 'vitest'
import { execFileSync, spawn as nodeSpawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createGitArgvRunner, remoteUrlsOf, validateGitRef, type GitStreamSpawner, type GitQuery } from './git-adapter'
import type { NativeStreamHandlers, NativeStreamChild } from '../browser/bridge/nativePrimitives'

const oid = 'a'.repeat(40)
const root = { root: 'D:/allowed/repo', gitDir: 'D:/allowed/meta', commonDir: 'D:/allowed/common' }
const exit = { exitCode: 0, timedOut: false, killed: false, durationMs: 1 }
function fake(output = oid + '\n') {
  const child: NativeStreamChild = { streamId: 'stream', write: vi.fn(async () => true), closeStdin: vi.fn(async () => true), kill: vi.fn(async () => true), detach: vi.fn() }
  const spawn = vi.fn<GitStreamSpawner>(async (_spec, handlers) => {
    handlers.onOutput?.('stdout', new TextEncoder().encode(output)); handlers.onExit?.(exit)
    return child
  })
  return { spawn, child }
}
describe('native Git object queries', () => {
  it('executes the fixed argv against a real repository without modifying it', async () => {
    const cwd = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')
    const gitDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-dir'], { cwd, encoding: 'utf8' }).trim()
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' }).trim()
    const spawn: GitStreamSpawner = async (spec, handlers) => {
      const child = nodeSpawn(spec.file, spec.args, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, shell: false, stdio: 'pipe' })
      child.stdout.on('data', bytes => handlers.onOutput?.('stdout', new Uint8Array(bytes)))
      child.stderr.on('data', bytes => handlers.onOutput?.('stderr', new Uint8Array(bytes)))
      child.on('close', code => handlers.onExit?.({ ...exit, exitCode: code ?? -1 }))
      child.on('error', () => handlers.onExit?.({ ...exit, exitCode: -1 }))
      return { streamId: 'real', async write(bytes) { child.stdin.write(bytes); return true }, async closeStdin() { child.stdin.end(); return true }, async kill() { return child.kill() }, detach() { child.stdout.removeAllListeners(); child.stderr.removeAllListeners() } }
    }
    const git = await createGitArgvRunner(spawn, { authorizeRoot: async () => ({ root: cwd, gitDir, commonDir }) })
    const resolved = await git.query({ kind: 'resolve', ref: 'HEAD' })
    expect(resolved.exitCode).toBe(0)
    const head = new TextDecoder().decode(resolved.stdout).trim()
    expect(head).toMatch(/^[a-f0-9]{40,64}$/)
    const diff = await git.query({ kind: 'diff', base: head, head })
    expect(diff.exitCode).toBe(0); expect(diff.stdout.length).toBe(0)
    const tree = await git.query({ kind: 'tree', oid: head })
    expect(tree.exitCode).toBe(0); expect(tree.stdout.length).toBeGreaterThan(0)
  })
  it('resolves with exit 0 to a commit, exit 1 for a ref that names none', async () => {
    const cwd = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')
    const gitDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-dir'], { cwd, encoding: 'utf8' }).trim()
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' }).trim()
    const spawn: GitStreamSpawner = async (spec, handlers) => {
      const child = nodeSpawn(spec.file, spec.args, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, shell: false, stdio: 'pipe' })
      child.stdout.on('data', bytes => handlers.onOutput?.('stdout', new Uint8Array(bytes)))
      child.on('close', code => handlers.onExit?.({ ...exit, exitCode: code ?? -1 }))
      return { streamId: 'real', async write() { return true }, async closeStdin() { child.stdin.end(); return true }, async kill() { return child.kill() }, detach() { child.stdout.removeAllListeners() } }
    }
    const git = await createGitArgvRunner(spawn, { authorizeRoot: async () => ({ root: cwd, gitDir, commonDir }) })
    const head = await git.query({ kind: 'resolve', ref: 'HEAD' })
    expect(head.exitCode).toBe(0)
    expect(new TextDecoder().decode(head.stdout).trim()).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim())
    expect((await git.query({ kind: 'resolve', ref: 'refs/heads/no-such-branch-for-review-test' })).exitCode).toBe(1)
  })
})
describe('restricted Git argv runner', () => {
  it('uses only native git argv with canonical authorized cwd and hardened environment', async () => {
    const { spawn } = fake()
    const authorizeRoot = vi.fn(async () => root)
    const git = await createGitArgvRunner(spawn, { authorizeRoot })
    const queries: GitQuery[] = [{ kind: 'resolve', ref: 'feature/a+b#c@d' }, { kind: 'upstream', ref: 'HEAD' }, { kind: 'default-branch' }, { kind: 'merge-base', left: oid, right: oid }, { kind: 'parents', oid }, { kind: 'empty-tree' }, { kind: 'tree', oid }, { kind: 'tracked' }, { kind: 'blob', oid }, { kind: 'diff', base: oid, head: oid, paths: ['-file;$(touch nope)'] }, { kind: 'remotes' }, { kind: 'index-entries' }, { kind: 'file-mode' }]
    for (const query of queries) await git.query(query)
    expect(authorizeRoot).toHaveBeenCalledOnce()
    for (const [spec] of spawn.mock.calls) {
      expect(spec.file).toBe('git'); expect(spec.cwd).toBe(root.root)
      expect(spec.args).toEqual(expect.arrayContaining(['--no-pager', '--literal-pathspecs', 'core.fsmonitor=false', 'core.askPass=', 'credential.helper=', 'protocol.allow=never', 'core.hooksPath=/dev/null']))
      expect(spec.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_CONFIG_COUNT: '0', GIT_CONFIG_PARAMETERS: '', GIT_INDEX_FILE: root.gitDir + '/index', GIT_DIR: root.gitDir, GIT_WORK_TREE: root.root })
    }
    expect(spawn.mock.calls[0][0].args.slice(-5)).toEqual(['rev-parse', '--verify', '--quiet', '--end-of-options', 'feature/a+b#c@d~0'])
    expect(spawn.mock.calls[1][0].args.slice(-5)).toEqual(['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD@{upstream}~0'])
    expect(spawn.mock.calls[10][0].args.slice(-5)).toEqual(['config', '--local', '-z', '--get-regexp', 'remote\\..*\\.url$'])
    expect(spawn.mock.calls[9][0].args.slice(-4)).toEqual([oid, oid, '--', '-file;$(touch nope)'])
    expect(spawn.mock.calls[9][0].args).toContain('--no-textconv')
    expect(spawn.mock.calls[9][0].args).toContain('--no-ext-diff')
    expect(spawn.mock.calls[11][0].args.slice(-4)).toEqual(['ls-files', '--stage', '-z', '--'])
    expect(spawn.mock.calls[12][0].args.slice(-4)).toEqual(['config', '--bool', '--get', 'core.filemode'])
  })
  it('keeps every fixed argv free of cmd.exe metacharacters', async () => {
    const { spawn } = fake(); const git = await createGitArgvRunner(spawn, { authorizeRoot: async () => root })
    const queries: GitQuery[] = [{ kind: 'resolve', ref: 'HEAD' }, { kind: 'resolve', ref: 'refs/heads/main' }, { kind: 'upstream', ref: 'HEAD' }, { kind: 'default-branch' }, { kind: 'merge-base', left: oid, right: oid }, { kind: 'parents', oid }, { kind: 'empty-tree' }, { kind: 'tree', oid }, { kind: 'tracked' }, { kind: 'blob', oid }, { kind: 'diff', base: oid, head: oid, paths: ['src/a.ts'] }, { kind: 'remotes' }, { kind: 'index-entries' }, { kind: 'file-mode' }]
    for (const query of queries) await git.query(query)
    for (const [spec] of spawn.mock.calls) for (const arg of spec.args) expect(arg, `${spec.args.join(' ')}`).not.toMatch(/[\^%&|<>!()"]/)
  })
  it('refuses each character cmd.exe would interpret in a ref, before spawning', async () => {
    const { spawn } = fake(); const git = await createGitArgvRunner(spawn, { authorizeRoot: async () => root })
    for (const ch of ['&', '|', '<', '>', '(', ')', '^', '%', '!', '"', ';', '$', '`', "'", ',', '=', '\u00e9', '\uff06']) {
      const ref = `feature/a${ch}b`
      expect(() => validateGitRef(ref), ref).toThrow('invalid-ref')
      await expect(git.query({ kind: 'resolve', ref })).rejects.toThrow('invalid-ref')
      await expect(git.query({ kind: 'upstream', ref })).rejects.toThrow('invalid-ref')
    }
    expect(spawn).not.toHaveBeenCalled()
    for (const ref of ['HEAD', 'main', 'refs/heads/feature/x-1.2_3', 'release/v1+build#2', 'user@host/topic']) expect(validateGitRef(ref)).toBe(ref)
  })
  it('reads remote URLs from NUL-ended records and keys only remote.<name>.url', () => {
    const output = 'remote.origin.url\nhttps://github.com/owner/repo.git\0'
      + 'branch.remote.f.url\nz\nremote.evil.url https://evil.invalid/x.git\0'
      + 'remote.a.b.url\nhttps://nested.invalid/x.git\0'
      + 'remote.up.url\ngit@gitlab.com:owner/repo.git\0'
    expect(remoteUrlsOf(output)).toEqual(['https://github.com/owner/repo.git', 'git@gitlab.com:owner/repo.git'])
    expect(remoteUrlsOf('')).toEqual([])
  })
  it('rejects options, revision operators, path traversal and non-object diff revisions', async () => {
    const { spawn } = fake(); const git = await createGitArgvRunner(spawn, { authorizeRoot: async () => root })
    for (const ref of ['-c', '--help', 'HEAD~1', 'a..b', 'HEAD:path', 'HEAD@{1}', 'x\ny', '']) expect(() => validateGitRef(ref)).toThrow()
    await expect(git.query({ kind: 'diff', base: 'main', head: oid })).rejects.toThrow('invalid-oid')
    for (const path of ['../secret', '/etc/passwd', 'C:/secret', 'a/../../b', '.git/config', 'a\\b']) await expect(git.query({ kind: 'diff', base: oid, head: oid, paths: [path] })).rejects.toThrow('invalid-path')
    expect(spawn).not.toHaveBeenCalled()
  })
  it('bounds both output streams and kills a child whose handle arrives late', async () => {
    const { child } = fake()
    const spawn: GitStreamSpawner = async (_spec, handlers) => { handlers.onOutput?.('stderr', new Uint8Array(100)); return child }
    const git = await createGitArgvRunner(spawn, { authorizeRoot: async () => root, maxOutputBytes: 10 })
    await expect(git.query({ kind: 'tracked' })).rejects.toThrow('output-limit')
    await Promise.resolve()
    expect(child.kill).toHaveBeenCalledOnce(); expect(child.detach).toHaveBeenCalledOnce()
  })
  it('propagates cancellation without spawning and while waiting for a child', async () => {
    const { child } = fake(); let handlers: NativeStreamHandlers | undefined
    const spawn = vi.fn<GitStreamSpawner>(async (_spec, events) => { handlers = events; return child })
    const git = await createGitArgvRunner(spawn, { authorizeRoot: async () => root })
    const controller = new AbortController(); controller.abort()
    await expect(git.query({ kind: 'tracked' }, controller.signal)).rejects.toThrow('cancelled'); expect(spawn).not.toHaveBeenCalled()
    const live = new AbortController(); const running = git.query({ kind: 'tracked' }, live.signal)
    await Promise.resolve(); live.abort()
    await expect(running).rejects.toThrow('cancelled')
    handlers?.onExit?.(exit)
    await Promise.resolve(); expect(child.kill).toHaveBeenCalled()
  })
  it('has a finite timeout and does not expose stderr as review content', async () => {
    vi.useFakeTimers()
    try {
      const { child } = fake(); const git = await createGitArgvRunner(async () => child, { authorizeRoot: async () => root, timeoutMs: 5 })
      const rejected = expect(git.query({ kind: 'tracked' })).rejects.toThrow('timeout')
      await vi.advanceTimersByTimeAsync(6); await rejected; expect(child.kill).toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
})
