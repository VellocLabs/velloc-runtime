/**
 * The mod API declaration (F-25): generated from the engine's own tables,
 * current with its sources, and strict enough that a hooks module using
 * what the engine serves type-checks while one using an event, noun or
 * tool it does not serve fails `tsc`.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { generateModApiShapes, SHAPES_OUTPUT, shapesModuleText } from '../../scripts/gen_mod_api_shapes'
import { modApiTables } from '../mods/devModTypes'
import { buildModApiFiles, GENERATED_MARKER, isGeneratedFile, schemaType } from '../mods/modApiDeclaration'
import { MOD_API_SHAPES } from '../mods/modApiShapes.generated'
import { MOD_API_SPECIFIER } from '../mods/modCompiler'
import { RAISED_EVENTS } from '../mods/modAdmission'

const TOOLS = [
  {
    name: 'Bash',
    argsSchema: {
      type: 'object',
      properties: { command: { type: 'string' }, timeout: { type: 'number' } },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'mcp__notes__search',
    mcpInfo: { serverName: 'notes', toolName: 'search' },
    argsSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
]

const files = () => buildModApiFiles(modApiTables(TOOLS))

/** The type errors of `mod` (the plugin's `hooks/index.ts`) against the
 *  emitted types folder, under the emitted `tsconfig.json`. */
function typeErrors(mod: string, file = 'index.ts'): string[] {
  const emitted = files()
  const root = '/plugin'
  const types = `${root}/types`
  const virtual = new Map<string, string>([[`${root}/hooks/${file}`, mod]])
  for (const [name, text] of Object.entries(emitted)) virtual.set(`${types}/${name}`, text)
  const config = ts.parseConfigFileTextToJson('tsconfig.json', emitted['tsconfig.json']!)
  const { options } = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, types)
  const host = ts.createCompilerHost(options)
  const read = host.readFile.bind(host)
  const exists = host.fileExists.bind(host)
  const getSource = host.getSourceFile.bind(host)
  host.readFile = name => virtual.get(name) ?? read(name)
  host.fileExists = name => virtual.has(name) || exists(name)
  host.getSourceFile = (name, version, ...rest) =>
    virtual.has(name) ? ts.createSourceFile(name, virtual.get(name)!, version) : getSource(name, version, ...rest)
  const roots = [...virtual.keys()].filter(name => /\.tsx?$/.test(name))
  const program = ts.createProgram(roots, options, host)
  return ts
    .getPreEmitDiagnostics(program)
    .map(d => `${d.file ? path.basename(d.file.fileName) : ''}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)
}

const mod = (body: string): string => `import type { Register } from '${MOD_API_SPECIFIER}'
import { atom, read } from '${MOD_API_SPECIFIER}'
export const register: Register = on => {
${body}
}
`

describe('the generated event shapes', () => {
  it('match what the generator writes from the sources now', () => {
    expect(readFileSync(SHAPES_OUTPUT, 'utf8').replace(/\r\n/g, '\n')).toBe(shapesModuleText(generateModApiShapes()))
  }, 60_000)

  it('name only events the engine raises', () => {
    const table = MOD_API_SHAPES.slice(MOD_API_SHAPES.indexOf('export type ModEventShapes'))
    const keys = [...table.slice(0, table.indexOf('};')).matchAll(/'([a-z.]+)': Shape</g)].map(m => m[1]!)
    expect(keys.length).toBeGreaterThan(10)
    expect(keys.filter(key => !RAISED_EVENTS.includes(key))).toEqual([])
  })
})

describe('buildModApiFiles', () => {
  it('writes the declaration, the tool tables, a tsconfig to extend and a .gitignore, each marked', () => {
    const emitted = files()
    expect(Object.keys(emitted).sort()).toEqual(['.gitignore', 'api.d.ts', 'builtin-tools.d.ts', 'mcp-tools.d.ts', 'tsconfig.json'])
    for (const text of Object.values(emitted)) expect(isGeneratedFile(text)).toBe(true)
    expect(emitted['.gitignore']).toBe(`# ${GENERATED_MARKER}\n*\n`)
    expect(emitted['builtin-tools.d.ts']).toContain('"Bash": { command: string; timeout?: number }')
    expect(emitted['builtin-tools.d.ts']).not.toContain('mcp__notes__search')
    expect(emitted['mcp-tools.d.ts']).toContain('"mcp__notes__search": { query: string; [key: string]: unknown }')
  })

  it('follows the tables: an event or noun this engine stops serving leaves the declaration', () => {
    const tables = modApiTables(TOOLS)
    const fewer = buildModApiFiles({
      ...tables,
      events: tables.events.filter(event => event !== 'prompt.mention'),
      calls: tables.calls.filter(call => !call.startsWith('theme.')),
    })['api.d.ts']!
    expect(files()['api.d.ts']).toContain('"prompt.mention"')
    expect(fewer).not.toMatch(/"prompt\.mention"(?! *:)/)
    expect(files()['api.d.ts']).toContain('readonly theme: {')
    expect(fewer).not.toContain('readonly theme: {')
  })

  it('the declaration, as emitted', () => {
    const api = files()['api.d.ts']!.split(JSON.stringify(MOD_API_SPECIFIER)).join('"<api>"')
    expect(api).toMatchSnapshot()
  })
})

describe('tsc over a hooks module', () => {
  it('passes for events, nouns and tools the engine serves', () => {
    expect(
      typeErrors(
        mod(`  const count = atom({ plugin: 'demo', key: 'count' }, 0)
  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Bash') {
      const command: string = e.command
      void command
    }
    await read($, count)
    return next(e)
  })
  on('tool.check', async (_$, e, next) => (e.tool === 'mcp__notes__search' && e.input.query === '' ? { decision: 'deny', reason: 'empty' } : next(e)))
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.component !== 'Pane') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return <Box><Text>{e.props.title}</Text></Box>
  })
  on('turn.step', async function* (_$, e, next) {
    return yield* next(e)
  })
  on('session.*', async ($, _e, next) => {
    await $.session.id()
    return next(_e)
  }).catch(async (_$, e, next) => next(e))`),
        'index.tsx',
      ),
    ).toEqual([])
  })

  it('fails for an event, a noun or a tool the engine does not serve', () => {
    const errors = typeErrors(
      mod(`  on('tool.cal', async (_$, e, next) => next(e))
  on('tool.call', async ($, e, next) => {
    await $.telepathy.read()
    return e.tool === 'Teleport' ? undefined : next(e)
  })`),
    )
    expect(errors.some(line => line.includes('"tool.cal"'))).toBe(true)
    expect(errors.some(line => line.includes("'telepathy'"))).toBe(true)
    expect(errors.some(line => line.includes('"Teleport"'))).toBe(true)
  })
})

describe('schemaType', () => {
  it('turns the common schema forms into types and the rest into unknown', () => {
    expect(schemaType({ enum: ['a', 'b'] })).toBe('"a" | "b"')
    expect(schemaType({ type: ['string', 'null'] })).toBe('string | null')
    expect(schemaType({ type: 'array', items: { type: 'integer' } })).toBe('Array<number>')
    expect(schemaType({ anyOf: [{ type: 'string' }, { const: 3 }] })).toBe('string | 3')
    expect(schemaType({ type: 'object', properties: { 'a-b': { type: 'boolean' } }, additionalProperties: false })).toBe(
      '{ "a-b"?: boolean }',
    )
    expect(
      schemaType({
        allOf: [
          { anyOf: [{ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false }, { type: 'object', properties: { b: { type: 'number' } }, additionalProperties: false }] },
          { type: 'object', properties: { c: { type: 'boolean' } }, required: ['c'], additionalProperties: false },
        ],
      }),
    ).toBe('({ a?: string } | { b?: number }) & { c: boolean }')
    expect(schemaType({ allOf: [{ enum: ['x|y'] }, { type: 'object', additionalProperties: false }] })).toBe('"x|y" & {}')
    expect(schemaType(undefined)).toBe('unknown')
    expect(schemaType({ format: 'uri' })).toBe('unknown')
  })
})
