// Publish-time step: fetch the live model source, run the catalog adapter and
// write the bundle snapshot to public/catalog/snapshot/ (snapshotProviders.ts
// keys only). On a source failure the freshest valid --fallback-base snapshot
// is reused with a `::warning::`; exit 1 when none is usable or a built-in
// row's figures are missing. Output is staged and swapped in, never partial.
//   --out <dir>  --url <url>  --file <path> (tests)  --skip-builtin-coverage (tests)
//   --fallback-base <base>  a served interface root (.../v5) or a local dir; repeatable
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildSnapshotFiles,
  describeSnapshotAge,
  missingSnapshotProviders,
  readServedSnapshot,
  type ServedSnapshot,
  type SnapshotFiles,
} from '../src/catalog/snapshotGenerator'
import { SNAPSHOT_ASSET_ROOT } from '../src/catalog/catalogSnapshot'
import {
  DEFAULT_SOURCE_URL,
  MAX_DOCUMENT_BYTES,
  utf8ByteLength,
} from '../src/catalog/catalogFetcher'
import { snapshotCoverageProblems } from '../src/catalog/builtinCatalogCoverage'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FETCH_TIMEOUT_MS = 30_000

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function args(name: string): string[] {
  const out: string[] = []
  process.argv.forEach((a, i) => {
    if (a === name && process.argv[i + 1] !== undefined) out.push(process.argv[i + 1])
  })
  return out
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function checkSize(text: string, what: string): string {
  if (utf8ByteLength(text) > MAX_DOCUMENT_BYTES) throw new Error(`${what} is larger than the 8 MiB cap`)
  return text
}

async function liveFiles(): Promise<SnapshotFiles> {
  const file = arg('--file')
  let text: string
  if (file) {
    text = await readFile(file, 'utf8')
  } else {
    const url = arg('--url') ?? DEFAULT_SOURCE_URL
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`catalog source ${url} answered HTTP ${res.status}`)
    text = await res.text()
  }
  return buildSnapshotFiles(checkSize(text, 'catalog document'), Date.now())
}

/** Text of `<base>/catalog/snapshot/<rel>`; undefined when absent. */
function servedTextReader(base: string): (rel: string) => Promise<string | undefined> {
  const root = base.replace(/[\\/]+$/, '')
  if (/^https?:\/\//i.test(root)) {
    const get = (rel: string) =>
      fetch(`${root}/${SNAPSHOT_ASSET_ROOT}/${rel}`, {
        headers: { accept: 'application/json', 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    return async rel => {
      // One retry on a transport error: a dropped connection is not a
      // missing file, and a missing file makes the whole snapshot unusable.
      const res = await get(rel).catch(() => get(rel))
      if (res.status === 404) return undefined
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return checkSize(await res.text(), rel)
    }
  }
  return async rel => {
    try {
      return checkSize(await readFile(path.join(root, SNAPSHOT_ASSET_ROOT, rel), 'utf8'), rel)
    } catch {
      return undefined
    }
  }
}

/** The freshest usable served snapshot, or throws naming each base's problem. */
async function servedFiles(bases: string[]): Promise<ServedSnapshot & { base: string }> {
  const problems: string[] = []
  let best: (ServedSnapshot & { base: string }) | undefined
  for (const base of bases) {
    try {
      const snap = await readServedSnapshot(servedTextReader(base))
      if (!best || snap.index.generatedAt > best.index.generatedAt) best = { ...snap, base }
    } catch (e) {
      problems.push(`${base}: ${reason(e)}`)
    }
  }
  if (!best) throw new Error(problems.join('; ') || 'no --fallback-base given')
  return best
}

async function writeStaged(out: string, files: SnapshotFiles): Promise<void> {
  // Write beside, then swap, so a failure never leaves a half-written snapshot.
  const staging = `${out}.tmp`
  await rm(staging, { recursive: true, force: true })
  try {
    for (const [rel, body] of Object.entries(files)) {
      const target = path.join(staging, rel)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, body, 'utf8')
    }
  } catch (e) {
    await rm(staging, { recursive: true, force: true })
    throw e
  }
  await rm(out, { recursive: true, force: true })
  await mkdir(path.dirname(out), { recursive: true })
  await rename(staging, out)
}

async function main(): Promise<void> {
  const out = path.resolve(arg('--out') ?? path.join(repoRoot, 'public', 'catalog', 'snapshot'))
  const bases = args('--fallback-base')
  let files: SnapshotFiles
  try {
    files = await liveFiles()
  } catch (liveError) {
    if (bases.length === 0) throw liveError
    let served: ServedSnapshot & { base: string }
    try {
      served = await servedFiles(bases)
    } catch (servedError) {
      throw new Error(
        `live source: ${reason(liveError)}; no usable served snapshot: ${reason(servedError)}`,
      )
    }
    const age = describeSnapshotAge(served.index.generatedAt, Date.now())
    const generated = new Date(served.index.generatedAt).toISOString()
    const message =
      `live model source unusable (${reason(liveError)}); reusing the snapshot served at ` +
      `${served.base}, generated ${generated} (${age} old). Re-run the publish once the source is back.`
    console.log(`::warning title=Model catalog snapshot reused::${message}`)
    console.log(`catalog snapshot WARNING: ${message}`)
    files = served.files
  }
  if (!process.argv.includes('--skip-builtin-coverage')) {
    const problems = snapshotCoverageProblems(files)
    if (problems.length > 0) {
      throw new Error(`the snapshot does not cover the built-in rows:\n  ${problems.join('\n  ')}`)
    }
  }
  await writeStaged(out, files)
  const missing = missingSnapshotProviders(files)
  if (missing.length > 0) {
    // Not fatal: a key the source dropped or renamed. Update snapshotProviders.ts.
    console.warn(`catalog snapshot: the source has no ${missing.join(', ')}`)
  }
  console.log(`catalog snapshot: ${Object.keys(files).length} files -> ${out}`)
}

main().catch(e => {
  console.error(`catalog snapshot FAILED: ${reason(e)}`)
  process.exitCode = 1
})
