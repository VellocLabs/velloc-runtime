import { describe, expect, it } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import {
  buildSidechainChain,
  InMemorySidechainTranscriptStore,
  type SidechainEntry,
  type SidechainMetadata,
} from '../utils/sidechainTranscripts'

// ---------------------------------------------------------------------------
// buildSidechainChain / loadChain — load a sub-agent's
// conversation as a root→leaf chain with the __sidechain_meta header and
// chain-stamp fields stripped.
// ---------------------------------------------------------------------------

function meta(agentId: string): SidechainMetadata {
  return {
    type: '__sidechain_meta',
    agentId,
    spawnerSessionId: 'parent-sess',
    forkLabel: 'test',
    startedAt: 1,
    model: 'test-model',
  }
}

function msg(uuid: string, parentUuid: string | null, text: string): Message {
  return {
    type: 'user',
    uuid,
    parentUuid,
    sessionId: 'sess',
    transcriptOrdinal: 0, // legacy counter, older files
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as unknown as Message
}

describe('buildSidechainChain', () => {
  it('returns [] for empty / metadata-only entries', () => {
    expect(buildSidechainChain([])).toEqual([])
    expect(buildSidechainChain([meta('a')])).toEqual([])
  })

  it('builds a root→leaf chain and strips the header + chain fields', () => {
    const entries: SidechainEntry[] = [
      meta('a'),
      msg('m1', null, 'first'),
      msg('m2', 'm1', 'second'),
      msg('m3', 'm2', 'third'),
    ]
    const chain = buildSidechainChain(entries)
    expect(chain.map(m => m.uuid)).toEqual(['m1', 'm2', 'm3'])
    // Chain-stamp fields are stripped.
    for (const m of chain) {
      expect((m as Record<string, unknown>).parentUuid).toBeUndefined()
      expect((m as Record<string, unknown>).sessionId).toBeUndefined()
      expect((m as Record<string, unknown>).transcriptOrdinal).toBeUndefined()
    }
  })

  it('picks the latest leaf when there are dead forks', () => {
    const entries: SidechainEntry[] = [
      msg('m1', null, 'root'),
      msg('dead', 'm1', 'dead branch'), // orphaned fork
      msg('m2', 'm1', 'live'),
      msg('m3', 'm2', 'leaf'),
    ]
    const chain = buildSidechainChain(entries)
    // m3 → m2 → m1; the dead branch is excluded.
    expect(chain.map(m => m.uuid)).toEqual(['m1', 'm2', 'm3'])
  })

  it('is cycle-safe (does not loop forever)', () => {
    const entries: SidechainEntry[] = [
      msg('a', 'b', 'x'),
      msg('b', 'a', 'y'), // cycle a↔b
    ]
    const chain = buildSidechainChain(entries)
    // Terminates; contains both nodes once (order depends on leaf pick).
    expect(chain.length).toBe(2)
    expect(new Set(chain.map(m => m.uuid)).size).toBe(2)
  })
})

describe('InMemorySidechainTranscriptStore.loadChain', () => {
  it('returns the chain for a recorded sub-agent, [] when absent', async () => {
    const store = new InMemorySidechainTranscriptStore()
    await store.append('sess', 'agent-1', meta('agent-1'))
    await store.append('sess', 'agent-1', msg('m1', null, 'hi') as SidechainEntry)
    await store.append('sess', 'agent-1', msg('m2', 'm1', 'yo') as SidechainEntry)

    const chain = await store.loadChain('sess', 'agent-1')
    expect(chain.map(m => m.uuid)).toEqual(['m1', 'm2'])

    expect(await store.loadChain('sess', 'missing')).toEqual([])
  })
})
