import { readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/**
 * A source-level walk of the app's STATIC import graph — the edges the bundler
 * folds into one chunk. `import type` and `import()` are not followed; bare
 * package specifiers and virtual modules are not resolved.
 */

export const SRC = join(__dirname, '..', '..')
export const ROOT = join(SRC, '..')

export const rel = (file: string): string => relative(ROOT, file).split(sep).join('/')

export const read = (file: string): string => readFileSync(file, 'utf8')

/** Source with comments removed, so a commented-out import is not an edge. */
export const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/**
 * Resolve a module specifier the way the bundler does — `@/` to `src/`, `./`
 * and `../` relative to the importer.
 *
 * Only `.ts`/`.tsx` (and their `index` forms) resolve: a specifier landing on
 * a `.css` file is not a source module and contributes no bytes here.
 */
export function resolveSpecifier(specifier: string, importer: string): string | null {
  let base: string
  if (specifier.startsWith('@/')) {
    base = join(SRC, specifier.slice(2))
  } else if (specifier.startsWith('.')) {
    base = resolve(dirname(importer), specifier)
  } else {
    return null
  }
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Not this shape — try the next.
    }
  }
  return null
}

/**
 * Static import edges out of a module (same chunk); `import type` and `import()` are not followed. Two shapes are
 * matched (single-line and braced clause) so a match cannot run past a statement with no `from`.
 */
export function staticImports(file: string): string[] {
  const source = stripComments(read(file))
  const specifiers: string[] = []

  const singleLine =
    /^[ \t]*(?:import|export)\b[^'"\n]*?\bfrom\b[ \t]*['"]([^'"]+)['"]/gm
  // `[^'"\n{]*` before the brace so a default-plus-named clause
  // (`import Foo, {`) is matched too, without letting the pattern cross a line.
  const braced =
    /^[ \t]*(?:import|export)[ \t]+(?:type[ \t]+)?[^'"\n{]*\{[\s\S]*?\}[ \t]*from\b[ \t]*['"]([^'"]+)['"]/gm
  const sideEffect = /^[ \t]*import[ \t]*['"]([^'"]+)['"]/gm

  for (const pattern of [singleLine, braced]) {
    for (const match of source.matchAll(pattern)) {
      // `import type X from` / `import type { X } from` are erased.
      if (/^[ \t]*(?:import|export)[ \t]+type\b/.test(match[0])) continue
      specifiers.push(match[1])
    }
  }
  for (const match of source.matchAll(sideEffect)) {
    specifiers.push(match[1])
  }
  return specifiers
}

/** Every module reachable from `roots` through static imports only. */
export function staticClosure(roots: readonly string[]): Set<string> {
  const seen = new Set(roots)
  const pending = [...roots]
  while (pending.length > 0) {
    const file = pending.pop() as string
    for (const specifier of staticImports(file)) {
      const target = resolveSpecifier(specifier, file)
      if (target && !seen.has(target)) {
        seen.add(target)
        pending.push(target)
      }
    }
  }
  return seen
}

/** A shortest static import chain from `root` to `target`, root first, as
 *  repo-relative paths; empty when `target` is not reachable. */
export function staticImportPath(root: string, target: string): string[] {
  const parent = new Map<string, string | null>([[root, null]])
  const queue = [root]
  while (queue.length > 0 && !parent.has(target)) {
    const file = queue.shift() as string
    for (const specifier of staticImports(file)) {
      const next = resolveSpecifier(specifier, file)
      if (next && !parent.has(next)) {
        parent.set(next, file)
        queue.push(next)
      }
    }
  }
  if (!parent.has(target)) return []
  const chain: string[] = []
  for (let file: string | null = target; file; file = parent.get(file) ?? null) {
    chain.unshift(rel(file))
  }
  return chain
}

export function sourceBytes(files: Iterable<string>): number {
  let total = 0
  for (const file of files) total += statSync(file).size
  return total
}
