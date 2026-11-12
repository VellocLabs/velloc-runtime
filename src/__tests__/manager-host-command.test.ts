import { describe, expect, it, vi } from 'vitest'
import { managerHostCommand } from '../browser/worker/managerHostCommand'

// Git from the runtime manager on the host Bash action: keyed to the
// session, run in the folder it names, the host's error rendered. (F-36)

function transportAnswering(answer: unknown) {
  const requests: Array<{ payload: unknown; context: unknown; route: unknown }> = []
  const transport = {
    request: vi.fn(async (req: { payload: unknown; context: unknown; route: unknown }) => {
      requests.push(req)
      return answer
    }),
  }
  return { transport, requests }
}

describe('managerHostCommand', () => {
  it('runs the command in the given folder, keyed to the session', async () => {
    const { transport, requests } = transportAnswering({ ok: true, result: '(no output)' })
    const run = managerHostCommand(
      { getTransport: () => transport as never, createRequestId: () => 'r1' },
      's1',
      'D:/repo',
    )
    expect(await run('git status')).toEqual({ ok: true, stdout: '' })
    expect(requests[0]).toMatchObject({ payload: { command: 'git status', cwd: 'D:/repo' }, context: { sessionId: 's1' } })
  })

  it("carries git's own words when the host reports a failed command", async () => {
    const { transport } = transportAnswering({
      ok: false,
      error: { code: 'bash_failed', message: 'bash_failed', data: { stdout: '', stderr: "fatal: 'x' already exists", exit_code: 128, timed_out: false } },
    })
    const run = managerHostCommand({ getTransport: () => transport as never, createRequestId: () => 'r1' }, 's1', 'D:/repo')
    const result = await run('git worktree add x b')
    expect(result.ok).toBe(false)
    expect(result.stdout).toContain("fatal: 'x' already exists")
  })

  it('answers ok: false with no host port, and never throws', async () => {
    const none = managerHostCommand({ getTransport: () => null, createRequestId: () => 'r1' }, 's1', 'D:/repo')
    expect((await none('git status')).ok).toBe(false)
    const throwing = managerHostCommand(
      { getTransport: () => ({ request: async () => { throw new Error('port closed') } }) as never, createRequestId: () => 'r1' },
      's1',
      'D:/repo',
    )
    expect(await throwing('git status')).toEqual({ ok: false, stdout: 'port closed' })
  })
})
