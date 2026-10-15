/**
 * The runtime protocol's client core stays extractable (`runtimeProtocol/`, `runtimeTransport/` and
 * `runtimeClient/RuntimeConnection.ts` import only each other), and the public surface is deliberate: every `beta` /
 * `stable` `ActionSpec.stability` is pinned in `PUBLIC_DECLARATIONS`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CapabilityRegistry } from '../browser/runtimeHub'

const SRC = join(__dirname, '..')
const rel = (abs: string) => relative(SRC, abs).split(sep).join('/')

/** The would-be SDK: these files and everything they import. */
const CORE_ROOTS = [
  'browser/runtimeProtocol/index.ts',
  'browser/runtimeTransport/index.ts',
  'browser/runtimeClient/RuntimeConnection.ts',
]
const CORE_DIRS = ['browser/runtimeProtocol/', 'browser/runtimeTransport/']
const CORE_FILES = ['browser/runtimeClient/RuntimeConnection.ts']

/**
 * `file → number of non-internal stability declarations it holds`. Empty:
 * nothing is offered to third parties yet. Adding a `beta` / `stable` action
 * means adding its file here, in the same change.
 */
const PUBLIC_DECLARATIONS: Record<string, number> = {}

function specifiers(source: string): string[] {
  const out: string[] = []
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)'([^']+)'/gm
  for (let m = re.exec(source); m; m = re.exec(source)) out.push(m[1])
  return out
}

function resolveModule(fromFile: string, spec: string): string {
  const base = resolve(dirname(join(SRC, fromFile)), spec)
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    try {
      readFileSync(candidate)
      return rel(candidate)
    } catch {
      /* try the next shape */
    }
  }
  throw new Error(`${fromFile}: cannot resolve '${spec}'`)
}

const inCore = (file: string) =>
  CORE_FILES.includes(file) || CORE_DIRS.some(dir => file.startsWith(dir))

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  )
}

describe('runtime client core stays self-contained', () => {
  it('imports nothing outside runtimeProtocol / runtimeTransport / RuntimeConnection', () => {
    const escapes: string[] = []
    const seen = new Set<string>()
    const queue = [...CORE_ROOTS]
    while (queue.length > 0) {
      const file = queue.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      for (const spec of specifiers(readFileSync(join(SRC, file), 'utf8'))) {
        if (!spec.startsWith('.')) {
          escapes.push(`${file} → '${spec}' (a package; the SDK would inherit it)`)
          continue
        }
        const target = resolveModule(file, spec)
        if (!inCore(target)) escapes.push(`${file} → ${target}`)
        else queue.push(target)
      }
    }
    expect(seen.size).toBeGreaterThan(CORE_ROOTS.length)
    expect(escapes).toEqual([])
  })
})

describe('public API surface is declared, never implied', () => {
  it('every beta / stable declaration in the runtime is pinned here', () => {
    const found: Record<string, number> = {}
    for (const abs of walk(join(SRC, 'browser'))) {
      const count = (readFileSync(abs, 'utf8').match(/\bstability:\s*'(?:beta|stable)'/g) ?? [])
        .length
      if (count > 0) found[rel(abs)] = count
    }
    expect(found).toEqual(PUBLIC_DECLARATIONS)
  })

  it('an unmarked action is internal and absent from the public surface', () => {
    const registry = new CapabilityRegistry()
    registry.registerCapability({
      cap: 'demo',
      actions: {
        plain: { scope: 'control' },
        tried: { scope: 'control', stability: 'beta' },
        kept: { scope: 'observe', stability: 'stable' },
        hidden: { scope: 'control', stability: 'internal' },
      },
      handle: async () => null,
    })
    expect(registry.publicSurface()).toEqual([
      { route: 'demo.kept', stability: 'stable' },
      { route: 'demo.tried', stability: 'beta' },
    ])
  })

  it('an unknown stability is refused at registration', () => {
    const registry = new CapabilityRegistry()
    expect(() =>
      registry.registerCapability({
        cap: 'demo',
        actions: { odd: { scope: 'control', stability: 'frozen' as never } },
        handle: async () => null,
      }),
    ).toThrow(/unknown stability 'frozen'/)
  })
})
