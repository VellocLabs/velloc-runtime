import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  expandShellSnippets,
  expandSkillBodyShell,
  type PromptShellRunner,
} from '../skillLibrary/inlineShellExpansion'
import { __resetPluginTypesForTest, registerPluginType } from '../prompting/templateRegistry'
import type { ToolCallContext } from '../toolkit/toolCallContext'

function runner(
  fn: (command: string) => { stdout: string; exitCode: number },
): PromptShellRunner {
  return vi.fn(async (command: string) => fn(command))
}

describe('expandShellSnippets', () => {
  it('substitutes inline !`command` with the command stdout', async () => {
    const r = runner(() => ({ stdout: 'feature/login\n', exitCode: 0 }))
    const out = await expandShellSnippets(
      'On branch !`git branch --show-current` now.',
      r,
    )
    expect(out).toBe('On branch feature/login now.')
  })

  it('substitutes a ```! code block with the command stdout', async () => {
    const r = runner(() => ({ stdout: 'M src/app.ts', exitCode: 0 }))
    const out = await expandShellSnippets(
      'Status:\n```!\ngit status --short\n```\nEnd.',
      r,
    )
    expect(out).toBe('Status:\nM src/app.ts\nEnd.')
  })

  it('runs multiple embedded commands (concurrently) and substitutes each', async () => {
    const r = runner(command =>
      command.includes('branch')
        ? { stdout: 'main', exitCode: 0 }
        : { stdout: 'abc123', exitCode: 0 },
    )
    // Each `!` must be preceded by whitespace/start-of-line (a lookbehind).
    const out = await expandShellSnippets(
      'branch: !`git branch` head: !`git rev-parse HEAD`',
      r,
    )
    expect(out).toBe('branch: main head: abc123')
    expect(r).toHaveBeenCalledTimes(2)
  })

  it('leaves output containing $& / $1 intact (function replacer, no corruption)', async () => {
    // A bare string replacement arg would interpret $& as "the whole match".
    const r = runner(() => ({ stdout: 'cost is $5 and $& and $1', exitCode: 0 }))
    const out = await expandShellSnippets('X: !`echo`', r)
    expect(out).toBe('X: cost is $5 and $& and $1')
  })

  it('does not match ! preceded by a non-space character', async () => {
    const r = runner(() => ({ stdout: 'RAN', exitCode: 0 }))
    // `foo!`bar`` — the ! is glued to `foo`, so the lookbehind rejects it.
    const text = 'foo!`bar`'
    const out = await expandShellSnippets(text, r)
    expect(out).toBe(text)
    expect(r).not.toHaveBeenCalled()
  })

  it('returns the text unchanged and never calls the runner when there are no markers', async () => {
    const r = runner(() => ({ stdout: 'nope', exitCode: 0 }))
    const text = 'Just a normal skill body with no embedded commands.'
    expect(await expandShellSnippets(text, r)).toBe(text)
    expect(r).not.toHaveBeenCalled()
  })

  it('substitutes an [Error: …] marker when the runner throws (no abort)', async () => {
    const r: PromptShellRunner = vi.fn(async () => {
      throw new Error('BINARY_NOT_FOUND')
    })
    const out = await expandShellSnippets('ctx: !`missingcmd`', r)
    expect(out).toBe('ctx: [Error: BINARY_NOT_FOUND]')
  })

  it('reports a non-zero exit with empty stdout as an error marker', async () => {
    const r = runner(() => ({ stdout: '   ', exitCode: 3 }))
    const out = await expandShellSnippets('ctx: !`false`', r)
    expect(out).toBe('ctx: [Error: command exited 3]')
  })
})

// Safety guard for "Skill allowed in plan mode": a skill's embedded `!`cmd``
// shell runs OUTSIDE the read-only plan gate, so expandSkillBodyShell must NOT
// execute it while planning. (browser:{} makes createBashHookCommandRunner build
// a runner, so without the guard the command WOULD be attempted and the body
// would change — this test catches a regression.)
describe('expandSkillBodyShell — plan-mode shell gating', () => {
  function ctx(mode: string): ToolCallContext {
    return {
      platformCapabilities: { browser: {} },
      options: { mainLoopModel: 'm', sessionId: 's', mainLoopProviderId: 'p' },
      readAppState: () => ({ permissionRules: { mode } }),
    } as unknown as ToolCallContext
  }

  it('returns the body VERBATIM in plan mode (embedded shell not executed)', async () => {
    const body = 'On branch !`git branch --show-current` now.'
    expect(await expandSkillBodyShell(body, ctx('plan'))).toBe(body)
  })

  it('no markers → unchanged regardless of mode', async () => {
    const body = 'Plain skill body.'
    expect(await expandSkillBodyShell(body, ctx('default'))).toBe(body)
  })
})

// A session type that does not take every MCP source (an `mcp: plugin` type,
// or a `noExecution` one) runs no inline shell either: the body stays as
// written and the host shell is never asked. An `all` type still expands.
describe('expandSkillBodyShell — session-type shell gating', () => {
  afterEach(() => {
    __resetPluginTypesForTest()
  })

  function ctx(templateType: string) {
    const callTool = vi.fn(async () => ({ output: 'main', exit_code: 0 }))
    const context = {
      platformCapabilities: { browser: { callTool } },
      options: { mainLoopModel: 'm', sessionId: 's', mainLoopProviderId: 'p', templateType },
      readAppState: () => ({ permissionRules: { mode: 'default' } }),
    } as unknown as ToolCallContext
    return { context, callTool }
  }
  const body = 'On branch !`git branch --show-current` now.'

  it('an mcp: plugin type leaves the body verbatim and never reaches the shell', async () => {
    await registerPluginType('acme:x', [
      ['acme:x/template.md', '---\ntype: acme:x\nmcp: plugin\nskills: []\ntools: [read]\n---\n\n## prompt\nX\n'],
    ])
    const { context, callTool } = ctx('acme:x')
    expect(await expandSkillBodyShell(body, context)).toBe(body)
    expect(callTool).not.toHaveBeenCalled()
  })

  it('a noExecution type leaves the body verbatim and never reaches the shell', async () => {
    const { context, callTool } = ctx('safe_code')
    expect(await expandSkillBodyShell(body, context)).toBe(body)
    expect(callTool).not.toHaveBeenCalled()
  })

  it('an all type asks the shell and substitutes', async () => {
    const { context, callTool } = ctx('agent')
    const out = await expandSkillBodyShell(body, context)
    expect(callTool).toHaveBeenCalledTimes(1)
    expect(out).not.toBe(body)
  })
})
