/**
 * A hosted (C++) tool answers `isReadOnly(input)` for itself (F-25 debt 10).
 * No C++ declaration carries `readOnly`, so before this every hosted tool said
 * false: a mod's `tool.call` result never had `isReadOnly` for Read or Grep,
 * and the extract-memories agent refused every Bash command as "not
 * read-only". The REAL hosted tool objects, built from manifest rows.
 */
import { describe, expect, it } from 'vitest'
import { buildHostTools } from '../toolkit/builtin/host/hostTools'
import type { HostedToolDefinition } from '../browser/bridge/browserBridgeProtocol'
import { memoryWriterPermissionGate } from '../memory/extract/extractionRunner'
import { evaluateRuleGate } from '../permissions/ruleEngine'
import { isToolAllowedInPlanMode } from '../permissions/planMode'

function hosted(name: string, readOnly?: boolean) {
  const [tool] = buildHostTools([
    {
      name,
      description: 'd',
      parameters: { type: 'object', properties: {} },
      ...(readOnly !== undefined ? { readOnly } : {}),
    } as unknown as HostedToolDefinition,
  ])
  return tool!
}

describe("a hosted tool's isReadOnly", () => {
  it('file reads, searches and the browser observation tools are read-only', () => {
    for (const name of ['Read', 'Glob', 'Grep', 'BrowserReadPage', 'BrowserScreenshot', 'BrowserFindText']) {
      expect(hosted(name).readsOnly({} as never), name).toBe(true)
    }
  })

  it('writes and browser actions are not', () => {
    for (const name of ['Write', 'Edit', 'BrowserClick', 'BrowserNavigate', 'BrowserEvaluate']) {
      expect(hosted(name).readsOnly({} as never), name).toBe(false)
    }
  })

  it('Bash answers per command', () => {
    const bash = hosted('Bash')
    expect(bash.readsOnly({ command: 'git status' } as never)).toBe(true)
    expect(bash.readsOnly({ command: 'ls -la src' } as never)).toBe(true)
    expect(bash.readsOnly({ command: 'rm -rf build' } as never)).toBe(false)
    expect(bash.readsOnly({ command: 'echo hi > out.txt' } as never)).toBe(false)
    expect(bash.readsOnly({} as never)).toBe(false)
  })

  it("the manifest's own readOnly flag still counts", () => {
    expect(hosted('SomeNewHostTool', true).readsOnly({} as never)).toBe(true)
    expect(hosted('SomeNewHostTool').readsOnly({} as never)).toBe(false)
  })
})

describe('what reads it', () => {
  it('the extract-memories agent may run a read-only Bash command, and only that', async () => {
    const gate = memoryWriterPermissionGate('/test/cwd/.velloc/memory/')
    const bash = hosted('Bash')
    const ls = (await gate(bash, { command: 'ls /test/cwd' })) as { behavior: string }
    const rm = (await gate(bash, { command: 'rm -rf /test/cwd' })) as { behavior: string }
    expect(ls.behavior).toBe('allow')
    expect(rm.behavior).toBe('deny')
  })

  it('acceptEdits auto-allows a read-only Bash command, not a mutating one', () => {
    const bash = hosted('Bash')
    const ctx = { mode: 'acceptEdits' } as never
    expect(evaluateRuleGate(bash, { command: 'git log' }, ctx).behavior).toBe('allow')
    expect(evaluateRuleGate(bash, { command: 'git push' }, ctx).behavior).toBe('passthrough')
  })

  it('the plan-mode gate is unchanged: reads and read-only commands in, the rest out', () => {
    expect(isToolAllowedInPlanMode(hosted('Grep'), {})).toBe(true)
    expect(isToolAllowedInPlanMode(hosted('Bash'), { command: 'cat a.txt' })).toBe(true)
    expect(isToolAllowedInPlanMode(hosted('Bash'), { command: 'rm a.txt' })).toBe(false)
    expect(isToolAllowedInPlanMode(hosted('Write'), { file_path: '/x' })).toBe(false)
  })
})
