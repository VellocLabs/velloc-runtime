import { describe, it, expect, vi } from 'vitest'
import { LocalReviewService, scopeIndex, reviewMaterial } from './service'
import type { ReviewModelRequest, ReviewModelResult } from './runner'
import type { ScopeManifest } from './scope'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { Message } from '../runtime/RuntimeTypes'

vi.mock('../backgroundTasks/sideTaskSink', () => ({ lookupForkTaskId: (agentId: string) => agentId === 'agent-1' ? 'f-1' : undefined }))

const patch = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n context\n'
function setup() {
  const storage = new Map<string, string>()
  const manifest: ScopeManifest = { scope: { kind: 'workspace', workspaceKey: '/repo', repository: { projectKey: '/repo' }, revision: { base: 'a', head: 'b', workingCopyDigest: 'w' }, pathFilter: [] },
    files: [{ path: 'src/a.ts', status: 'included', patch, anchors: [] }, { path: 'src/skip.test.ts', status: 'skipped', patch: '', anchors: [] }], anchors: [], status: 'reviewable', complete: true, notices: [], baseSource: 'main', semantics: 'working-copy' }
  const invoke = async (request: ReviewModelRequest, name: string, input: Record<string, unknown>) => {
    const tool = request.tools.find(t => t.name === name)!
    return tool.call(input, {} as ToolCallContext, () => ({ behavior: 'allow' }), { uuid: crypto.randomUUID() } as Message)
  }
  const runModel = vi.fn(async (request: ReviewModelRequest): Promise<ReviewModelResult> => {
    const plan = JSON.parse(request.blocks.find(b => b.source === 'resolved-policy')!.text)
    const coverage = { angles: plan.angles, limitations: [], complete: true }
    request.observer?.started({ key: request.taskId, agentId: 'agent-1', role: request.role ?? 'coordinator', label: request.label ?? '' })
    request.observer?.activity({ key: request.taskId, action: 'ReviewRead diff src/a.ts' })
    await invoke(request, 'ReviewLedger', { operation: 'coverage', coverage })
    request.observer?.ended({ key: request.taskId, end: { kind: 'completed' } })
    return { text: JSON.stringify({ candidates: [], coverage }), interrupted: false, end: { kind: 'completed' as const } }
  })
  const service = new LocalReviewService({ conversationKey: 'session', modelId: 'claude-opus-5-5',
    capabilities: { agentAvailable: true, agentPermitted: true, remainingDepth: 2, outputToolAvailable: true },
    preferences: { load: async () => ({}), save: async () => {} }, storage: { listRunIds: async () => [...storage.keys()], load: async id => storage.get(id) ?? null, save: async (id, value) => { storage.set(id, value) } },
    sanitizeExcerpt: text => text, resolveScope: async () => ({ manifest, trustedGuidance: '', read: vi.fn() }), runModel })
  return { service, runModel, manifest }
}

describe('review runs as an observable task tree', () => {
  it('projects the coordinator task with its drawer handle, activity and end', async () => {
    const h = setup()
    const { runId } = await h.service.startUser('medium')
    await h.service.wait(runId)
    const tree = h.service.tasks(runId)!
    expect(tree.tasks).toEqual([expect.objectContaining({ key: runId, taskId: 'f-1', role: 'coordinator', status: 'finished', lastAction: 'ReviewRead diff src/a.ts', end: { kind: 'completed' } })])
    expect(tree.tasks[0]).not.toHaveProperty('label')
    expect(tree.end).toBeUndefined()
    expect(h.runModel.mock.calls[0][0].role).toBe('coordinator')
  })
  it.each([
    ['step-limit', 'review-step-limit'], ['model-error', 'review-model-error'], ['context-overflow', 'review-context-overflow'], ['crash', 'review-crash'],
  ] as const)('records a %s end as the exact limitation and a partial run', async (kind, code) => {
    const h = setup()
    h.runModel.mockImplementationOnce(async request => {
      request.observer?.started({ key: request.taskId, agentId: 'agent-2', role: 'coordinator', label: '' })
      request.observer?.ended({ key: request.taskId, end: { kind } })
      return { text: '', interrupted: true, end: { kind } }
    })
    const { runId } = await h.service.startUser('medium')
    const snapshot = await h.service.wait(runId)
    expect(snapshot.run.progress.status).toBe('partial')
    expect(snapshot.coverage.limitations).toContain(code)
    const tree = h.service.tasks(runId)!
    expect(tree.end).toEqual({ kind })
    expect(tree.tasks[0]).toMatchObject({ status: 'failed', end: { kind } })
    expect(tree.tasks[0]).not.toHaveProperty('taskId')
    expect(h.runModel).toHaveBeenCalledTimes(1)
  })
  it('cancels the whole run when the coordinator task itself is stopped', async () => {
    const h = setup()
    let runSignal: AbortSignal | undefined
    h.runModel.mockImplementationOnce(async request => {
      runSignal = request.signal
      request.observer?.started({ key: request.taskId, agentId: 'agent-1', role: 'coordinator' })
      request.onStop?.()
      request.observer?.ended({ key: request.taskId, end: { kind: 'cancelled' } })
      return { text: '', interrupted: true, end: { kind: 'cancelled' } }
    })
    const { runId } = await h.service.startUser('medium')
    const snapshot = await h.service.wait(runId)
    expect(runSignal?.aborted).toBe(true)
    expect(snapshot.run.progress.status).toBe('cancelled')
  })
  it('reads an interrupted result without an end as a crash', async () => {
    const h = setup()
    h.runModel.mockImplementationOnce(async () => ({ text: '', interrupted: true }))
    const { runId } = await h.service.startUser('medium')
    expect((await h.service.wait(runId)).coverage.limitations).toContain('review-crash')
  })
  it('opens the coordinator with the scope index, never the patches', async () => {
    const h = setup()
    const { runId } = await h.service.startUser('medium')
    await h.service.wait(runId)
    const block = h.runModel.mock.calls[0][0].blocks.find(b => b.source === 'scope-manifest')!
    expect(block.text).not.toContain('+new')
    expect(JSON.parse(block.text).files).toEqual([
      expect.objectContaining({ path: 'src/a.ts', status: 'included', hunks: 1, added: 2, removed: 1 }),
      expect.objectContaining({ path: 'src/skip.test.ts', status: 'skipped', hunks: 0, added: 0, removed: 0 }),
    ])
    expect(JSON.parse(block.text).files[0]).not.toHaveProperty('patch')
  })
})

describe('worker material', () => {
  const manifest = setup().manifest
  it('lists each anchor once, under its file, as key, side and span', () => {
    const anchor = { anchorKey: 'k1', path: 'src/a.ts', revision: 'r'.repeat(40), side: 'after' as const, span: { start: 1, end: 2 }, contextDigest: 'd'.repeat(64) }
    const moved = { ...anchor, anchorKey: 'k2', path: 'src/old.ts', side: 'before' as const }
    const value = { ...manifest, anchors: [anchor, moved], files: manifest.files.map((file, index) => index ? file : { ...file, anchors: [anchor, moved] }) } as typeof manifest
    const index = scopeIndex(value) as { anchors?: unknown; files: Array<{ anchors: unknown[] }> }
    expect(index.anchors).toBeUndefined()
    expect(index.files[0]!.anchors).toEqual([
      { anchorKey: 'k1', side: 'after', span: { start: 1, end: 2 } },
      { anchorKey: 'k2', path: 'src/old.ts', side: 'before', span: { start: 1, end: 2 } },
    ])
  })
  it('indexes without patches and selects included patches by path', () => {
    expect(JSON.stringify(scopeIndex(manifest))).not.toContain('+new')
    expect(JSON.parse(reviewMaterial(manifest))).toEqual([{ path: 'src/a.ts', beforePath: undefined, patch, sources: [] }])
    expect(JSON.parse(reviewMaterial(manifest, ['src/skip.test.ts']))).toEqual([])
    expect(JSON.parse(reviewMaterial(manifest, ['src/a.ts']))).toHaveLength(1)
  })
  it('selects a renamed file by its pre-rename path', () => {
    const renamed: ScopeManifest = { ...manifest, files: [{ path: 'src/new.ts', beforePath: 'src/old.ts', status: 'included', patch, anchors: [] }] }
    expect(JSON.parse(reviewMaterial(renamed, ['src/old.ts']))).toEqual([{ path: 'src/new.ts', beforePath: 'src/old.ts', patch, sources: [] }])
  })
})
