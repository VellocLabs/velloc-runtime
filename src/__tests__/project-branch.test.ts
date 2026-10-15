import { describe, expect, it, vi } from 'vitest'
import { readProjectBranch } from '../utils/projectBranch'

describe('readProjectBranch', () => {
  it('returns the branch via Bash with the folder as the per-call cwd', async () => {
    // The per-call `cwd` is required — the session cwd is unset, so a command
    // without it is rejected by the host before git runs.
    const callTool = vi.fn(async () => 'main\n')
    const result = await readProjectBranch(callTool, '/home/me/repo', 'sess-1')
    expect(result).toEqual({ branch: 'main', shellResponded: true })
    expect(callTool).toHaveBeenCalledWith({
      name: 'Bash',
      args: { command: 'git rev-parse --abbrev-ref HEAD', cwd: '/home/me/repo' },
      executionContext: { sessionId: 'sess-1' },
    })
  })

  it('falls back to PowerShell (same cwd) when the host has no Bash tool — the D:\\project\\Maxh bug', async () => {
    // A Windows host with git but NOT git-bash exposes the `PowerShell` tool,
    // not `Bash`. Calling `Bash` rejects; the branch must still resolve via
    // PowerShell, and the native backslash folder path rides through as the cwd.
    const callTool = vi.fn(
      async (req: {
        name: string
        args: Record<string, unknown>
        executionContext?: { sessionId?: string }
      }) => {
        if (req.name === 'Bash') throw new Error("tool 'Bash' is not available")
        return 'main\n'
      },
    )
    const result = await readProjectBranch(callTool, 'D:\\project\\Maxh', 'sess-1')
    expect(result.branch).toBe('main')
    expect(callTool).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: 'Bash' }),
    )
    expect(callTool).toHaveBeenNthCalledWith(2, {
      name: 'PowerShell',
      args: {
        command: 'git rev-parse --abbrev-ref HEAD',
        cwd: 'D:\\project\\Maxh',
      },
      executionContext: { sessionId: 'sess-1' },
    })
  })

  it('unwraps the {data, agent_meta} callTool envelope', async () => {
    const callTool = vi.fn(async () => ({
      data: 'feature/x\n',
      agent_meta: {},
    }))
    expect((await readProjectBranch(callTool, '/repo')).branch).toBe('feature/x')
  })

  it('reports shellResponded:false when no shell tool works (callTool throws)', async () => {
    // Nothing ran, so the answer is NOT "this folder has no branch" — it is "we
    // never found out". The worker retries exactly this case (a host bridge
    // still coming up at boot); see AgentRuntimeWorker.resolveProjectBranchAtInit.
    const callTool = vi.fn(async () => {
      throw new Error('bridge capability "browser" is not available')
    })
    expect(await readProjectBranch(callTool, '/repo')).toEqual({
      branch: undefined,
      shellResponded: false,
    })
  })

  it('reports shellResponded:true for a non-repo folder — a settled "no branch"', async () => {
    // git ran and said no. Retrying would just re-run it, so this result must be
    // distinguishable from the transport failure above.
    const callTool = vi.fn(
      async () =>
        'fatal: not a git repository (or any of the parent directories)',
    )
    expect(await readProjectBranch(callTool, '/repo')).toEqual({
      branch: undefined,
      shellResponded: true,
    })
  })

  it('rejects a multi-word error string instead of showing it as a branch', async () => {
    // A shell that surfaces an error as TEXT (rather than throwing) must not be
    // mistaken for a branch — real branch names never contain whitespace.
    const callTool = vi.fn(
      async () => 'invalid_args: session cwd is not set. Push a cwd via …',
    )
    expect((await readProjectBranch(callTool, '/repo')).branch).toBeUndefined()
  })

  it("reads the branch from the host's structured shell result", async () => {
    const callTool = vi.fn(async () => ({
      data: { stdout: 'feature/x\n', stderr: '', exit_code: 0, timed_out: false, truncated: false },
      agent_meta: {},
    }))
    expect(await readProjectBranch(callTool, '/repo')).toEqual({
      branch: 'feature/x',
      shellResponded: true,
    })
  })

  it('returns no branch for empty output / "(no output)" / detached HEAD', async () => {
    expect(
      (await readProjectBranch(async () => '', '/repo')).branch,
    ).toBeUndefined()
    expect(
      (await readProjectBranch(async () => '(no output)', '/repo')).branch,
    ).toBeUndefined()
    expect(
      (await readProjectBranch(async () => 'HEAD\n', '/repo')).branch,
    ).toBeUndefined()
    // Detached HEAD / "(no output)" still ran a shell — settled, not retryable.
    expect(
      (await readProjectBranch(async () => 'HEAD\n', '/repo')).shellResponded,
    ).toBe(true)
    // A blank string is indistinguishable from "nothing came back" — retryable.
    expect(
      (await readProjectBranch(async () => '', '/repo')).shellResponded,
    ).toBe(false)
  })

  it('returns undefined without a project root (does not call any shell)', async () => {
    const callTool = vi.fn(async () => 'main')
    expect((await readProjectBranch(callTool, undefined)).branch).toBeUndefined()
    expect(callTool).not.toHaveBeenCalled()
  })
})
