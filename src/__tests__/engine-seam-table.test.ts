// The engine's extension seam (F-26): the seam table names every event
// the extension runtime raises from the engine and the toolkit, each row's
// mode is the one its seam member declares, and neither layer reaches into
// the concrete extension runtime.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { agentLoopExtensions, noTurnExtensions } from '../engine/extensionSeam'
import { SEAM_EVENTS } from '../engine/seamTable'
import { RAISED_EVENTS } from '../mods/modAdmission'
import { implementedNouns } from '../mods/modNouns'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Events the extension runtime raises from places other than the engine
 *  and the toolkit, with the owner that raises them. */
const RAISED_ELSEWHERE: Record<string, string> = {
  'session.start': 'the extension runtime, as each module loads',
  'plugin.register': 'the extension runtime, a module about to join',
  'engine.create': 'the extension runtime, the fold that builds `$`',
  'ui.render': 'the drawing sites (mods/modRender.ts)',
  'ui.press': 'the drawing sites',
  'ui.input': 'the drawing sites',
  'ui.select': 'the drawing sites',
  'prompt.edit': "the page's prompt box (mods/modPromptEdit.ts)",
  'session.attach': 'the client roster',
  'session.detach': 'the client roster',
  'skill.prompt': 'the skill expansion',
  'agent.offer': 'the Agent tool, an agent type offered',
  'config.describe': 'the /config menu',
  'classic.SubagentStart': 'the forked agent run (agents/forkedRun.ts)',
}

describe('seam table', () => {
  it('has one row per event the engine and the toolkit raise', () => {
    const nounOps = new Set(implementedNouns())
    const raised = new Set(RAISED_EVENTS.filter((e) => !nounOps.has(e)))
    const engine = SEAM_EVENTS.filter((row) => row.member !== 'ambient').map((row) => row.event)
    expect(new Set(engine).size).toBe(engine.length)
    for (const e of engine) expect(Object.keys(RAISED_ELSEWHERE)).not.toContain(e)
    // Every row is an event the runtime admits; every admitted event that is
    // not a served `$` noun is a row here or raised elsewhere. (A few rows are
    // also `$` nouns: a plugin may raise `tool.call` itself.)
    const admitted = new Set(RAISED_EVENTS)
    expect(engine.filter((e) => !admitted.has(e))).toEqual([])
    const covered = new Set([...engine, ...Object.keys(RAISED_ELSEWHERE)])
    expect([...raised].filter((e) => !covered.has(e))).toEqual([])
    expect(Object.keys(RAISED_ELSEWHERE).filter((e) => !raised.has(e))).toEqual([])
  })

  it('registers the ambient seam no extension raises, and ids.next as an extension event', () => {
    expect(SEAM_EVENTS.filter((row) => row.member === 'ambient').map((row) => row.event)).toEqual(['clock.now'])
    expect(SEAM_EVENTS.find((row) => row.event === 'ids.next')?.member).toBe('idsNext')
  })

  it('carries a row for each turn-level event of ABI 0.2', () => {
    const rows = new Map(SEAM_EVENTS.map((row) => [row.event, row.member]))
    expect(['turn.request', 'turn.continue', 'turn.recover', 'ids.next'].map((e) => rows.get(e))).toEqual([
      'turnRequest',
      'turnContinue',
      'turnRecover',
      'idsNext',
    ])
  })

  it("gives each row the mode its seam member declares", () => {
    const modes = memberModes(['engine/extensionSeam.ts', 'toolkit/toolExtensionSeam.ts'])
    for (const row of SEAM_EVENTS) {
      if (row.member === 'ambient') continue
      expect({ event: row.event, mode: modes.get(row.member) }).toEqual({ event: row.event, mode: row.mode })
    }
  })

  it('names raising files that exist', () => {
    for (const row of SEAM_EVENTS)
      for (const stage of row.raisedIn) expect(statSync(join(SRC, stage.file)).isFile()).toBe(true)
  })
})

describe('extension factories', () => {
  it('a child loop follows its parent at each call and enters prompts as given', async () => {
    const first = Promise.resolve()
    const second = Promise.resolve()
    let hooked = false
    const parent = { ...noTurnExtensions(), ready: first, hasToolCallHooks: () => hooked }
    const child = agentLoopExtensions(parent, 'agent-1')
    expect(child.agentId).toBe('agent-1')
    expect(child.ready).toBe(first)
    parent.ready = second
    hooked = true
    expect(child.ready).toBe(second)
    expect(child.hasToolCallHooks()).toBe(true)
    expect(await child.promptSubmit('hi')).toEqual({ entered: true, text: 'hi', context: [] })
    expect({ ...child }.ready).toBe(second)
  })

  it('a child loop with a bare parent runs every core', async () => {
    const child = agentLoopExtensions(
      { ready: Promise.resolve(), hasToolCallHooks: () => false, toolCall: async () => ({ settled: false }) },
      'a',
    )
    expect(child.hasTurnStepHooks()).toBe(false)
    expect(child.hasClassicHooks('Stop')).toBe(false)
    expect(child.turnStep({} as never, (() => undefined) as never)).toBeUndefined()
    expect(await child.classic('Stop' as never, {} as never, (async () => ({})) as never)).toEqual({ settled: false })
  })
})

describe('extension seam layering', () => {
  it('the engine and the toolkit never import the concrete extension runtime', () => {
    const runtime = join(SRC, 'mods', 'ModRuntime.ts')
    const offenders: string[] = []
    for (const file of [...sourceFiles(join(SRC, 'engine')), ...sourceFiles(join(SRC, 'toolkit'))]) {
      const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
      for (const ref of info.importedFiles) {
        if (!ref.fileName.startsWith('.')) continue
        const target = resolveModule(dirname(file), ref.fileName)
        if (target === runtime) offenders.push(`${file.slice(SRC.length + 1)} -> ${ref.fileName}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

/** `@mode` of each member of the named interfaces' files, from its doc. */
function memberModes(files: string[]): Map<string, string> {
  const modes = new Map<string, string>()
  for (const rel of files) {
    const sf = ts.createSourceFile(rel, readFileSync(join(SRC, rel), 'utf8'), ts.ScriptTarget.Latest, true)
    sf.forEachChild((node) => {
      if (!ts.isInterfaceDeclaration(node)) return
      for (const member of node.members) {
        const name = member.name?.getText(sf)
        const tag = ts.getJSDocTags(member).find((t) => t.tagName.text === 'mode')
        const comment = typeof tag?.comment === 'string' ? tag.comment : undefined
        const mode = comment?.match(/^(around|observe)\b/)?.[1]
        if (name && mode) modes.set(name, mode)
      }
    })
  }
  return modes
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(path)
  }
  return out
}

function resolveModule(from: string, spec: string): string | undefined {
  const base = resolve(from, spec.replace(/\.js$/, ''))
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // not this candidate
    }
  }
  return undefined
}
