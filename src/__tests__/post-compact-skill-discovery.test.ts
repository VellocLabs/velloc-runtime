import { afterEach, describe, expect, it } from 'vitest'
import type { Message, QueryTerminal } from '../runtime/RuntimeTypes'
import { SYSTEM_SUBTYPE_COMPACT_BOUNDARY } from '../runtime/VercelModelConstants'
import { runTurnLoop } from '../engine/turnInterpreter'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import { collectSkillDiscoveryAttachments } from '../messages/contextAttachments'
import { collectPostCompactSkillDiscoveryRows } from '../messages/postCompactSkillDiscovery'
import { renderAttachmentMessage } from '../messages/renderAttachments'
import { __resetInvokedSkillsStoreForTests, noteSkillUse } from '../skillLibrary/invokedSkillsStore'
import { installProcessFs, resetProcessFs } from '../utils/fs/runtimeFs'
import {
  DefaultRuntimeConfig,
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'

// A skill found relevant earlier and never invoked must still reach the model
// after a compaction cuts off the row that announced it (F-21).

const SESSION = 'post-compact-skill-discovery'

const commands = [
  { type: 'prompt', name: 'simplify', description: 'Reviews changed code for reuse and cleanups.', path: 'bundled:simplify', loadedFrom: 'bundled', source: 'bundled' },
  { type: 'prompt', name: 'translator', description: 'Translates catalog strings into every locale.', path: 'bundled:translator', loadedFrom: 'bundled', source: 'bundled' },
]

afterEach(() => {
  resetProcessFs()
  __resetInvokedSkillsStoreForTests()
})

function context(withSkillTool = true) {
  return createNoopToolUseContext({
    tools: (withSkillTool ? [{ name: 'Skill' }] : []) as never,
    commands: commands as never,
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
    cwd: '/workspace',
    sessionId: SESSION,
  })
}

function discoveredNames(rows: readonly Message[]): string[][] {
  return rows
    .map(row => (row as { attachment?: { type?: string; skills?: Array<{ name: string }> } }).attachment)
    .filter(a => a?.type === 'skill_discovery')
    .map(a => a!.skills!.map(s => s.name))
}

async function drain<T>(generator: AsyncGenerator<T, QueryTerminal, unknown>): Promise<void> {
  while (!(await generator.next()).done) { /* drain */ }
}

describe('found skills after a compaction', () => {
  it('the request after an automatic compaction names a skill found before it', async () => {
    installProcessFs({
      readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
      stat: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
    } as never)
    const ctx = context()
    expect(collectSkillDiscoveryAttachments('please simplify the changed code', ctx).map(a => a.skills.map(s => s.name)))
      .toEqual([['simplify']])

    let compacted = false
    const seen: Message[][] = []
    const deps = assembleTurnDependencies(new DefaultRuntimeConfig(), {
      autocompact: async () => {
        if (compacted) return {}
        compacted = true
        return {
          compactionResult: {
            boundaryMarker: { type: 'system', subtype: SYSTEM_SUBTYPE_COMPACT_BOUNDARY, uuid: 'boundary-1', message: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 4000 } } as Message,
            summaryMessages: [{ type: 'user', uuid: 'summary-1', isMeta: true, message: { role: 'user', content: 'summary' } } as Message],
          },
        }
      },
      callModel: async function* (params) {
        seen.push([...params.messages])
        yield { type: 'assistant', uuid: 'a-1', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } as Message
      },
    })
    await drain(runTurnLoop({
      messages: [{ type: 'user', uuid: 'u-1', message: { role: 'user', content: 'please simplify the changed code' } } as Message],
      baseInstructions: ['base'],
      userAmbient: {},
      systemAmbient: {},
      decidePermission: async () => ({ behavior: 'allow' }),
      callContext: ctx,
      turnCaller: 'test',
      deps,
      runtimeConfig: new DefaultRuntimeConfig(),
    }))

    expect(seen).toHaveLength(1)
    expect(discoveredNames(seen[0]!)).toEqual([['simplify']])
    const row = seen[0]!.find(r => discoveredNames([r]).length > 0)!
    const rendered = JSON.stringify(renderAttachmentMessage(row as never))
    expect(rendered).toContain('- simplify: Reviews changed code for reuse and cleanups.')
  })

  it('leaves out a found skill that was invoked since; its body is restored separately', () => {
    const ctx = context()
    collectSkillDiscoveryAttachments('simplify code and translate catalog strings', ctx)
    noteSkillUse(SESSION, 'translator', 'bundled:translator', 'body')
    expect(discoveredNames(collectPostCompactSkillDiscoveryRows(ctx, new DefaultRuntimeConfig()))).toEqual([['simplify']])
  })

  it('adds nothing when no skill was found, or the session has no Skill tool', () => {
    expect(collectPostCompactSkillDiscoveryRows(context(), new DefaultRuntimeConfig())).toEqual([])
    const noSkillTool = context(false)
    noSkillTool.writeAppState(prev => ({ ...prev, attachmentState: { discoveredSkillNames: ['simplify'] } }))
    expect(collectPostCompactSkillDiscoveryRows(noSkillTool, new DefaultRuntimeConfig())).toEqual([])
    expect(collectPostCompactSkillDiscoveryRows(undefined, new DefaultRuntimeConfig())).toEqual([])
  })
})
