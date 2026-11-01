import { describe, expect, it, vi } from 'vitest'
import { AgentRuntimeRecovery } from '../browser/worker/AgentRuntimeRecovery'
import { getPlanFilePathForSession } from '../utils/planFiles'
import { unconfiguredFs, type RuntimeFs, type RuntimeFsStat } from '../utils/fs/runtimeFs'

// A fork's worker copies the source's plan file on init. The copy source
// (`forkedFromSessionId`) is permanent lineage: the session list nests the
// fork under it (F-36), so init must leave it in the stored metadata, and a
// second init must neither copy again nor overwrite the fork's own plan,
// even when the fork's plan cannot be checked.

const CWD = '/workspace'
const SOURCE = 'source-session'
const FORK = 'fork-session'

function makeFakeFs(seed: Record<string, string>): {
  fs: RuntimeFs
  files: Map<string, string>
  writes: string[]
  /** When set, every `stat` rejects with this error instead of answering. */
  faults: { stat: unknown }
} {
  const files = new Map(Object.entries(seed))
  const writes: string[] = []
  const faults: { stat: unknown } = { stat: null }
  const stat = (): RuntimeFsStat =>
    ({
      size: 0,
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      isCharacterDevice: () => false,
      isBlockDevice: () => false,
    }) as RuntimeFsStat
  const fs: RuntimeFs = {
    ...unconfiguredFs,
    async stat(path: string) {
      if (faults.stat) throw faults.stat
      if (!files.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return stat()
    },
    async mkdir() {},
    async readFile(path: string) {
      const content = files.get(path)
      if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return content
    },
    async writeFile(path: string, data: string | Uint8Array) {
      writes.push(path)
      files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
    },
  } as RuntimeFs
  return { fs, files, writes, faults }
}

/** A fork's runtime as the recovery sees it: metadata store, bound id, cwd, fs. */
function makeForkRuntime(fs: RuntimeFs) {
  const metadata: Record<string, unknown> = { forkedFromSessionId: SOURCE, forkedAtMessageUuid: 'cut-1' }
  const updateSessionMetadata = vi.fn(async (patch: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete metadata[key]
      else metadata[key] = value
    }
  })
  const runtime = {
    options: { cwd: CWD },
    engine: { boundSessionId: () => FORK },
    installedFs: fs,
    conversationStore: {
      getSessionMetadata: async () => ({ ...metadata }),
      updateSessionMetadata,
    },
  }
  return { runtime, metadata, updateSessionMetadata }
}

function initOnce(runtime: object): Promise<void> {
  const recovery = new AgentRuntimeRecovery({ clearPendingPlanApprovalMarker: vi.fn() } as never)
  recovery.bindRuntime(runtime as never)
  return recovery.copyForkedPlanIfNeeded()
}

describe('a fork keeps its copy source across inits', () => {
  it('copies the plan on the first init and leaves forkedFromSessionId in the metadata', async () => {
    const { fs, files } = makeFakeFs({ [getPlanFilePathForSession(CWD, SOURCE)]: '# Source plan' })
    const { runtime, metadata, updateSessionMetadata } = makeForkRuntime(fs)

    await initOnce(runtime)

    expect(files.get(getPlanFilePathForSession(CWD, FORK))).toBe('# Source plan')
    expect(metadata.forkedFromSessionId).toBe(SOURCE)
    expect(metadata.forkedAtMessageUuid).toBe('cut-1')
    expect(updateSessionMetadata).not.toHaveBeenCalled()
  })

  it('a second init copies nothing and never overwrites the plan the fork wrote since', async () => {
    const { fs, files, writes } = makeFakeFs({ [getPlanFilePathForSession(CWD, SOURCE)]: '# Source plan' })
    const { runtime, metadata } = makeForkRuntime(fs)
    const forkPlanPath = getPlanFilePathForSession(CWD, FORK)

    await initOnce(runtime)
    files.set(forkPlanPath, '# The fork went its own way')
    files.set(getPlanFilePathForSession(CWD, SOURCE), '# Source plan, revised')
    const writesAfterFirstInit = writes.length

    await initOnce(runtime)

    expect(files.get(forkPlanPath)).toBe('# The fork went its own way')
    expect(writes).toHaveLength(writesAfterFirstInit)
    expect(metadata.forkedFromSessionId).toBe(SOURCE)
  })

  it('a stat failure that is not "not found" on a later init leaves the fork\'s plan alone', async () => {
    const { fs, files, writes, faults } = makeFakeFs({ [getPlanFilePathForSession(CWD, SOURCE)]: '# Source plan' })
    const { runtime, metadata } = makeForkRuntime(fs)
    const forkPlanPath = getPlanFilePathForSession(CWD, FORK)

    await initOnce(runtime)
    files.set(forkPlanPath, '# The fork went its own way')
    const writesAfterFirstInit = writes.length
    faults.stat = Object.assign(new Error('stat timed out'), { code: 'ETIMEDOUT' })

    await initOnce(runtime)

    expect(files.get(forkPlanPath)).toBe('# The fork went its own way')
    expect(writes).toHaveLength(writesAfterFirstInit)
    expect(metadata.forkedFromSessionId).toBe(SOURCE)
  })

  it('with no source plan there is nothing to copy, and the copy source still stays', async () => {
    const { fs, writes } = makeFakeFs({})
    const { runtime, metadata } = makeForkRuntime(fs)

    await initOnce(runtime)
    await initOnce(runtime)

    expect(writes).toEqual([])
    expect(metadata.forkedFromSessionId).toBe(SOURCE)
  })
})
