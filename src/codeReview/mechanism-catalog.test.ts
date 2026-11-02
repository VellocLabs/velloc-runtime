import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Diagnostic, ReviewEvidence } from './contracts'
import { createMechanismCatalog, type MechanismCatalogInput, type MechanismCatalogStorage } from './mechanism-catalog'
import type { ReviewModelRequest, ReviewModelResult, ReviewModelRunner } from './runner'

const ERROR = 'publication-identity-uncertain'
function diagnostic(id = 'diagnostic-1', explanation = 'A missing lock allows two first inserts.'): Diagnostic {
  return { id, runId: `run-${id}`, anchor: { path: 'src/store.ts', revision: 'head', side: 'after', span: { start: 10, end: 12 } },
    claim: { title: 'Concurrent insertion duplicates identity', explanation, trigger: 'Two callers insert before either completes.' },
    classification: { kind: 'correctness', impact: 'major' }, evidenceKeys: ['source'], origin: { angle: 'root-cause' } }
}
function evidence(d: Diagnostic): ReviewEvidence[] {
  return [{ id: `source-${d.id}`, runId: d.runId, diagnosticId: d.id, source: { path: d.anchor.path, revision: 'head', toolCallKey: 'read-call' },
    excerpt: 'if (!rows.has(key)) await insert(key)', reason: 'The check and insert are not serialized.' }]
}
function input(d = diagnostic(), runner: ReviewModelRunner = vi.fn(async () => { throw new Error('unexpected-model-call') })): MechanismCatalogInput {
  return { targetKey: 'github:project:request-1', head: 'head', diagnostic: d, evidence: evidence(d), runner, signal: new AbortController().signal }
}
function storage() {
  let bytes: string | null = null
  const io: MechanismCatalogStorage = { read: vi.fn(async () => bytes), writeAtomic: vi.fn(async value => { bytes = value }) }
  return { io, bytes: () => bytes, seed: (value: string) => { bytes = value }, rows: () => JSON.parse(bytes!).rows }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function reply(request: ReviewModelRequest, disposition: 'same' | 'distinct' | 'uncertain' = 'same'): ReviewModelResult {
  const material = JSON.parse(request.blocks[1].text)
  return { interrupted: false, text: JSON.stringify({
    matchId: disposition === 'same' ? material.candidates[0].diagnosticId : null, disposition,
    rationale: disposition === 'same' ? 'Both describe the same missing serialization for concurrent first inserts.' : 'The new failure has a different causal mechanism.',
    evidence: [material.current, ...material.candidates].map(row => ({ diagnosticId: row.diagnosticId, quote: row.claim.explanation })),
  }) }
}
function matcher(disposition: 'same' | 'distinct' | 'uncertain' = 'same') {
  return vi.fn(async (request: ReviewModelRequest) => reply(request, disposition))
}

afterEach(() => vi.useRealTimers())
describe('durable publication mechanism catalog', () => {
  it('allocates a host UUID and reuses exact content across runs, owners and reordered evidence without a model', async () => {
    const disk = storage(), d = diagnostic()
    const first = input(d)
    first.evidence.push({ ...first.evidence[0], id: 'second', excerpt: 'await insert(key)' })
    const id = await createMechanismCatalog(disk.io, {}).resolve(first)
    expect(id).toMatch(/^[a-f0-9-]{36}$/u)
    const next = input(diagnostic('another-run'))
    next.evidence = [...first.evidence].reverse().map(row => ({ ...row, id: 'new-id', diagnosticId: next.diagnostic.id, runId: next.diagnostic.runId }))
    expect(await createMechanismCatalog(disk.io, {}).resolve(next)).toBe(id)
    expect(next.runner).not.toHaveBeenCalled()
    expect(disk.io.writeAtomic).toHaveBeenCalledOnce()
    expect(disk.bytes()).not.toContain('read-call')
    expect(disk.bytes()).not.toContain(d.runId)
  })

  it('serializes concurrent facades including a deferred paraphrase matcher', async () => {
    const disk = storage(), owner = {}, gate = deferred<ReviewModelResult>()
    const first = createMechanismCatalog(disk.io, owner)
    const otherIo: MechanismCatalogStorage = { read: vi.fn(async () => null), writeAtomic: vi.fn(async () => {}) }
    const second = createMechanismCatalog(otherIo, owner)
    const idPromise = first.resolve(input())
    let request!: ReviewModelRequest
    const runner = vi.fn(async (value: ReviewModelRequest) => { request = value; return gate.promise })
    const paraphrase = second.resolve(input(diagnostic('two', 'Two concurrent writers race past the absent-key check.'), runner))
    const thirdRunner = matcher()
    const third = first.resolve(input(diagnostic('three', 'A race between first writers creates duplicate entries.'), thirdRunner))
    const id = await idPromise
    await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce())
    expect(thirdRunner).not.toHaveBeenCalled()
    expect(disk.rows()).toHaveLength(1)
    gate.resolve(reply(request))
    expect(await paraphrase).toBe(id)
    expect(await third).toBe(id)
    expect(disk.rows()).toHaveLength(1)
    expect(otherIo.read).not.toHaveBeenCalled()
    expect(otherIo.writeAtomic).not.toHaveBeenCalled()
    expect(request).toMatchObject({ execution: 'isolated', maxTurns: 1, tools: [] })
  })

  it('deduplicates concurrent identical first inserts without matching', async () => {
    const disk = storage(), owner = {}, runner = matcher()
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => createMechanismCatalog({ ...disk.io }, owner).resolve(input(diagnostic(`d-${i}`), runner))))
    expect(new Set(results).size).toBe(1)
    expect(disk.io.writeAtomic).toHaveBeenCalledOnce()
    expect(runner).not.toHaveBeenCalled()
  })

  it('creates a new identity for a distinct cause on the same line', async () => {
    const disk = storage(), catalog = createMechanismCatalog(disk.io, {})
    const original = await catalog.resolve(input())
    const next = diagnostic('other', 'An unescaped key is interpolated into SQL.')
    next.claim.trigger = 'An attacker supplies a quoted key.'
    const runner = matcher('distinct')
    const distinct = await catalog.resolve(input(next, runner))
    expect(distinct).not.toBe(original)
    expect(disk.rows()).toHaveLength(2)
    expect(await catalog.resolve(input(next))).toBe(distinct)
    expect(runner).toHaveBeenCalledOnce()
  })

  it.each(['targetKey', 'head', 'path', 'side', 'kind', 'span'] as const)('does not compare a different %s bucket or nonoverlapping span', async field => {
    const disk = storage(), catalog = createMechanismCatalog(disk.io, {})
    const original = await catalog.resolve(input())
    const next = input()
    if (field === 'targetKey' || field === 'head') next[field] = 'different'
    else if (field === 'kind') next.diagnostic.classification.kind = 'security'
    else if (field === 'side') next.diagnostic.anchor.side = 'before'
    else if (field === 'path') next.diagnostic.anchor.path = 'src/other.ts'
    else next.diagnostic.anchor.span = { start: 13, end: 13 }
    expect(await catalog.resolve(next)).not.toBe(original)
    expect(next.runner).not.toHaveBeenCalled()
  })

  it('treats touching spans and missing spans conservatively as candidates', async () => {
    const disk = storage(), catalog = createMechanismCatalog(disk.io, {})
    const id = await catalog.resolve(input())
    for (const span of [{ start: 12, end: 15 }, undefined]) {
      const next = input(diagnostic('overlap', 'Concurrent first writes race.'), matcher())
      next.diagnostic.anchor.span = span
      expect(await catalog.resolve(next)).toBe(id)
      expect(next.runner).toHaveBeenCalledOnce()
    }
  })

  it.each(['uncertain', 'interrupted', 'unknown-id', 'forged-quote', 'missing-current', 'missing-match', 'unknown-key', 'non-json', 'throw', 'distinct-match-id'])(
    'fails closed on %s and preserves durable rows', async mode => {
      const disk = storage(), catalog = createMechanismCatalog(disk.io, {})
      await catalog.resolve(input())
      const before = disk.bytes()
      const runner: ReviewModelRunner = async request => {
        if (mode === 'throw') throw new Error('transport-failed')
        if (mode === 'non-json') return { text: 'not json', interrupted: false }
        const result = reply(request, mode === 'uncertain' ? 'uncertain' : 'same')
        if (mode === 'interrupted') result.interrupted = true
        const data = JSON.parse(result.text)
        if (mode === 'unknown-id') data.matchId = crypto.randomUUID()
        if (mode === 'forged-quote') data.evidence[0].quote = 'a fabricated excerpt'
        if (mode === 'missing-current') data.evidence = [data.evidence[1], data.evidence[1]]
        if (mode === 'missing-match') data.evidence = [data.evidence[0], data.evidence[0]]
        if (mode === 'unknown-key') data.extra = 'untrusted content'
        if (mode === 'distinct-match-id') data.disposition = 'distinct'
        return { ...result, text: JSON.stringify(data) }
      }
      await expect(catalog.resolve(input(diagnostic('new', 'Paraphrased race explanation.'), runner))).rejects.toThrow(ERROR)
      expect(disk.bytes()).toBe(before)
      expect(disk.io.writeAtomic).toHaveBeenCalledOnce()
      expect(await catalog.resolve(input())).toBe(disk.rows()[0].id)
    },
  )

  it('requires distinct evidence for every candidate, not just one', async () => {
    const disk = storage(), catalog = createMechanismCatalog(disk.io, {})
    await catalog.resolve(input())
    await catalog.resolve(input(diagnostic('two', 'A key causes SQL injection.'), matcher('distinct')))
    const runner: ReviewModelRunner = async request => {
      const result = reply(request, 'distinct'), data = JSON.parse(result.text)
      data.evidence.pop()
      return { ...result, text: JSON.stringify(data) }
    }
    await expect(catalog.resolve(input(diagnostic('three', 'Another cause.'), runner))).rejects.toThrow(ERROR)
    expect(disk.rows()).toHaveLength(2)
  })

  it('accepts literal source evidence but not metadata or evidence belonging to other diagnostics', async () => {
    const disk = storage(), catalog = createMechanismCatalog(disk.io, {})
    const original = input()
    original.evidence.push({ ...original.evidence[0], diagnosticId: 'unrelated', excerpt: 'DO NOT STORE THIS' })
    const id = await catalog.resolve(original)
    expect(disk.bytes()).not.toContain('DO NOT STORE THIS')
    const runner: ReviewModelRunner = async request => {
      const result = reply(request), data = JSON.parse(result.text)
      data.evidence.forEach((row: { quote: string }) => { row.quote = 'await insert(key)' })
      return { ...result, text: JSON.stringify(data) }
    }
    expect(await catalog.resolve(input(diagnostic('new', 'Race at insertion.'), runner))).toBe(id)
  })

  it.each(['json', 'version', 'unknown-root', 'unknown-row', 'unknown-claim', 'duplicate', 'span', 'digest', 'too-many', 'too-large'])(
    'rejects malformed storage: %s without overwriting it', async mode => {
      const disk = storage()
      await createMechanismCatalog(disk.io, {}).resolve(input())
      const registry = JSON.parse(disk.bytes()!)
      if (mode === 'version') registry.version = 2
      if (mode === 'unknown-root') registry.extra = true
      if (mode === 'unknown-row') registry.rows[0].rawPrompt = 'unexpected'
      if (mode === 'unknown-claim') registry.rows[0].claim.extra = true
      if (mode === 'duplicate') registry.rows.push(registry.rows[0])
      if (mode === 'span') registry.rows[0].span.end = 0
      if (mode === 'digest') registry.rows[0].contentDigest = 'bad'
      if (mode === 'too-many') registry.rows = Array.from({ length: 2_001 }, () => ({ ...registry.rows[0], id: crypto.randomUUID() }))
      disk.seed(mode === 'json' ? '{' : mode === 'too-large' ? ' '.repeat(1_000_001) : JSON.stringify(registry))
      const before = disk.bytes()
      await expect(createMechanismCatalog(disk.io, {}).resolve(input())).rejects.toThrow(ERROR)
      expect(disk.bytes()).toBe(before)
      expect(disk.io.writeAtomic).toHaveBeenCalledOnce()
    },
  )

  it('truncates source to 4k but hashes full content so different tails still require matching', async () => {
    const disk = storage(), catalog = createMechanismCatalog(disk.io, {})
    const first = input()
    first.evidence[0].excerpt = 'x'.repeat(4_000) + 'tail one'
    const id = await catalog.resolve(first)
    expect(disk.rows()[0].evidence[0].excerpt).toHaveLength(4_000)
    const runner = matcher()
    const next = input(diagnostic('new'), runner)
    next.evidence[0].excerpt = 'x'.repeat(4_000) + 'tail two'
    expect(await catalog.resolve(next)).toBe(id)
    expect(runner).toHaveBeenCalledOnce()
  })

  it('does not persist late model results after cancellation and releases the owner queue', async () => {
    const disk = storage(), owner = {}, catalog = createMechanismCatalog(disk.io, owner)
    const id = await catalog.resolve(input())
    const controller = new AbortController(), gate = deferred<ReviewModelResult>()
    let request!: ReviewModelRequest
    const runner = vi.fn(async (value: ReviewModelRequest) => { request = value; return gate.promise })
    const pending = catalog.resolve({ ...input(diagnostic('new', 'A different mechanism.'), runner), signal: controller.signal })
    const rejection = expect(pending).rejects.toThrow(ERROR)
    await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce())
    controller.abort()
    await rejection
    expect(request.signal.aborted).toBe(true)
    expect(await createMechanismCatalog(disk.io, owner).resolve(input())).toBe(id)
    gate.resolve(reply(request, 'distinct'))
    await Promise.resolve()
    await Promise.resolve()
    expect(disk.rows()).toHaveLength(1)
    expect(disk.io.writeAtomic).toHaveBeenCalledOnce()
  })

  it('times out an uncooperative matcher at 15s with no late write', async () => {
    const disk = storage(), catalog = createMechanismCatalog(disk.io, {})
    await catalog.resolve(input())
    vi.useFakeTimers()
    const gate = deferred<ReviewModelResult>(), started = deferred<void>()
    let request!: ReviewModelRequest
    const runner = vi.fn(async (value: ReviewModelRequest) => { request = value; started.resolve(); return gate.promise })
    const pending = catalog.resolve(input(diagnostic('new', 'A different mechanism.'), runner))
    const rejection = expect(pending).rejects.toThrow(ERROR)
    await started.promise
    await vi.advanceTimersByTimeAsync(14_999)
    expect(request.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await rejection
    expect(request.signal.aborted).toBe(true)
    gate.resolve(reply(request, 'distinct'))
    await Promise.resolve()
    expect(disk.io.writeAtomic).toHaveBeenCalledOnce()
  })

  it('never starts reads for pre-cancelled work or writes after a cancelled read', async () => {
    const disk = storage(), controller = new AbortController()
    controller.abort()
    await expect(createMechanismCatalog(disk.io, {}).resolve({ ...input(), signal: controller.signal })).rejects.toThrow(ERROR)
    expect(disk.io.read).not.toHaveBeenCalled()
    const gate = deferred<string | null>(), second = new AbortController()
    disk.io.read = vi.fn(() => gate.promise)
    const pending = createMechanismCatalog(disk.io, {}).resolve({ ...input(), signal: second.signal })
    const rejection = expect(pending).rejects.toThrow(ERROR)
    await vi.waitFor(() => expect(disk.io.read).toHaveBeenCalledOnce())
    second.abort()
    gate.resolve(null)
    await rejection
    expect(disk.io.writeAtomic).not.toHaveBeenCalled()
  })

  it('fails closed at 2000 rows without evicting existing identities', async () => {
    const disk = storage()
    await createMechanismCatalog(disk.io, {}).resolve(input())
    const original = disk.rows()[0]
    const compact = { ...original, claim: { title: 't', explanation: 'e', trigger: 's' }, evidence: [] }
    disk.seed(JSON.stringify({ version: 1, rows: [original, ...Array.from({ length: 1_999 }, (_, i) => ({ ...compact, id: crypto.randomUUID(), targetKey: `target-${i}` }))] }))
    expect(new TextEncoder().encode(disk.bytes()!).length).toBeLessThan(1_000_000)
    const catalog = createMechanismCatalog(disk.io, {})
    expect(await catalog.resolve(input())).toBe(original.id)
    await expect(catalog.resolve({ ...input(), targetKey: 'new-target' })).rejects.toThrow(ERROR)
    expect(disk.rows()).toHaveLength(2_000)
    expect(disk.io.writeAtomic).toHaveBeenCalledOnce()
  })

  it('enforces the UTF-8 byte budget before persistence', async () => {
    const disk = storage()
    await createMechanismCatalog(disk.io, {}).resolve(input())
    const original = disk.rows()[0]
    const padded = { ...original, claim: { ...original.claim, explanation: '界'.repeat(16_000) } }
    const rows = Array.from({ length: 20 }, (_, i) => ({ ...padded, id: crypto.randomUUID(), targetKey: `padded-${i}` }))
    disk.seed(JSON.stringify({ version: 1, rows }))
    expect(new TextEncoder().encode(disk.bytes()!).length).toBeLessThan(1_000_000)
    const next = input(diagnostic('large', '界'.repeat(16_000)))
    await expect(createMechanismCatalog(disk.io, {}).resolve(next)).rejects.toThrow(ERROR)
    expect(disk.io.writeAtomic).toHaveBeenCalledOnce()
  })

  it('blocks rather than dropping candidates beyond the matcher budget', async () => {
    const disk = storage()
    await createMechanismCatalog(disk.io, {}).resolve(input())
    const original = disk.rows()[0]
    disk.seed(JSON.stringify({ version: 1, rows: Array.from({ length: 33 }, () => ({ ...original, id: crypto.randomUUID() })) }))
    const next = input(diagnostic('new', 'An unclassified cause.'), matcher('distinct'))
    await expect(createMechanismCatalog(disk.io, {}).resolve(next)).rejects.toThrow(ERROR)
    expect(next.runner).not.toHaveBeenCalled()
    expect(disk.io.writeAtomic).toHaveBeenCalledOnce()
  })

  it('recovers after an ambiguous atomic write by reading the durable row again', async () => {
    const disk = storage(), catalog = createMechanismCatalog(disk.io, {})
    const write = disk.io.writeAtomic
    disk.io.writeAtomic = vi.fn(async value => { await write(value); throw new Error('ack-lost') })
    await expect(catalog.resolve(input())).rejects.toThrow(ERROR)
    const id = disk.rows()[0].id
    disk.io.writeAtomic = write
    expect(await catalog.resolve(input())).toBe(id)
    expect(disk.rows()).toHaveLength(1)
  })
})
