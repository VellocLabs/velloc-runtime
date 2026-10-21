/**
 * A chat session's file tools reach only its memory folder (read + write),
 * loaded skill roots and the uploads dir (read-only); every other path is
 * refused in every permission mode, and skill bodies run no shell.
 */
import { describe, expect, it } from 'vitest'
import type { RuntimeConfig, WorkingState } from '../runtime/RuntimeTypes'
import { declareTool, type ToolContract } from '../toolkit/toolContract'
import { decideToolPermission } from '../toolkit/run/toolPermissionGate'
import { getMemoryDir } from '../memory/memoryPaths'
import { confinedFileAccessDenial, uploadsDirOf } from '../permissions/chatLocalAccess'
import { expandSkillBodyShell } from '../skillLibrary/inlineShellExpansion'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'

const SANDBOX = '/home/u/.velloc/sandbox/chat'
const HOME = '/home/u'
const SKILL_DIR = '/home/u/.velloc/skills/notes-helper'
const runtimeConfig = { getEnv: () => undefined } as unknown as RuntimeConfig
const memoryDir = getMemoryDir(SANDBOX, runtimeConfig, { projectRoot: SANDBOX, homeDir: HOME })

function makeTool(name: string): ToolContract {
  return declareTool({
    name,
    argsSchema: { type: 'object' as const, properties: {} },
    description: async () => `${name} test tool`,
    call: async () => ({ data: { ok: true } }),
    readsOnly: () => ['Read', 'Glob', 'Grep'].includes(name),
  }) as unknown as ToolContract
}

function contextFor(templateType: string, mode: WorkingState['permissionRules']['mode'], tool: ToolContract) {
  const appState: WorkingState = {
    ...createEmptyAppState(),
    permissionRules: { mode, extraWorkspaceRoots: new Map() },
  }
  const context = createNoopToolUseContext({
    tools: [tool],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState,
    setAppState: () => {},
    cwd: SANDBOX,
    projectRoot: SANDBOX,
    sessionId: 'sess-chat-confined',
    commands: [{ name: 'notes-helper', baseDir: SKILL_DIR } as never],
  })
  context.readAppState = () => appState
  context.options.templateType = templateType
  context.options.homeDir = HOME
  context.options.runtimeConfig = runtimeConfig
  return context
}

async function decide(
  name: string,
  input: Record<string, unknown>,
  templateType = 'chat',
  mode: WorkingState['permissionRules']['mode'] = 'bypassPermissions',
) {
  const tool = makeTool(name)
  return decideToolPermission(tool, input, contextFor(templateType, mode, tool))
}

describe('chat session local-file confinement', () => {
  it('refuses reads and writes of the user files, even under bypassPermissions', async () => {
    for (const [name, input] of [
      ['Read', { file_path: '/home/u/projects/app/src/main.ts' }],
      ['Glob', { pattern: '**/*.ts', path: '/home/u/projects/app' }],
      ['Grep', { pattern: 'secret', path: 'C:/Users/u/Documents' }],
      ['Write', { file_path: '/home/u/projects/app/notes.md', content: 'x' }],
      ['Edit', { file_path: '/home/u/.bashrc', old_string: 'a', new_string: 'b' }],
      ['NotebookEdit', { notebook_path: '/home/u/n.ipynb', new_source: 'x' }],
    ] as const) {
      const verdict = await decide(name, input)
      expect(verdict.decision, `${name} ${JSON.stringify(input)}`).toBe('deny')
      expect(verdict.decision === 'deny' && verdict.message).toContain('Code session')
    }
  })

  it('refuses a Glob or Grep without a path, which would search the sandbox cwd', async () => {
    expect((await decide('Glob', { pattern: '**/*' })).decision).toBe('deny')
    expect((await decide('Grep', { pattern: 'x' })).decision).toBe('deny')
  })

  it('refuses a traversal out of the memory folder', async () => {
    const verdict = await decide('Write', { file_path: `${memoryDir}/../../escape.md`, content: 'x' })
    expect(verdict.decision).toBe('deny')
  })

  it('lets memory be read and written', async () => {
    expect((await decide('Write', { file_path: `${memoryDir}/user-prefers-tabs.md`, content: 'x' })).decision).toBe('allow')
    expect((await decide('Edit', { file_path: `${memoryDir}/MEMORY.md`, old_string: 'a', new_string: 'b' })).decision).toBe('allow')
    expect((await decide('Read', { file_path: `${memoryDir}/MEMORY.md` })).decision).toBe('allow')
    expect((await decide('Grep', { pattern: 'tabs', path: memoryDir })).decision).toBe('allow')
  })

  it('lets a loaded skill and an attached file be read, never written', async () => {
    const upload = `${uploadsDirOf(SANDBOX)}/sess-chat-confined/1a2b3c4d-report.csv`
    expect((await decide('Read', { file_path: `${SKILL_DIR}/references/guide.md` })).decision).toBe('allow')
    expect((await decide('Read', { file_path: upload })).decision).toBe('allow')
    expect((await decide('Write', { file_path: `${SKILL_DIR}/SKILL.md`, content: 'x' })).decision).toBe('deny')
    expect((await decide('Write', { file_path: upload, content: 'x' })).decision).toBe('deny')
  })

  it('leaves a code session untouched', async () => {
    const verdict = await decide('Read', { file_path: '/home/u/projects/app/src/main.ts' }, 'code')
    expect(verdict.decision).toBe('allow')
  })

  it('ignores tools that are not file tools', () => {
    expect(confinedFileAccessDenial('WebFetch', { url: 'https://example.com' }, { cwd: SANDBOX, skillRoots: [] })).toBeNull()
  })

  it('without a memory folder, refuses every write', () => {
    expect(
      confinedFileAccessDenial('Write', { file_path: `${SANDBOX}/a.md` }, { cwd: SANDBOX, skillRoots: [] }),
    ).not.toBeNull()
  })

  it('does not run a skill body shell snippet in a chat session', async () => {
    const tool = makeTool('Skill')
    const context = contextFor('chat', 'default', tool)
    const body = 'Status:\n!`whoami`\n'
    expect(await expandSkillBodyShell(body, context)).toBe(body)
  })
})
