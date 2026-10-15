/**
 * How the background cache updater reaches the page (vite/backgroundCacheUpdatePlugin.ts): the dev server's tag
 * is `type="module"`; a build injects a classic `<script defer>`, valid only while the chunk is import- and
 * export-free, which the import-graph check below enforces.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import type { Rollup } from 'vite'
import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_CACHE_UPDATE_ENTRY,
  BACKGROUND_CACHE_UPDATE_SOURCE,
  backgroundCacheUpdateTag,
} from '../../vite/backgroundCacheUpdatePlugin'

function chunk(fields: Partial<Rollup.OutputChunk>): Rollup.OutputChunk {
  return {
    type: 'chunk',
    isEntry: true,
    name: BACKGROUND_CACHE_UPDATE_ENTRY,
    fileName: 'assets/backgroundCacheUpdate-abc123.js',
    imports: [],
    dynamicImports: [],
    exports: [],
    ...fields,
  } as Rollup.OutputChunk
}

function bundleOf(...chunks: Rollup.OutputChunk[]): Rollup.OutputBundle {
  return Object.fromEntries(chunks.map((c) => [c.fileName, c]))
}

const INDEX = chunk({
  name: 'index',
  fileName: 'assets/index-def456.js',
  imports: ['assets/vendor-789.js'],
  exports: ['a', 'b'],
})

describe('backgroundCacheUpdateTag', () => {
  it('serves the source as a module on the dev server', () => {
    expect(backgroundCacheUpdateTag('/', undefined)).toEqual({
      tag: 'script',
      attrs: { type: 'module', src: `/${BACKGROUND_CACHE_UPDATE_SOURCE}` },
      injectTo: 'body',
    })
    expect(backgroundCacheUpdateTag('/v1/', undefined).attrs?.src).toBe(
      '/v1/src/glic/backgroundCacheUpdate.ts',
    )
  })

  it('injects the built chunk as a classic deferred script', () => {
    const tag = backgroundCacheUpdateTag('/v1/', bundleOf(INDEX, chunk({})))
    expect(tag).toEqual({
      tag: 'script',
      attrs: { defer: true, src: '/v1/assets/backgroundCacheUpdate-abc123.js' },
      injectTo: 'body',
    })
    expect(tag.attrs).not.toHaveProperty('type')
  })

  it('fails the build when the chunk imports another chunk', () => {
    expect(() =>
      backgroundCacheUpdateTag(
        '/',
        bundleOf(INDEX, chunk({ imports: ['assets/manifestAssetBase-x.js'] })),
      ),
    ).toThrow(/classic <script defer>.*imports \[assets\/manifestAssetBase-x\.js\]/)
    expect(() =>
      backgroundCacheUpdateTag(
        '/',
        bundleOf(INDEX, chunk({ dynamicImports: ['assets/lazy-y.js'] })),
      ),
    ).toThrow(/imports \[assets\/lazy-y\.js\]/)
  })

  it('fails the build when the chunk exports anything', () => {
    expect(() =>
      backgroundCacheUpdateTag('/', bundleOf(INDEX, chunk({ exports: ['manifestAssetBase'] }))),
    ).toThrow(/exports \[manifestAssetBase\]/)
  })

  it('fails the build when the entry chunk is missing', () => {
    expect(() => backgroundCacheUpdateTag('/', bundleOf(INDEX))).toThrow(
      /no 'backgroundCacheUpdate' entry chunk/,
    )
  })
})

// ── The import graph that keeps the built chunk self-contained ─────────────
//
// Rollup inlines a local module into the updater's chunk only while no other
// input (index.html → main.tsx, warmSharedWorker.ts — both under src/) reaches
// it, and `resolveManualChunk` sends node_modules to shared vendor chunks. So
// the chunk stays import-free exactly when the entry's import closure has no
// bare imports and nothing outside the closure imports into it.

const ROOT = join(__dirname, '..', '..')
const SRC = join(ROOT, 'src')

function rel(path: string): string {
  return relative(ROOT, path).split('\\').join('/')
}

/** Specifiers the file imports at RUNTIME; type-only imports are erased by the build. */
function runtimeSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    false,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      const typeOnly =
        clause?.isTypeOnly ||
        (clause &&
          !clause.name &&
          clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((e) => e.isTypeOnly))
      if (!typeOnly) out.push(node.moduleSpecifier.text)
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      out.push(node.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      out.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

/** The file a relative or `@/` specifier names; null for a bare (node_modules) one. */
function resolveLocal(from: string, specifier: string): string | null {
  const path = specifier.split('?')[0]
  const base = path.startsWith('@/')
    ? join(SRC, path.slice(2))
    : path.startsWith('.')
      ? resolve(dirname(from), path)
      : null
  if (base === null) return null
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? base
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      sourceFiles(path, out)
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(path)
    }
  }
  return out
}

describe('the updater entry stays self-contained', () => {
  const entry = join(ROOT, BACKGROUND_CACHE_UPDATE_SOURCE)
  const closure = new Set([entry])
  const bare: string[] = []
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    for (const specifier of runtimeSpecifiers(file)) {
      const target = resolveLocal(file, specifier)
      if (target === null) {
        bare.push(`${rel(file)} imports ${specifier}`)
      } else if (!closure.has(target)) {
        closure.add(target)
        queue.push(target)
      }
    }
  }

  it('follows the entry into the modules it inlines', () => {
    expect([...closure].map(rel)).toContain('src/glic/manifestAssetBase.ts')
  })

  it('imports nothing from node_modules', () => {
    expect(bare).toEqual([])
  })

  it('no module outside the entry imports into it', () => {
    const names = [...closure].map((file) => file.replace(/^.*[\\/]/, '').replace(/\.tsx?$/, ''))
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      if (closure.has(file)) continue
      const text = readFileSync(file, 'utf8')
      if (!names.some((name) => text.includes(name))) continue
      for (const specifier of runtimeSpecifiers(file)) {
        const target = resolveLocal(file, specifier)
        if (target !== null && closure.has(target)) {
          offenders.push(`${rel(file)} imports ${rel(target)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
