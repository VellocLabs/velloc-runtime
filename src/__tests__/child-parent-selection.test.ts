import { afterEach, describe, expect, it } from 'vitest'
import { SharedWorkerSessionManager } from '../browser/worker/SharedWorkerSessionManager'
import type { AgentRuntimeWorkerHandle } from '../browser/worker/AgentRuntimeWorkerHandle'
import type { BrowserLlmSelection } from '../browser/bridge/protocol/nexus_llm'
import { getParentSelection, setParentSelectionGetter, getParentPermissionMode, setParentPermissionModeGetter } from '../sessions/childSessionSpawner'

afterEach(() => {
  setParentSelectionGetter(null)
  setParentPermissionModeGetter(null)
})

describe('child parent selection seam', () => {
  it('reads live permission modes per parent, with no fallback to cached or missing state', () => {
    setParentPermissionModeGetter(null)
    expect(getParentPermissionMode('one')).toBeNull()
    const manager = new SharedWorkerSessionManager({ createWorker: () => ({}) as AgentRuntimeWorkerHandle })
    const internals = manager as unknown as { sessions: Map<string, unknown> }
    let mode: string | undefined = 'bypassPermissions'
    internals.sessions.set('one', { permissionMode: 'bypassPermissions', worker: { getSnapshot: () => ({ currentPermissionMode: mode }) } })
    internals.sessions.set('two', { worker: { getSnapshot: () => ({ currentPermissionMode: 'acceptEdits' }) } })
    expect(getParentPermissionMode('one')).toBe('bypassPermissions')
    mode = 'plan'
    expect(getParentPermissionMode('one')).toBe('plan')
    expect(getParentPermissionMode('two')).toBe('acceptEdits')
    mode = undefined
    expect(getParentPermissionMode('one')).toBeNull()
    expect(getParentPermissionMode('missing')).toBeNull()
  })

  it('returns null without a registered runtime', () => {
    setParentSelectionGetter(null)
    expect(getParentSelection('missing')).toBeNull()
  })

  it('reads each live worker snapshot rather than the cached entry or latest UI init', () => {
    const manager = new SharedWorkerSessionManager({
      createWorker: () => ({}) as AgentRuntimeWorkerHandle,
    })
    const internals = manager as unknown as {
      sessions: Map<string, unknown>
      lastInitTemplate: unknown
    }
    const stale = { providerId: 'stale-provider', modelId: 'stale-model', thinkingTier: 'stale-tier' }
    let first: BrowserLlmSelection | null = { providerId: 'p1', modelId: 'm1', thinkingTier: 'high' }
    const second = { providerId: 'p2', modelId: 'm2', thinkingTier: 'low' }
    internals.lastInitTemplate = {
      userSpecifiedProviderId: stale.providerId,
      userSpecifiedModel: stale.modelId,
      userSpecifiedThinkingTier: stale.thinkingTier,
    }
    internals.sessions.set('one', { model: stale, worker: { getSnapshot: () => ({ currentSelection: first }) } })
    internals.sessions.set('two', { model: stale, worker: { getSnapshot: () => ({ currentSelection: second }) } })
    expect(getParentSelection('one')).toEqual(first)
    expect(getParentSelection('two')).toEqual(second)
    first = { providerId: 'p3', modelId: 'm3' }
    expect(getParentSelection('one')).toEqual(first)
    expect(getParentSelection('two')).toEqual(second)
    first = null
    expect(getParentSelection('one')).toBeNull()
    expect(getParentSelection('absent')).toBeNull()
  })

  it('returns a detached selection so validation cannot mutate the worker snapshot', () => {
    const live = { providerId: 'provider', modelId: 'model', thinkingTier: 'high' }
    setParentSelectionGetter(() => live)
    const read = getParentSelection('parent')!
    read.modelId = 'different'
    expect(getParentSelection('parent')).toEqual(live)
    expect(live.modelId).toBe('model')
  })
})
