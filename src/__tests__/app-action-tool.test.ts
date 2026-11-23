/**
 * An app session's own tools (F-40): `AppAction` runs a declared action in
 * the app's script and returns its answer; the session's tools and skills
 * are the Code type's, whatever the plugin's template lists; a plugin's hooks
 * and tools neither change nor shadow `BuildApp` and `AppAction`.
 */
import { afterEach, describe, expect, it } from 'vitest'

import type { AppSurfaceState } from '../browser/runtimeProtocol/modApps'
import { APP_ACTION_CONTEXT_MAX_BYTES } from '../browser/runtimeProtocol/modApps'
import type { AppActionOutcome } from '../mods/app/appActionBus'
import { dispatchAppActionOutcome } from '../mods/app/appActionBus'
import type { AppSessionInfo } from '../mods/app/appSession'
import { appPromptBlock, createAppSurfaceHost } from '../mods/app/appSurfaceHost'
import { APP_ACTION_TOOL_NAME, BUILD_APP_TOOL_NAME, isAppBuiltinTool } from '../mods/app/appToolNames'
import { buildModTool, modToolSpecOf } from '../mods/modRegisteredTools'
import {
  __resetPluginTypesForTest,
  APP_SESSION_TOOL_TYPE,
  appSessionTemplate,
  applyTemplateToolAllowlist,
  getTemplate,
  registerPluginType,
  sessionToolConfig,
  templateAllowsInlineShell,
  templateMcpScope,
} from '../prompting/templateRegistry'

const FOLDER = 'C:/home/.velloc/shared-workspace/app-pay-board'
const ENTRY = 'surface("overview")\nroot = Text("Payments")'

const app = (localActions?: string[]): AppSessionInfo => ({
  appId: 'pay-board',
  plugin: 'pay',
  folder: FOLDER,
  decl: { seed: './app', seedVersion: 1, entry: 'app.a2ui', ...(localActions ? { localActions } : {}) },
  seed: { version: 1, written: [], conflicts: [] },
})

function rig(localActions: string[] | undefined, answer: (action: string) => Promise<AppActionOutcome> | AppActionOutcome) {
  const offered: unknown[][] = []
  const pressed: unknown[][] = []
  const published: Array<AppSurfaceState | null> = []
  const host = createAppSurfaceHost({
    fs: {
      stat: async (path: string) => {
        if (!path.split('\\').join('/').endsWith('/app.a2ui')) throw new Error(`ENOENT ${path}`)
        return { isFile: () => true, isDirectory: () => false, size: ENTRY.length, mtimeMs: 1000 } as never
      },
      readFileBytes: async () => new TextEncoder().encode(ENTRY),
    },
    app: app(localActions),
    sessionId: 's1',
    compile: async () => ({ ok: true as const, surfaceIds: ['overview'] }),
    publish: (_id, state) => published.push(state),
    registerBuild: () => () => true,
    registerActor: () => () => true,
    registerReseeder: () => () => true,
    registerRefresher: () => () => true,
    dispatchAction: async (...args) => {
      pressed.push(args)
      return true
    },
    dispatchActionOutcome: async (...args) => {
      offered.push(args)
      return answer(args[1])
    },
  })
  const call = (input: unknown) =>
    host.actionTool!.call(input as never, {} as never, (async () => ({})) as never, {} as never) as Promise<{ data: string; isError?: boolean }>
  return { host, call, offered, pressed, published }
}

afterEach(() => {
  __resetPluginTypesForTest()
})

describe('AppAction', () => {
  it('offers a declared action with its context to the script and returns what the script answered', async () => {
    const { host, call, offered, pressed, published } = rig(['apply_file', 'discard_file'], () => ({ status: 'handled', result: { routes: 2 } }))
    await host.start()
    const before = published.length
    const result = await call({ action: 'apply_file', context: { path: 'config.json' } })
    expect(result.isError).toBeUndefined()
    expect(result.data).toContain('handled "apply_file"')
    expect(result.data).toContain('{"routes":2}')
    expect(offered).toEqual([['pay-board', 'apply_file', { path: 'config.json' }, 's1']])
    expect(pressed).toEqual([])
    // The board is refreshing while the script has the action, as for a press.
    expect(published.slice(before).map(state => state?.refreshing)).toEqual([true, false])
  })

  it('a handled action with no result says so; no context is none', async () => {
    const { call, offered } = rig(['save'], () => ({ status: 'handled' }))
    expect(await call({ action: 'save' })).toEqual({ data: 'The app\'s script handled "save".' })
    expect(offered).toEqual([['pay-board', 'save', undefined, 's1']])
  })

  it('refuses an undeclared name with the declared ones, without offering it', async () => {
    const { call, offered } = rig(['apply_file', 'discard_file'], () => ({ status: 'handled' }))
    const result = await call({ action: 'delete_everything' })
    expect(result.isError).toBe(true)
    expect(result.data).toBe('"delete_everything" is not an action of this app. Its actions: `apply_file`, `discard_file`.')
    expect((await call({})).isError).toBe(true)
    expect(offered).toEqual([])
  })

  it('an action the script declines, does not finish in time or cannot take is an error, and nothing else is tried', async () => {
    for (const [status, text] of [
      ['declined', /did not handle "save"/],
      ['timeout', /did not finish "save" in time/],
      ['unavailable', /is not running or answers no action/],
    ] as const) {
      const { call, offered, pressed } = rig(['save'], () => ({ status }))
      const result = await call({ action: 'save' })
      expect(result.isError, status).toBe(true)
      expect(result.data).toMatch(text)
      expect(offered).toHaveLength(1)
      expect(pressed, 'the path of a press, which falls back to the model, is not taken').toEqual([])
    }
    const thrown = rig(['save'], () => Promise.reject(new Error('the worker is gone')))
    expect(await thrown.call({ action: 'save' })).toEqual({ data: '"save" failed: the worker is gone', isError: true })
  })

  it('refuses a context that is not an object or is over the limit', async () => {
    const { call, offered } = rig(['save'], () => ({ status: 'handled' }))
    expect((await call({ action: 'save', context: [1] })).data).toBe('context must be an object.')
    expect((await call({ action: 'save', context: { text: 'x'.repeat(APP_ACTION_CONTEXT_MAX_BYTES) } })).data).toMatch(/over the \d+-byte limit/)
    expect(offered).toEqual([])
  })

  it('a missing or unserializable context is an error result, not a thrown call', async () => {
    const { call, offered } = rig(['save'], () => ({ status: 'handled' }))
    expect((await call(undefined)).data).toMatch(/is not an action of this app/)
    expect((await call({ action: 'save', context: { big: 1n } })).data).toBe('context is not JSON-serializable.')
    expect(offered).toEqual([])
  })

  it('cuts a multibyte script answer at the byte limit, on a code-point boundary', async () => {
    for (const answer of ['中'.repeat(APP_ACTION_CONTEXT_MAX_BYTES / 3), '😀'.repeat(APP_ACTION_CONTEXT_MAX_BYTES / 4)]) {
      const { call } = rig(['save'], () => ({ status: 'handled', result: answer }))
      const result = await call({ action: 'save' })
      expect(result.data.endsWith('… (cut)')).toBe(true)
      const text = result.data.slice(result.data.indexOf('answered:') + 'answered:'.length + 1, -'… (cut)'.length - 1)
      expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(APP_ACTION_CONTEXT_MAX_BYTES)
      expect([...text].every(character => character.codePointAt(0)! > 0xFFFF || character.length === 1)).toBe(true)
    }
  })

  it('a closed session offers nothing; with no dispatch seated the script is unavailable', async () => {
    const { host, call, offered } = rig(['save'], () => ({ status: 'handled' }))
    host.dispose()
    expect((await call({ action: 'save' })).isError).toBe(true)
    expect(offered).toEqual([])
    expect(await dispatchAppActionOutcome('pay-board', 'save', null, 's1')).toEqual({ status: 'unavailable' })
  })

  it('is listed beside BuildApp with the declared names in its schema, text and the app block; an app with no action has BuildApp alone', async () => {
    const { host } = rig(['apply_file', 'discard_file'], () => ({ status: 'handled' }))
    expect(host.tools.map(tool => tool.name)).toEqual([BUILD_APP_TOOL_NAME, APP_ACTION_TOOL_NAME])
    const schema = host.actionTool!.argsSchema as unknown as { properties: { action: { enum: string[] } }; required: string[] }
    expect(schema.properties.action.enum).toEqual(['apply_file', 'discard_file'])
    expect(schema.required).toEqual(['action'])
    expect(await (host.actionTool!.description as () => Promise<string>)()).toContain('`apply_file`, `discard_file`')
    expect(host.promptBlock).toMatch(/Call AppAction to run one yourself/)
    expect(host.promptBlock).toContain('`apply_file`, `discard_file`')
    expect(appPromptBlock({ ...app(['save']), decl: { ...app(['save']).decl, catalog: 'studio' } })).toContain('Call AppAction')

    const bare = rig(undefined, () => ({ status: 'handled' }))
    expect(bare.host.tools.map(tool => tool.name)).toEqual([BUILD_APP_TOOL_NAME])
    expect(bare.host.actionTool).toBeUndefined()
    expect(bare.host.promptBlock).not.toContain('AppAction')
  })
})

describe("an app session's tools and skills are the Code type's", () => {
  const TEMPLATE = ['---', 'type: pay:board', 'description: The pay board.', 'tools: [read]', 'skills: []', 'mcp: plugin', '---', '', '## prompt', 'You run the pay board.', ''].join('\n')
  const NAMES = ['Read', 'Bash', 'Edit', 'Write', 'Grep', 'Glob', 'Skill', 'Agent', 'WebFetch', 'TodoWrite'].map(name => ({ name }))

  it('the template of an app session keeps the plugin prompt and MCP boundary, and takes the Code config otherwise', async () => {
    await registerPluginType('pay:board', [['pay:board/template.md', TEMPLATE]])
    const own = getTemplate('pay:board')!
    const code = getTemplate(APP_SESSION_TOOL_TYPE)!
    expect(own.config.tools).not.toEqual(code.config.tools)
    const session = appSessionTemplate(own)!
    expect(session.prompt).toEqual(own.prompt)
    expect(session.config).toEqual({
      ...code.config,
      mcp: 'plugin',
      noExecution: false,
      type: 'pay:board',
      description: 'The pay board.',
      model: own.config.model,
    })
    expect(session.config.skills).toEqual(code.config.skills)
    expect(session.config.tools).toEqual(code.config.tools)
    // The same tools pass as in a Code session, the shell among them; the plugin's own list would keep fewer.
    const kept = applyTemplateToolAllowlist(NAMES, session.config, () => false).map(tool => tool.name)
    expect(kept).toEqual(applyTemplateToolAllowlist(NAMES, code.config, () => false).map(tool => tool.name))
    expect(kept).toContain('Bash')
    expect(applyTemplateToolAllowlist(NAMES, own.config, () => false).map(tool => tool.name)).not.toContain('Bash')
  })

  it("a session that names a tool type reads that type's tools and its own MCP scope", async () => {
    await registerPluginType('pay:board', [['pay:board/template.md', TEMPLATE]])
    const code = getTemplate(APP_SESSION_TOOL_TYPE)!.config
    const appSession = sessionToolConfig({ templateType: 'pay:board', toolTemplateType: APP_SESSION_TOOL_TYPE })!
    expect(appSession.tools).toBe(code.tools)
    expect(appSession.skills).toBe(code.skills)
    expect(templateMcpScope(appSession)).toBe('plugin')
    expect(sessionToolConfig({ templateType: 'pay:board' })).toBe(getTemplate('pay:board')!.config)
    expect(sessionToolConfig({})).toBeUndefined()
    expect(templateAllowsInlineShell(sessionToolConfig({ templateType: 'pay:board' }))).toBe(false)
    expect(templateAllowsInlineShell(appSession)).toBe(false)
  })

  it("an app session whose plugin template declares no MCP scope takes the Code tools and the every-source scope", async () => {
    const open = ['---', 'type: pay:board', 'description: The pay board, open.', 'tools: [read]', '---', '', '## prompt', 'You run the pay board.', ''].join('\n')
    await registerPluginType('pay:board', [['pay:board/template.md', open]])
    const session = appSessionTemplate(getTemplate('pay:board'))!
    expect(session.config.mcp).toBeUndefined()
    expect(templateMcpScope(session.config)).toBe('all')
    expect(templateAllowsInlineShell(sessionToolConfig({ templateType: 'pay:board', toolTemplateType: APP_SESSION_TOOL_TYPE }))).toBe(true)
  })
})

describe('a plugin adds tools and never changes the app tools', () => {
  it("a plugin's tool named BuildApp or AppAction is listed under the plugin's own name and shadows neither", () => {
    for (const name of [BUILD_APP_TOOL_NAME, APP_ACTION_TOOL_NAME]) {
      const tool = buildModTool('pay', modToolSpecOf({ name, description: 'mine' }))
      expect(tool.name).toBe(`mcp__pay__${name}`)
      expect(isAppBuiltinTool(tool.name)).toBe(false)
      expect(isAppBuiltinTool(name)).toBe(true)
    }
  })
})
