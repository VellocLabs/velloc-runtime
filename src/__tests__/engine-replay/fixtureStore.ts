import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

export const RECORDING = process.env.ENGINE_REPLAY_RECORD === '1'

export function fixturePath(name: string): string {
  return join(FIXTURE_DIR, `${name}.trace.json`)
}

export function readFixture(name: string): unknown | undefined {
  const path = fixturePath(name)
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function writeFixture(name: string, trace: unknown): void {
  mkdirSync(FIXTURE_DIR, { recursive: true })
  writeFileSync(fixturePath(name), `${JSON.stringify(trace, null, 2)}\n`, 'utf8')
}

/** `ENGINE_REPLAY_DUMP=<dir>` writes every live trace there before its check
 *  runs, so a failing check can be read. Never a fixture. */
export const DUMP_DIR = process.env.ENGINE_REPLAY_DUMP

export function dumpTrace(name: string, trace: unknown): void {
  if (!DUMP_DIR) return
  mkdirSync(DUMP_DIR, { recursive: true })
  writeFileSync(join(DUMP_DIR, `${name}.trace.json`), `${JSON.stringify(trace, null, 2)}\n`, 'utf8')
}
