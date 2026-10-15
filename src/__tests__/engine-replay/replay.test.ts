/**
 * Differential trace replay: every scenario drives the engine with scripted
 * outside events and its normalized trace must equal the recorded fixture.
 * `ENGINE_REPLAY_RECORD=1` re-records the fixtures instead (see README.md).
 */
import { describe, expect, it } from 'vitest'
import { digestLongTexts, normalizeTrace } from './normalize'
import { DUMP_DIR, RECORDING, dumpTrace, fixturePath, readFixture, writeFixture } from './fixtureStore'
import type { Scenario } from './harness/scenario'

const modules = import.meta.glob<{ scenarios: Scenario[] }>('./scenarios/*.scenario.ts', { eager: true })

const all: Array<{ file: string; scenario: Scenario }> = []
for (const [file, mod] of Object.entries(modules).sort(([a], [b]) => a.localeCompare(b))) {
  for (const scenario of mod.scenarios) all.push({ file, scenario })
}

describe('engine replay', () => {
  it('scenario names are unique', () => {
    const names = all.map(e => e.scenario.name)
    expect(new Set(names).size).toBe(names.length)
  })

  for (const { file, scenario } of all) {
    it(`${file.replace('./scenarios/', '').replace('.scenario.ts', '')} › ${scenario.name}`, async () => {
      const trace = normalizeTrace(await scenario.run())
      if (DUMP_DIR) dumpTrace(scenario.name, trace)
      scenario.check?.(trace)
      // Long texts by digest, then through JSON, as the fixture is: absent and
      // undefined are one.
      const live = JSON.parse(JSON.stringify(digestLongTexts(trace))) as unknown
      if (RECORDING) {
        writeFixture(scenario.name, live)
        return
      }
      const recorded = readFixture(scenario.name)
      if (recorded === undefined) {
        throw new Error(`no fixture at ${fixturePath(scenario.name)}; record with ENGINE_REPLAY_RECORD=1`)
      }
      expect(live).toEqual(recorded)
    })
  }
})
