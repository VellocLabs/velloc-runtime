import { describe, expect, it, vi } from 'vitest'
import { reassessExternalEdit, validateReassessmentUpdates, type ReassessmentInput } from './reassessment'
import type { ReportSnapshot } from './report-store'
import { declareTool } from '../toolkit/toolContract'

function fixture() {
  const snapshot = { run: { id: 'run' }, retainedIds: ['finding'], diagnostics: [{ id: 'finding', runId: 'run', anchor: { path: 'src/a.ts', revision: 'old', side: 'working-copy' },
    claim: { title: 'Missing guard', explanation: 'An absent value reaches read and throws', trigger: 'The optional input is absent' }, evidenceKeys: ['evidence'] }],
    assessments: [{ diagnosticId: 'finding', rationale: 'Caller supplies undefined' }], evidence: [{ diagnosticId: 'finding', source: { path: 'src/a.ts', revision: 'old' }, excerpt: 'read(value)' }] } as unknown as ReportSnapshot
  const mutation = { ref: 'native-edit', paths: ['src/a.ts'] }
  const evidence = [{ path: 'src/a.ts', revision: 'current', excerpt: 'if (!value) return; read(value)' }]
  const update = { diagnosticId: 'finding', outcome: 'resolved' as const, explanation: 'Guard stops absent input before the read', mutationRefs: ['native-edit'], evidence: [{ path: 'src/a.ts', quote: 'if (!value) return;', relevance: 'Early return prevents the original failing call' }] }
  const input: ReassessmentInput = { snapshot, mutations: [mutation], evidence, tools: [], signal: new AbortController().signal,
    runner: vi.fn(async () => ({ text: JSON.stringify({ updates: [update] }), interrupted: false })) }
  return { input, update }
}

describe('ordinary edit semantic reassessment', () => {
  it('uses all saved semantics, fresh evidence, bounded turns, and no mutating tools', async () => {
    const { input, update } = fixture()
    const read = declareTool({ name: 'Read', description: async () => '', readsOnly: () => true, call: async () => ({ data: '' }) })
    input.tools = [read, declareTool({ ...read, name: 'Write' }), declareTool({ ...read, name: 'Bash' })]
    expect(await reassessExternalEdit(input)).toEqual([update])
    const request = vi.mocked(input.runner).mock.calls[0][0]
    expect(request.tools.map(tool => tool.name)).toEqual(['Read'])
    expect(request.maxTurns).toBe(4)
    const prompt = request.blocks.map(block => block.text).join('\n')
    expect(prompt).toContain('An absent value reaches read and throws')
    expect(prompt).toContain('Caller supplies undefined')
    expect(prompt).toContain('removed keyword')
    expect(prompt).toContain('original faulty mechanism')
    expect(request.blocks[1].provenance).toBe('repository-material')
  })

  it('does not reassess unrelated paths or resolve an unrelated same-file edit', async () => {
    const { input, update } = fixture()
    input.mutations = [{ ref: 'native-edit', paths: ['src/other.ts'] }]
    expect(await reassessExternalEdit(input)).toEqual([])
    expect(input.runner).not.toHaveBeenCalled()
    input.mutations = [{ ref: 'native-edit', paths: ['src/a.ts'] }]
    input.evidence = [{ path: 'src/a.ts', revision: 'current', excerpt: 'const renamed = value; read(renamed)' }]
    input.runner = vi.fn(async () => ({ text: JSON.stringify({ updates: [{ ...update, outcome: 'still-present', explanation: 'Renaming does not guard absent values', evidence: [{ path: 'src/a.ts', quote: 'read(renamed)', relevance: 'Same unguarded mechanism' }] }] }), interrupted: false }))
    expect((await reassessExternalEdit(input))[0].outcome).toBe('still-present')
  })

  it('reassesses a changed recorded caller but requires proof on that changed dependency', async () => {
    const { input, update } = fixture()
    input.snapshot.evidence = [{ id: 'caller-evidence', runId: 'run', diagnosticId: 'finding', source: { path: 'src/caller.ts', revision: 'old' }, excerpt: 'read(value)', reason: 'Caller passes optional input without checking' }]
    input.mutations = [{ ref: 'native-edit', paths: ['src/caller.ts'] }]
    input.evidence = [
      { path: 'src/caller.ts', revision: 'current-caller', excerpt: 'if (!value) return; read(value)' },
      { path: 'src/a.ts', revision: 'unchanged-anchor', excerpt: 'return value.name' },
    ]
    const proposal = { ...update, explanation: 'The caller now excludes absent inputs before invoking the unchanged callee', evidence: [{ path: 'src/caller.ts', quote: 'if (!value) return;', relevance: 'Corrects the recorded caller trigger' }] }
    input.runner = vi.fn(async () => ({ text: JSON.stringify({ updates: [proposal] }), interrupted: false }))
    expect(await reassessExternalEdit(input)).toEqual([proposal])
    expect(input.runner).toHaveBeenCalledTimes(1)
    const validate = (value: unknown) => validateReassessmentUpdates(input.snapshot, input.mutations, input.evidence, [value])
    expect(() => validate({ ...proposal, evidence: [{ path: 'src/a.ts', quote: 'return value.name', relevance: 'Unchanged callee alone cannot establish a caller fix' }] })).toThrow('invalid-reassessment')
    expect(() => validate({ ...proposal, mutationRefs: ['forged-caller-edit'] })).toThrow('invalid-reassessment')
    input.mutations = [{ ref: 'native-edit', paths: ['src/unrelated.ts'] }]
    expect(await reassessExternalEdit(input)).toEqual([])
    expect(input.runner).toHaveBeenCalledTimes(1)
    expect(() => validate(proposal)).toThrow('invalid-reassessment')
  })

  it('rejects forged IDs, mutation references, evidence and schema fields', () => {
    const { input, update } = fixture()
    const bad = [
      { ...update, diagnosticId: 'foreign' }, { ...update, mutationRefs: ['model-says-edited'] },
      { ...update, mutationRefs: [] }, { ...update, evidence: [] },
      { ...update, evidence: [{ ...update.evidence[0], quote: '' }] },
      { ...update, evidence: [{ ...update.evidence[0], quote: 'invented code' }] },
      { ...update, evidence: [{ ...update.evidence[0], path: 'other.ts' }] },
      { ...update, verification: 'passed' }, { ...update, outcome: 'edited' },
    ]
    for (const proposal of bad) expect(() => validateReassessmentUpdates(input.snapshot, input.mutations, input.evidence, [proposal])).toThrow('invalid-reassessment')
    expect(() => validateReassessmentUpdates(input.snapshot, input.mutations, input.evidence, [update, update])).toThrow('invalid-reassessment')
  })

  it('retains explicit uncertainty and does not turn missing output into success', async () => {
    const { input, update } = fixture()
    input.runner = async () => ({ text: JSON.stringify({ updates: [{ ...update, outcome: 'unknown', explanation: 'Caller is unavailable', mutationRefs: [], evidence: [] }] }), interrupted: false })
    expect((await reassessExternalEdit(input))[0].outcome).toBe('unknown')
    input.runner = async () => ({ text: '{"updates":[]}', interrupted: false })
    expect(await reassessExternalEdit(input)).toEqual([])
  })

  it('rejects interruptions, malformed JSON and timed-out model results', async () => {
    const { input, update } = fixture()
    input.runner = async () => ({ text: JSON.stringify({ updates: [update] }), interrupted: true })
    await expect(reassessExternalEdit(input)).rejects.toThrow('reassessment-interrupted')
    input.runner = async () => ({ text: 'resolved!', interrupted: false })
    await expect(reassessExternalEdit(input)).rejects.toThrow()
    input.runner = () => new Promise(() => {})
    await expect(reassessExternalEdit({ ...input, timeoutMs: 1 })).rejects.toThrow('reassessment-interrupted')
    const controller = new AbortController()
    controller.abort()
    await expect(reassessExternalEdit({ ...input, signal: controller.signal })).rejects.toThrow('reassessment-interrupted')
  })
})
