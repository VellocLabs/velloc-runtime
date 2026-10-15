import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import type { RuntimeFs, RuntimeFsEntry } from '../utils/fs/runtimeFs'
import {
  createFsSidechainTranscriptStore,
  createSidechainAgentId,
  InMemorySidechainTranscriptStore,
  isSidechainMetadata,
  type SidechainMetadata,
  type SidechainTranscriptStore,
} from '../utils/sidechainTranscripts'
import {
  getSubagentTranscriptPath,
  getSubagentsDirectoryPath,
  parseAgentIdFromFilename,
} from '../utils/sidechainStoragePaths'

// ============================================================================
// Helpers
// ============================================================================

function makeMeta(overrides: Partial<SidechainMetadata> = {}): SidechainMetadata {
  return {
    type: '__sidechain_meta',
    agentId: 'extract_memories_abc123_xyz',
    spawnerSessionId: 'session-1',
    forkLabel: 'extract_memories',
    startedAt: 1_700_000_000_000,
    model: 'claude-sonnet-4-6',
    parentUuid: 'last-parent-uuid',
    ...overrides,
  }
}

function makeMessage(uuid: string, text = 'hi'): Message {
  // The tests don't care about the full Message shape — `type` and
  // `uuid` are the only fields the store cares about. Cast through
  // unknown so we don't have to construct every optional field.
  return { type: 'user', uuid, message: { role: 'user', content: text } } as unknown as Message
}

/**
 * Build a minimal in-memory RuntimeFs that supports
 * mkdir / writeFile / appendFileSync / readFile / readdir / unlink — the
 * methods the fs-backed store actually calls. (`writeFile` is the real
 * append path now — the bridge has no working synchronous append, so the
 * store accumulates and async-`writeFile`s the whole file; `appendFileSync`
 * is kept only for tests that seed a file out-of-band.)
 */
function makeFakeFs(): RuntimeFs {
  const dirs = new Set<string>()
  const files = new Map<string, string>()

  const fs: Partial<RuntimeFs> = {
    existsSync(path: string) {
      return files.has(path)
    },
    async mkdir(path: string) {
      // Recursive — match the bridge adapter's semantics.
      const parts = path.split(/[\\/]/).filter(Boolean)
      let acc = ''
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : `/${part}`
        dirs.add(acc)
      }
    },
    async writeFile(path: string, data: string | Uint8Array) {
      const text =
        typeof data === 'string' ? data : new TextDecoder().decode(data)
      files.set(path, text)
    },
    appendFileSync(path: string, data: string) {
      files.set(path, (files.get(path) ?? '') + data)
    },
    async readFile(path: string) {
      const contents = files.get(path)
      if (contents === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return contents
    },
    async readdir(path: string): Promise<RuntimeFsEntry[]> {
      const out: RuntimeFsEntry[] = []
      const prefix = path.endsWith('/') ? path : path + '/'
      for (const filePath of files.keys()) {
        if (!filePath.startsWith(prefix)) continue
        const rest = filePath.slice(prefix.length)
        if (rest.includes('/')) continue // nested; skip
        out.push({
          name: rest,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        })
      }
      if (!dirs.has(path)) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return out
    },
    async unlink(path: string) {
      if (!files.delete(path)) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
    },
  }
  return fs as RuntimeFs
}

// ============================================================================
// Path helpers
// ============================================================================

describe('sidechain storage paths', () => {
  it('builds session-scoped subagents directory paths', () => {
    const dir = getSubagentsDirectoryPath('/base', 'session-1')
    expect(dir).toMatch(/session-1[\\/]subagents$/)
  })

  it('builds per-agent transcript paths with the agent- prefix + .jsonl suffix', () => {
    const path = getSubagentTranscriptPath('/base', 'session-1', 'agent_xyz')
    // Filename `agent-<encodedId>.jsonl` — the prefix keeps sync-fork
    // FILES distinct from the background sub-agent `subagent-…/` session DIRS
    // that share the `subagents/` directory.
    expect(path).toMatch(/[\\/]subagents[\\/]agent-agent_xyz\.jsonl$/)
  })

  it('round-trips agent ids that contain URL-special characters', () => {
    // The store API allows free-form agentIds; the path helper has to
    // round-trip them via encodeURIComponent so a `/` inside an id
    // doesn't collapse the directory.
    const tricky = 'fork label/with slash'
    const path = getSubagentTranscriptPath('/base', 'session-1', tricky)
    const filename = path.split(/[\\/]/).pop()!
    expect(parseAgentIdFromFilename(filename)).toBe(tricky)
  })

  it('returns undefined for filenames that are not agent-*.jsonl', () => {
    expect(parseAgentIdFromFilename('agent-agent_xyz.txt')).toBeUndefined()
    expect(parseAgentIdFromFilename('agent_xyz')).toBeUndefined()
    // A `.jsonl` WITHOUT the `agent-` prefix is not a sync-fork file — pins the
    // stricter parser so a `subagent-…` dir name or stray file is never parsed.
    expect(parseAgentIdFromFilename('naked_id.jsonl')).toBeUndefined()
    expect(parseAgentIdFromFilename('subagent-x.jsonl')).toBeUndefined()
  })
})

// ============================================================================
// Agent ID generator
// ============================================================================

describe('createSidechainAgentId', () => {
  it('prefixes the label and appends random + timestamp suffixes', () => {
    const id = createSidechainAgentId('extract_memories')
    expect(id).toMatch(/^extract_memories_[0-9a-f]{8}_[0-9a-z]+$/i)
  })

  it('sanitizes labels with filename-unsafe characters', () => {
    const id = createSidechainAgentId('a label/with spaces')
    expect(id.startsWith('a_label_with_spaces_')).toBe(true)
  })

  it('truncates labels longer than 32 chars', () => {
    const id = createSidechainAgentId('a'.repeat(100))
    const prefix = id.split('_')[0]
    expect(prefix.length).toBe(32)
  })

  it('falls back to "fork" when label sanitization eats everything', () => {
    const id = createSidechainAgentId('!!!')
    expect(id.startsWith('fork_')).toBe(true)
  })

  it('produces unique ids across calls with the same label', () => {
    // Even when called within the same Date.now() tick, the random
    // suffix should make collisions vanishingly unlikely.
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) ids.add(createSidechainAgentId('label'))
    expect(ids.size).toBe(100)
  })
})

// ============================================================================
// isSidechainMetadata discriminator
// ============================================================================

describe('isSidechainMetadata', () => {
  it('returns true for a real metadata entry', () => {
    expect(isSidechainMetadata(makeMeta())).toBe(true)
  })

  it('returns false for a message entry', () => {
    expect(isSidechainMetadata(makeMessage('u1'))).toBe(false)
  })
})

// ============================================================================
// Shared store-contract suite
// ============================================================================

/**
 * One test suite, two implementations. Both stores must satisfy the
 * same observable contract — running them through identical assertions
 * is the cleanest way to keep them in agreement.
 */
function runStoreContractTests(
  label: string,
  makeStore: () => SidechainTranscriptStore,
): void {
  describe(`SidechainTranscriptStore — ${label}`, () => {
    let store: SidechainTranscriptStore

    beforeEach(() => {
      store = makeStore()
    })

    it('returns empty for a session with no recordings', async () => {
      expect(await store.list('nothing')).toEqual([])
      expect(await store.load('nothing', 'agent')).toEqual([])
      expect(await store.loadMetadata('nothing', 'agent')).toBeNull()
    })

    it('round-trips a single metadata + message append', async () => {
      const meta = makeMeta()
      const msg = makeMessage('u1')
      await store.append('session-1', 'agent_a', meta)
      await store.append('session-1', 'agent_a', msg)
      const entries = await store.load('session-1', 'agent_a')
      expect(entries.length).toBe(2)
      expect(isSidechainMetadata(entries[0])).toBe(true)
      expect((entries[1] as Message).uuid).toBe('u1')
    })

    it('loadMetadata returns only the first entry when it is a meta', async () => {
      const meta = makeMeta({ forkLabel: 'meta-test' })
      await store.append('s', 'agent_a', meta)
      await store.append('s', 'agent_a', makeMessage('u1'))
      const loaded = await store.loadMetadata('s', 'agent_a')
      expect(loaded?.forkLabel).toBe('meta-test')
    })

    it('loadMetadata returns null when the first entry is a message', async () => {
      await store.append('s', 'agent_a', makeMessage('u1'))
      expect(await store.loadMetadata('s', 'agent_a')).toBeNull()
    })

    it('list returns every agent recorded under the session', async () => {
      await store.append('s', 'agent_a', makeMeta({ agentId: 'agent_a' }))
      await store.append('s', 'agent_b', makeMeta({ agentId: 'agent_b' }))
      const ids = await store.list('s')
      expect(new Set(ids)).toEqual(new Set(['agent_a', 'agent_b']))
    })

    it('list scopes to the requested session', async () => {
      await store.append('s1', 'agent_a', makeMeta({ agentId: 'agent_a' }))
      await store.append('s2', 'agent_b', makeMeta({ agentId: 'agent_b' }))
      expect(await store.list('s1')).toEqual(['agent_a'])
      expect(await store.list('s2')).toEqual(['agent_b'])
    })

    it('delete removes an agent transcript', async () => {
      await store.append('s', 'agent_a', makeMeta({ agentId: 'agent_a' }))
      await store.append('s', 'agent_a', makeMessage('u1'))
      await store.delete('s', 'agent_a')
      expect(await store.load('s', 'agent_a')).toEqual([])
      expect(await store.list('s')).toEqual([])
    })

    it('delete on a missing agent is a no-op', async () => {
      await expect(store.delete('s', 'no-such-agent')).resolves.toBeUndefined()
    })

    it('preserves append order', async () => {
      const meta = makeMeta()
      await store.append('s', 'agent_a', meta)
      for (let i = 0; i < 5; i++) {
        await store.append('s', 'agent_a', makeMessage(`u${i}`))
      }
      const entries = await store.load('s', 'agent_a')
      expect(entries.length).toBe(6)
      for (let i = 0; i < 5; i++) {
        expect((entries[i + 1] as Message).uuid).toBe(`u${i}`)
      }
    })
  })
}

runStoreContractTests(
  'InMemorySidechainTranscriptStore',
  () => new InMemorySidechainTranscriptStore(),
)

runStoreContractTests('createFsSidechainTranscriptStore', () =>
  createFsSidechainTranscriptStore({ fs: makeFakeFs(), basePath: '/base' }),
)

// ============================================================================
// RuntimeFs-backed store: failure-mode specifics
// ============================================================================

describe('createFsSidechainTranscriptStore — failure modes', () => {
  it('silently skips corrupt JSONL lines during load', async () => {
    const fs = makeFakeFs()
    const store = createFsSidechainTranscriptStore({ fs, basePath: '/base' })
    // Seed the file out-of-band with two good lines around a corrupt one,
    // then load — this pins `readJsonlEntries`' corrupt-line resilience
    // directly (the store's append mirrors+overwrites, so it can't be used
    // to leave a stray corrupt line on disk).
    const path = getSubagentTranscriptPath('/base', 's', 'agent_a')
    fs.appendFileSync(path, JSON.stringify(makeMeta({ agentId: 'agent_a' })) + '\n')
    fs.appendFileSync(path, '{not valid json\n')
    fs.appendFileSync(path, JSON.stringify(makeMessage('u1')) + '\n')
    const entries = await store.load('s', 'agent_a')
    // Bad line dropped; good entries preserved.
    expect(entries.length).toBe(2)
  })

  it('append swallows mkdir errors and still attempts write', async () => {
    const fs = makeFakeFs()
    const mkdirSpy = vi
      .spyOn(fs, 'mkdir')
      .mockRejectedValueOnce(new Error('EPERM'))
    const store = createFsSidechainTranscriptStore({ fs, basePath: '/base' })
    // First append swallows mkdir error; subsequent reads still succeed
    // because the fake's writeFile doesn't depend on dir existence.
    await store.append('s', 'agent_a', makeMeta({ agentId: 'agent_a' }))
    expect(mkdirSpy).toHaveBeenCalled()
    expect(await store.load('s', 'agent_a')).toHaveLength(1)
  })

  it('list returns empty when the sidechains directory is missing', async () => {
    const fs = makeFakeFs()
    const store = createFsSidechainTranscriptStore({ fs, basePath: '/base' })
    expect(await store.list('never-touched')).toEqual([])
  })

  it('persists appends via async writeFile, not the bridge-broken appendFileSync', async () => {
    // Regression guard: the original store used `appendFileSync`, which the
    // browser bridge cannot round-trip (sync calls over an async postMessage
    // transport silently no-op) — so sub-agent transcripts were never actually
    // written in production (the `sidechains/` dir was created by the async
    // mkdir but stayed empty). The store MUST use the async writeFile path,
    // the same one the main session transcript uses over the bridge.
    const fs = makeFakeFs()
    const writeSpy = vi.spyOn(fs, 'writeFile')
    const appendSyncSpy = vi.spyOn(fs, 'appendFileSync')
    const store = createFsSidechainTranscriptStore({ fs, basePath: '/base' })
    await store.append('s', 'agent_a', makeMeta({ agentId: 'agent_a' }))
    await store.append('s', 'agent_a', makeMessage('u1'))
    expect(writeSpy).toHaveBeenCalled()
    expect(appendSyncSpy).not.toHaveBeenCalled()
    // Both entries round-trip on disk (mirror + writeFile preserve prior lines).
    expect(await store.load('s', 'agent_a')).toHaveLength(2)
  })

  it('does not truncate an existing transcript when the seed read fails transiently', async () => {
    // Guard for the read-modify-write seed: a TRANSIENT read failure on a file
    // that already exists must abort the append (re-throw, swallowed upstream)
    // rather than seed empty and overwrite — otherwise the next writeFile would
    // wipe the whole prior transcript. A genuinely-missing file still starts
    // fresh (the existsSync(path)=false branch).
    const fs = makeFakeFs()
    const path = getSubagentTranscriptPath('/base', 's', 'agent_a')
    fs.appendFileSync(path, JSON.stringify(makeMeta({ agentId: 'agent_a' })) + '\n')
    const readSpy = vi
      .spyOn(fs, 'readFile')
      .mockRejectedValueOnce(new Error('EBUSY')) // transient, NOT ENOENT
    const store = createFsSidechainTranscriptStore({ fs, basePath: '/base' })
    await expect(store.append('s', 'agent_a', makeMessage('u1'))).rejects.toThrow()
    readSpy.mockRestore()
    // The pre-existing transcript survived intact — not truncated to empty.
    expect(await store.load('s', 'agent_a')).toHaveLength(1)
  })
})
