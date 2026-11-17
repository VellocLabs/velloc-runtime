import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { rel, resolveSpecifier, SRC, staticImports } from './_helpers/staticImportGraph'

/**
 * The core (the engine and the tool-call pipeline) reaches built-in features
 * through the native hook tier, never by import (F-26). `KNOWN` lists the edges
 * allowed today; it may only shrink.
 */

const CORE_DIRS = [join(SRC, 'engine'), join(SRC, 'toolkit', 'run')]

/** A target is a feature when its path (relative to src/) starts with one of these. */
const FEATURE_PREFIXES = [
  'browser/worker/',
  'memory/',
  'permissions/planMode.',
  'permissions/planApproval.',
  'agents/forkedRun.',
  'context/compaction/browserObservationTrim.',
]

/** toolkit/run may not reach back up into the engine. */
const TOOLKIT_UPWARD = 'engine/'

const KNOWN: ReadonlySet<string> = new Set([
  'engine/autoTitle.ts -> browser/worker/SharedWorkerSessionManager.ts',
  'engine/promptAssembly.ts -> memory/instructionFiles.ts',
  'engine/promptAssembly.ts -> memory/memoryPrompt.ts',
  'engine/sessionLedger.ts -> memory/memoryPaths.ts',
  'engine/effectToolBatch.ts -> agents/forkedRun.ts',
  'engine/turn/turnDependencies.ts -> context/compaction/browserObservationTrim.ts',
  'toolkit/run/toolPermissionGate.ts -> memory/memoryPaths.ts',
  'toolkit/run/toolPermissionGate.ts -> permissions/planMode.ts',
])

function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path)
  }
  return files
}

const fromSrc = (file: string) => rel(file).replace(/^src\//, '')

function featureEdges(): string[] {
  const edges: string[] = []
  for (const file of CORE_DIRS.flatMap(sourceFiles)) {
    const source = fromSrc(file)
    for (const specifier of staticImports(file)) {
      const target = resolveSpecifier(specifier, file)
      if (!target) continue
      const to = fromSrc(target)
      const isFeature = FEATURE_PREFIXES.some(prefix => to.startsWith(prefix))
      const isUpward = source.startsWith('toolkit/run/') && to.startsWith(TOOLKIT_UPWARD)
      if (isFeature || isUpward) edges.push(`${source} -> ${to}`)
    }
  }
  return [...new Set(edges)].sort()
}

describe('core feature imports', () => {
  const edges = featureEdges()

  it('adds no feature import to the core', () => {
    const added = edges.filter(edge => !KNOWN.has(edge))
    expect(added, 'register the feature on the native hook tier (nativeFeatures/) instead').toEqual([])
  })

  it('keeps the known list current', () => {
    const gone = [...KNOWN].filter(edge => !edges.includes(edge))
    expect(gone, 'remove these edges from KNOWN: they no longer exist').toEqual([])
  })
})
