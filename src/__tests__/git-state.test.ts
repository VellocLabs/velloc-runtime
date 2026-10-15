/**
 * The first-turn git snapshot (F-19): the porcelain parser, the host-shell
 * reader, the collector's once-only rule, and the row the model reads.
 */
import { describe, expect, it } from 'vitest'
import { HostToolError } from '../browser/bridge/hostToolError'
import { GIT_STATE_CHANGE_LINES, GIT_STATE_COMMAND, GIT_STATE_TIMEOUT_MS, parseGitStatus, readGitState } from '../utils/gitState'
import { withinMs } from '../utils/deadline'
import { collectGitStateAttachments } from '../messages/contextAttachments'
import { renderGitStateReminder } from '../messages/renderAttachments'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { GitStateAttachment, Message } from '../runtime/RuntimeTypes'

describe('parseGitStatus', () => {
  it('reads the top folder, a tracking branch with its counts and the change lines', () => {
    const state = parseGitStatus('D:/work/p\n## main...origin/main [ahead 2, behind 1]\n M src/a.ts\n?? b.txt\n')
    expect(state).toEqual({
      repository: true,
      root: 'D:/work/p',
      branch: 'main',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      changes: [' M src/a.ts', '?? b.txt'],
      more: 0,
    })
  })

  it('reads a plain branch, a detached HEAD and a repository with no commits', () => {
    expect(parseGitStatus('## feature\n')).toMatchObject({ repository: true, branch: 'feature', changes: [] })
    const detached = parseGitStatus('## HEAD (no branch)\n')
    expect(detached).toMatchObject({ repository: true, changes: [] })
    expect((detached as { branch?: string }).branch).toBeUndefined()
    expect(parseGitStatus('## No commits yet on main\n?? x\n')).toMatchObject({ branch: 'main', changes: ['?? x'] })
  })

  it('caps the change lines and counts the rest', () => {
    const lines = Array.from({ length: GIT_STATE_CHANGE_LINES + 7 }, (_, i) => `?? f${i}`)
    const state = parseGitStatus(`## main\n${lines.join('\n')}\n`)
    expect(state).toMatchObject({ more: 7 })
    expect((state as { changes: string[] }).changes).toHaveLength(GIT_STATE_CHANGE_LINES)
  })

  it('is "not a repository" on git saying so, "unavailable" when the shell has no git, and nothing on other text', () => {
    expect(parseGitStatus('', 'fatal: not a git repository (or any of the parent directories): .git')).toEqual({
      repository: false,
    })
    expect(parseGitStatus('', 'bash: git: command not found')).toEqual({ repository: 'unavailable' })
    expect(parseGitStatus('', "git : The term 'git' is not recognized as the name of a cmdlet")).toEqual({
      repository: 'unavailable',
    })
    expect(parseGitStatus('something else')).toBeUndefined()
    expect(parseGitStatus('')).toBeUndefined()
  })
})

type Call = { name: string; args: Record<string, unknown> }
type Answer = { stdout: string; stderr?: string; exit_code?: number } | Error

/** The host's answer: a structured result for exit 0, a `HostToolError`
 *  carrying the same streams for any other exit, a plain throw for a shell
 *  that is not there. */
function shell(answers: Record<string, Answer>) {
  const calls: Call[] = []
  const callTool = async (request: { name: string; args: Record<string, unknown> }): Promise<unknown> => {
    calls.push({ name: request.name, args: request.args })
    const answer = answers[request.name]
    if (answer === undefined || answer instanceof Error) throw answer ?? new Error('unknown_tool')
    const body = { stdout: answer.stdout, stderr: answer.stderr ?? '', exit_code: answer.exit_code ?? 0, timed_out: false, truncated: false }
    if (body.exit_code !== 0) throw new HostToolError('failed', 'exit code ' + body.exit_code, body)
    return { data: body, agent_meta: {} }
  }
  return { calls, callTool }
}

describe('readGitState', () => {
  it('runs git status in the folder over the first shell that answers', async () => {
    const host = shell({ Bash: new Error('unknown_tool'), PowerShell: { stdout: '## main\n M a\n' } })
    const state = await readGitState(host.callTool, 'C:\\work\\p', 's1')
    expect(state).toMatchObject({ repository: true, branch: 'main', changes: [' M a'] })
    expect(host.calls.map(call => call.name)).toEqual(['Bash', 'PowerShell'])
    expect(host.calls[1]!.args).toEqual({ command: GIT_STATE_COMMAND, cwd: 'C:\\work\\p', timeout: GIT_STATE_TIMEOUT_MS })
    expect(GIT_STATE_COMMAND).toBe('git rev-parse --show-toplevel; git status --porcelain=v1 -b -- .')
  })

  it('answers "not a repository" when git says so (a non-zero exit is a host error with the streams), and nothing when no shell answered', async () => {
    const notRepo = shell({ Bash: { stdout: '', stderr: 'fatal: not a git repository', exit_code: 128 } })
    expect(await readGitState(notRepo.callTool, '/w')).toEqual({ repository: false })
    expect(notRepo.calls).toHaveLength(1)
    // A host error without the streams is a shell that is not there: the next is tried.
    const noBash = shell({ Bash: new HostToolError('unknown_tool', 'no', undefined), PowerShell: { stdout: '## main\n' } })
    expect(await readGitState(noBash.callTool, '/w')).toMatchObject({ repository: true, branch: 'main' })
    const silent = shell({})
    expect(await readGitState(silent.callTool, '/w')).toBeUndefined()
    expect(await readGitState(silent.callTool, undefined)).toBeUndefined()
  })
})

function rig(options: {
  projectRoot?: string
  agentId?: string
  messages?: Message[]
  gitRepository?: boolean
  answer?: Answer
  /** Entry names the folder lists when the fs is asked. */
  entries?: string[]
}) {
  let appState: Record<string, unknown> = {
    attachmentState: options.gitRepository === undefined ? {} : { gitRepository: options.gitRepository },
  }
  const host = shell(options.answer ? { Bash: options.answer } : {})
  const fsOperations = {
    readdir: async () =>
      (options.entries ?? []).map(name => ({ name, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false })),
  }
  const context = {
    options: { sessionId: 's1', projectRoot: options.projectRoot ?? '/repo', cwd: '/cwd', fsOperations },
    agentId: options.agentId,
    messages: options.messages ?? [],
    readAppState: () => appState,
    writeAppState: (update: (previous: Record<string, unknown>) => Record<string, unknown>) => {
      appState = update(appState)
    },
  } as unknown as ToolCallContext
  const hostBridge = { browser: { callTool: host.callTool } } as never
  return {
    context,
    hostBridge,
    calls: host.calls,
    recorded: () => (appState.attachmentState as { gitRepository?: boolean }).gitRepository,
  }
}

const gitRow = (): Message =>
  ({ type: 'attachment', attachment: { type: 'git_state', changes: [], more: 0 } }) as unknown as Message

describe('collectGitStateAttachments', () => {
  it('on the first turn of a repository: one row, and the fact recorded', async () => {
    const r = rig({ answer: { stdout: '/repo\n## main...origin/main\n?? new.txt\n' } })
    const rows = await collectGitStateAttachments(r.context, r.hostBridge)
    expect(rows).toEqual([
      { type: 'git_state', branch: 'main', upstream: 'origin/main', changes: ['?? new.txt'], more: 0 },
    ])
    expect(r.recorded()).toBe(true)
    expect(r.calls[0]!.args.cwd).toBe('/repo')
  })

  it('a working directory inside a bigger repository names the top folder', async () => {
    const r = rig({ projectRoot: 'D:\\work\\mono\\apps\\web\\', answer: { stdout: 'D:/work/mono\n## main\n M apps/web/a.ts\n' } })
    expect(await collectGitStateAttachments(r.context, r.hostBridge)).toEqual([
      { type: 'git_state', root: 'D:/work/mono', branch: 'main', changes: [' M apps/web/a.ts'], more: 0 },
    ])
    // The same folder spelled by git: no line.
    const same = rig({ projectRoot: 'D:\\work\\mono', answer: { stdout: 'D:/work/mono\n## main\n' } })
    expect((await collectGitStateAttachments(same.context, same.hostBridge))[0]).not.toHaveProperty('root')
  })

  it('not a repository: no row, the fact recorded as no', async () => {
    const r = rig({ answer: { stdout: '', stderr: 'fatal: not a git repository', exit_code: 128 } })
    expect(await collectGitStateAttachments(r.context, r.hostBridge)).toEqual([])
    expect(r.recorded()).toBe(false)
  })

  it('once only: a recorded fact, or a row already in the transcript, means no second read', async () => {
    const recorded = rig({ gitRepository: true, answer: { stdout: '## main\n' } })
    expect(await collectGitStateAttachments(recorded.context, recorded.hostBridge)).toEqual([])
    expect(recorded.calls).toHaveLength(0)
    // The row survived a reload that lost the recorded fact: the fact is restored from it.
    const reloaded = rig({ messages: [gitRow()], answer: { stdout: '## main\n' } })
    expect(await collectGitStateAttachments(reloaded.context, reloaded.hostBridge)).toEqual([])
    expect(reloaded.calls).toHaveLength(0)
    expect(reloaded.recorded()).toBe(true)
  })

  it('a host without git: the fact comes from a .git folder, no snapshot', async () => {
    const withDotGit = rig({ answer: { stdout: '', stderr: 'bash: git: command not found', exit_code: 127 }, entries: ['.git', 'src'] })
    expect(await collectGitStateAttachments(withDotGit.context, withDotGit.hostBridge)).toEqual([])
    expect(withDotGit.recorded()).toBe(true)
    const plain = rig({ answer: { stdout: '', stderr: 'bash: git: command not found', exit_code: 127 }, entries: ['src'] })
    expect(await collectGitStateAttachments(plain.context, plain.hostBridge)).toEqual([])
    expect(plain.recorded()).toBe(false)
  })

  it('no shell answered: nothing recorded, so a later turn reads again', async () => {
    const r = rig({ answer: new Error('unknown_tool') })
    expect(await collectGitStateAttachments(r.context, r.hostBridge)).toEqual([])
    expect(r.recorded()).toBeUndefined()
  })

  it('a sub-agent, a session with no folder, or a host without the shell: nothing', async () => {
    const sub = rig({ agentId: 'a1', answer: { stdout: '## main\n' } })
    expect(await collectGitStateAttachments(sub.context, sub.hostBridge)).toEqual([])
    expect(sub.calls).toHaveLength(0)
    const noFolder = rig({ projectRoot: '', answer: { stdout: '## main\n' } })
    ;(noFolder.context as unknown as { options: { cwd: string } }).options.cwd = ''
    expect(await collectGitStateAttachments(noFolder.context, noFolder.hostBridge)).toEqual([])
    const bare = rig({ answer: { stdout: '## main\n' } })
    expect(await collectGitStateAttachments(bare.context, undefined)).toEqual([])
  })

  it('a git that does not answer in time: the turn goes out without it, and it is not tried again', async () => {
    const calls: string[] = []
    const hostBridge = {
      browser: {
        callTool: (request: { name: string }) => {
          calls.push(request.name)
          return new Promise<never>(() => {})
        },
      },
    } as never
    const r = rig({})
    expect(await collectGitStateAttachments(r.context, hostBridge, { timeoutMs: 20 })).toEqual([])
    expect(calls).toEqual(['Bash'])
    expect(r.recorded()).toBeUndefined()
    expect(await collectGitStateAttachments(r.context, hostBridge, { timeoutMs: 20 })).toEqual([])
    expect(calls).toEqual(['Bash'])
  })

  it('withinMs: the value in time, a timeout otherwise, and a failure counts as one', async () => {
    expect(await withinMs(Promise.resolve(1), 50)).toEqual({ timedOut: false, value: 1 })
    expect(await withinMs(new Promise<never>(() => {}), 10)).toEqual({ timedOut: true })
    expect(await withinMs(Promise.reject(new Error('x')), 50)).toEqual({ timedOut: true })
  })

  it('the shared sandbox workspace is never described', async () => {
    const sandbox = rig({ projectRoot: 'C:\\Users\\me\\.velloc\\shared-workspace\\agent', answer: { stdout: '## main\n' } })
    expect(await collectGitStateAttachments(sandbox.context, sandbox.hostBridge)).toEqual([])
    expect(sandbox.calls).toHaveLength(0)
    expect(sandbox.recorded()).toBeUndefined()
  })
})

describe('renderGitStateReminder', () => {
  it('names the snapshot as one, the branch with its tracking, and the changes', () => {
    const state: GitStateAttachment = {
      type: 'git_state',
      branch: 'main',
      upstream: 'origin/main',
      ahead: 1,
      changes: [' M a.ts', '?? b'],
      more: 3,
    }
    const text = renderGitStateReminder(state)
    expect(text.startsWith('<system-reminder>\n')).toBe(true)
    expect(text).toContain('snapshot taken once; it does not update')
    expect(text).not.toContain('Repository root')
    expect(renderGitStateReminder({ ...state, root: 'D:/mono' })).toContain(
      'Repository root: D:/mono (the working directory is a folder inside it',
    )
    expect(text).toContain('Branch: main (tracking origin/main, ahead 1)')
    expect(text).toContain('Working tree: 5 changed paths')
    expect(text).toContain(' M a.ts\n?? b\n… and 3 more')
  })

  it('a detached HEAD and a clean tree read as such', () => {
    const text = renderGitStateReminder({ type: 'git_state', changes: [], more: 0 })
    expect(text).toContain('Branch: none (detached HEAD)')
    expect(text).toContain('Working tree: clean')
    expect(text).not.toContain('more')
  })
})
