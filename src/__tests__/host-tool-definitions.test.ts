/**
 * The runtime's host tool definitions (toolkit/builtin/host): each names a host action, names are unique, catalog
 * order holds; a family the host does not advertise offers no tool, a shell tool only for a reported shell; the
 * browser skill carries exactly the browser-bound tools; with a sibling C++ checkout every `*.tool.json` and the
 * skill prose are compared verbatim (the text is model-facing).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BROWSER_HOSTED_SKILL,
  HOST_TOOL_DEFINITIONS,
  hostRouteFor,
  hostToolArgsError,
  hostedSkillsForHost,
  hostedToolsForHost,
  type HostToolDefinition,
} from '../toolkit/builtin/host'

function findDeclarationsDir(): string | null {
  let dir = join(__dirname, '..', '..')
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(
      dir, 'src', 'custom_browser', 'browser', 'nexus', 'tools', 'declarations',
    )
    if (existsSync(candidate)) return candidate
    dir = join(dir, '..')
  }
  return null
}

type RawInput = {
  name: string
  type: string
  required?: boolean
  description?: string
  internal?: boolean
  wire_name?: string
}
type RawTool = {
  wire_name: string
  description: string
  inputs: RawInput[]
  skill?: string
  concurrencySafe?: boolean
  parametersStrict?: unknown
  providers?: { anthropic?: { input_examples?: unknown[] } }
}

const TYPE_STRING: Record<string, string> = {
  string: 'string', integer: 'integer', number: 'number', boolean: 'boolean',
  'array<string>': 'array', 'array<integer>': 'array', 'array<number>': 'array',
  'array<object>': 'array', object: 'object',
}
const ITEMS: Record<string, string> = {
  'array<string>': 'string', 'array<integer>': 'integer', 'array<number>': 'number',
  'array<object>': 'object',
}

const REFLECTION_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['evaluation_previous_goal', "Required one-sentence judgement of whether the previous turn's `next_goal` was achieved, partially achieved, or failed, citing concrete evidence from the latest observation (e.g. \"Login form submitted; landing page now shows the user's name\"). On the first turn, state that there is no prior goal yet."],
  ['memory', "Required running scratchpad of facts and decisions worth carrying forward across turns (URLs visited, search terms tried, IDs found, dead ends ruled out, sub-results collected). Append to and prune what you wrote last turn; don't re-derive it from scratch."],
  ['next_goal', "Required single concrete intent this call is meant to accomplish, phrased so the next turn's `evaluation_previous_goal` can check it. One sentence, action-shaped (e.g. \"Open the first organic result and read the article body\")."],
]

/** The host catalog's serialization of one declaration (`BuildHostedToolDefinitionDict`, after the browser-tool reflection fields are prepended). */
function serializeLikeTheHost(raw: RawTool, family: string): Omit<HostToolDefinition, 'host'> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  const declared = new Set(raw.inputs.map(i => i.name))
  const inputs: RawInput[] = family === 'browser_tool'
    ? [
        ...REFLECTION_FIELDS.filter(([name]) => !declared.has(name)).map(
          ([name, description]) => ({ name, type: 'string', required: true, description }),
        ),
        ...raw.inputs,
      ]
    : raw.inputs
  for (const input of inputs) {
    if (input.internal) continue
    const key = input.wire_name ?? input.name
    const property: Record<string, unknown> = { type: TYPE_STRING[input.type] }
    if (input.description) property.description = input.description
    if (ITEMS[input.type]) property.items = { type: ITEMS[input.type] }
    properties[key] = property
    if (input.required) required.push(key)
  }
  const parameters: HostToolDefinition['parameters'] = { type: 'object', properties }
  if (required.length > 0) parameters.required = required
  const out: Omit<HostToolDefinition, 'host'> = {
    type: 'function',
    name: raw.wire_name,
    description: raw.description,
    parameters,
    concurrencySafe: raw.concurrencySafe === true,
  }
  if (raw.skill) out.skill = raw.skill
  if (raw.parametersStrict !== undefined) {
    out.parametersStrict = raw.parametersStrict as HostToolDefinition['parameters']
  }
  const examples = raw.providers?.anthropic?.input_examples
  if (examples && examples.length > 0) {
    out.inputExamples = examples as Array<Record<string, unknown>>
  }
  return out
}

describe('host tool definitions', () => {
  it('every tool names its host action, names are unique, order is the catalog order', () => {
    const names = HOST_TOOL_DEFINITIONS.map(tool => tool.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names.length).toBe(30)
    // The host catalog's order: by declaration file name across families.
    expect(names).toEqual([
      'BrowserActivateTab', 'BrowserBack', 'Bash', 'BrowserClick',
      'BrowserCloseTab', 'Done', 'BrowserDownload', 'BrowserDragAndDrop',
      'Edit', 'BrowserEvaluate', 'BrowserFillForm', 'BrowserFindText',
      'Glob', 'Grep', 'BrowserHover', 'BrowserType',
      'BrowserMediaControl', 'BrowserMediaState', 'BrowserNavigate', 'PowerShell',
      'Read', 'BrowserReadElement', 'BrowserReadPage', 'BrowserScreenshot',
      'BrowserScroll', 'BrowserScrollToElement', 'BrowserSearch', 'BrowserSelectOption',
      'BrowserUpload', 'Write',
    ])
    for (const tool of HOST_TOOL_DEFINITIONS) {
      expect(hostRouteFor(tool.name)).toEqual(tool.host)
      expect(['files', 'exec', 'browser']).toContain(tool.host.capability)
      expect(tool.host.action).toMatch(/^[a-z][A-Za-z]*$/)
    }
    expect(hostRouteFor('Read')).toEqual({ capability: 'files', action: 'read' })
    expect(hostRouteFor('Grep')).toEqual({ capability: 'files', action: 'grep' })
    expect(hostRouteFor('PowerShell')).toEqual({ capability: 'exec', action: 'powerShell' })
    expect(hostRouteFor('BrowserType')).toEqual({ capability: 'browser', action: 'input' })
    expect(hostRouteFor('TodoWrite')).toBeUndefined()
  })

  it('rejects a browser tool call that omits a reflection field before it reaches the host', () => {
    const reflection = {
      evaluation_previous_goal: 'no prior goal',
      memory: 'nothing yet',
      next_goal: 'go back one page',
    }
    expect(hostToolArgsError('BrowserBack', {})).toBe(
      "missing required string 'evaluation_previous_goal'",
    )
    expect(hostToolArgsError('BrowserBack', { ...reflection, memory: 3 })).toBe(
      "missing required string 'memory'",
    )
    expect(hostToolArgsError('BrowserClick', { ...reflection, next_goal: undefined })).toBe(
      "missing required string 'next_goal'",
    )
    expect(hostToolArgsError('BrowserBack', reflection)).toBeUndefined()
    // Every browser-family tool carries them; the other families never do.
    for (const tool of HOST_TOOL_DEFINITIONS) {
      expect(hostToolArgsError(tool.name, {}) !== undefined, tool.name)
        .toBe(tool.host.capability === 'browser')
    }
    expect(hostToolArgsError('TodoWrite', {})).toBeUndefined()
  })

  // The provider rejects the whole request when an example misses a required
  // property or carries an undeclared one.
  it('every input example satisfies its tool schema', () => {
    const JSON_TYPE: Record<string, (value: unknown) => boolean> = {
      string: value => typeof value === 'string',
      integer: value => Number.isInteger(value),
      number: value => typeof value === 'number',
      boolean: value => typeof value === 'boolean',
      array: value => Array.isArray(value),
      object: value => typeof value === 'object' && value !== null && !Array.isArray(value),
    }
    let checked = 0
    for (const tool of HOST_TOOL_DEFINITIONS) {
      const properties = (tool.parameters.properties ?? {}) as Record<string, { type?: string }>
      const required = (tool.parameters.required ?? []) as string[]
      for (const [i, example] of (tool.inputExamples ?? []).entries()) {
        const where = `${tool.name} example ${i}`
        for (const field of required) expect(example, where).toHaveProperty(field)
        for (const [key, value] of Object.entries(example)) {
          expect(Object.keys(properties), `${where}: ${key}`).toContain(key)
          const type = properties[key].type
          if (type) expect(JSON_TYPE[type](value), `${where}: ${key} is ${type}`).toBe(true)
        }
        checked += 1
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('offers a family only when the host advertises it, and a shell only when the host runs it', () => {
    const all = ['files', 'exec', 'browser']
    const everything = hostedToolsForHost(all, { bash: true, powershell: true })
    expect(everything.map(t => t.name)).toEqual(HOST_TOOL_DEFINITIONS.map(t => t.name))

    const noBrowser = hostedToolsForHost(['files', 'exec'], { bash: true, powershell: false })
    expect(noBrowser.some(t => t.host.capability === 'browser')).toBe(false)
    expect(noBrowser.map(t => t.name)).toContain('Bash')
    expect(noBrowser.map(t => t.name)).not.toContain('PowerShell')

    const unknownShells = hostedToolsForHost(all, undefined)
    expect(unknownShells.map(t => t.name)).not.toContain('Bash')
    expect(unknownShells.map(t => t.name)).not.toContain('PowerShell')
    expect(unknownShells.map(t => t.name)).toContain('Grep')

    expect(hostedToolsForHost(['fs', 'shell'], { bash: true, powershell: true })).toEqual([])
  })

  it('the browser skill carries exactly the browser-bound tools, in order', () => {
    const bound = HOST_TOOL_DEFINITIONS.filter(t => t.skill === 'browser').map(t => t.name)
    expect(BROWSER_HOSTED_SKILL.name).toBe('browser')
    expect(BROWSER_HOSTED_SKILL.toolNames).toEqual(bound)
    expect(bound.length).toBe(23)
    expect(BROWSER_HOSTED_SKILL.description.length).toBeGreaterThan(0)
    expect(BROWSER_HOSTED_SKILL.instructions.endsWith('\n')).toBe(false)

    expect(hostedSkillsForHost(hostedToolsForHost(['browser'], undefined))).toEqual([
      BROWSER_HOSTED_SKILL,
    ])
    expect(hostedSkillsForHost(hostedToolsForHost(['files'], undefined))).toEqual([])
  })

  it('is a verbatim copy of the host declarations (sibling checkout)', () => {
    const dir = findDeclarationsDir()
    if (!dir) {
      console.warn('[host-tool-definitions] no sibling src/custom_browser checkout — skipped')
      return
    }
    const byName = new Map(HOST_TOOL_DEFINITIONS.map(t => [t.name, t] as const))
    let compared = 0
    for (const family of ['browser_tool', 'file_tool', 'process_tool']) {
      const familyDir = join(dir, family)
      for (const file of readdirSync(familyDir)) {
        if (!file.endsWith('.tool.json')) continue
        const raw = JSON.parse(readFileSync(join(familyDir, file), 'utf-8')) as RawTool
        const expected = serializeLikeTheHost(raw, family)
        const actual = byName.get(raw.wire_name)
        expect(actual, `${family}/${file}`).toBeDefined()
        const { host: _host, ...definition } = actual!
        expect(definition, `${family}/${file}`).toEqual(expected)
        compared += 1
      }
    }
    expect(compared).toBe(HOST_TOOL_DEFINITIONS.length)

    const prose = (name: string) => {
      const text = readFileSync(join(dir, 'browser_tool', name), 'utf-8')
      return text.endsWith('\n') ? text.slice(0, -1) : text
    }
    expect(BROWSER_HOSTED_SKILL.description).toBe(prose('browser-skill-description.md'))
    expect(BROWSER_HOSTED_SKILL.instructions).toBe(prose('browser-skill-instructions.md'))
  })
})
