/**
 * `session.open` → the worker init payload, built by the runtime (F-24).
 * The rules a remote client relies on, and the regressions
 * the page used to guard when it built the payload itself.
 */
import { describe, expect, it } from 'vitest'
import { composeSessionInit } from '../browser/worker/sessionOpenComposer'
import type { AgentRuntimeWorkerInitPayload } from '../browser/worker/workerProtocol'

const HOST = { cwd: '/nexus', locale: 'en', hostMode: 'nexus', templateType: 'agent' } as const

function compose(input: Partial<Parameters<typeof composeSessionInit>[0]> & { open: Parameters<typeof composeSessionInit>[0]['open'] }) {
  return composeSessionInit({ hostEnvironment: HOST as never, lastInitTemplate: null, ...input })
}

describe('composeSessionInit', () => {
  it('builds from the published host environment and the per-session answers', () => {
    const result = compose({
      open: { sessionId: 's1', templateType: 'chat', selection: { providerId: 'p', modelId: 'm', thinkingTier: 'high' }, restored: true },
    })
    expect(result.payload).toEqual({
      ...HOST,
      sessionId: 's1',
      templateType: 'chat',
      userSpecifiedProviderId: 'p',
      userSpecifiedModel: 'm',
      userSpecifiedThinkingTier: 'high',
      restoredSessionId: true,
    })
    expect(result.payload && 'needsLastFolderFor' in result ? result.needsLastFolderFor : 'x').toBeNull()
  })

  it("never leaks another session's id, folder or flags from the last UI init", () => {
    const lastInitTemplate = {
      cwd: '/nexus',
      sessionId: 'someone-else',
      projectRoot: '/their/repo',
      restoredSessionId: true,
      forceReinit: true,
      traceId: 't-old',
      templateType: 'agent',
    } as AgentRuntimeWorkerInitPayload
    const result = compose({ hostEnvironment: null, lastInitTemplate, open: { sessionId: 'mine' } })
    expect(result.payload).toEqual({ cwd: '/nexus', templateType: 'agent', sessionId: 'mine' })
  })

  it('with nothing to build from there is no payload, and a reason', () => {
    const result = compose({ hostEnvironment: null, open: { sessionId: 's1' } })
    expect(result.payload).toBeNull()
  })

  it("the desktop's own init fields layer over the host environment", () => {
    const result = compose({
      open: {
        sessionId: 's1',
        init: { cwd: '/nexus', locale: 'de', initialModelCatalog: null, sessionId: 'ignored', traceId: 't1', forceReinit: true },
      },
    })
    expect(result.payload).toMatchObject({ locale: 'de', sessionId: 's1', traceId: 't1', forceReinit: true })
  })

  describe('the folder', () => {
    it('an explicit folder wins, then the persisted binding; neither asks for the last folder', () => {
      expect(compose({ open: { sessionId: 's', templateType: 'code', projectRoot: '/explicit' }, persisted: { projectRoot: '/persisted' } }))
        .toMatchObject({ payload: { projectRoot: '/explicit' }, needsLastFolderFor: null })
      expect(compose({ open: { sessionId: 's', templateType: 'code' }, persisted: { projectRoot: '/persisted' } }))
        .toMatchObject({ payload: { projectRoot: '/persisted' }, needsLastFolderFor: null })
    })

    it('a forced-folder session with no folder inherits the last folder of ITS type', () => {
      expect(compose({ open: { sessionId: 's', templateType: 'code' } })).toMatchObject({ needsLastFolderFor: 'code' })
      expect(compose({ open: { sessionId: 's', templateType: 'safe_code' } })).toMatchObject({ needsLastFolderFor: 'safe_code' })
    })

    // Regression (the "agent session opened blank" bug): only a forced-folder
    // type may inherit a folder. An agent/chat session inheriting one was routed
    // into that folder's project dir and wrote an empty stub there while its
    // real transcript stayed in shared-workspace/<type>.
    it('an agent, a chat, or an untyped session never inherits a folder', () => {
      for (const templateType of ['agent', 'chat', undefined]) {
        const result = compose({ hostEnvironment: { cwd: '/nexus' } as never, open: { sessionId: 's', ...(templateType ? { templateType } : {}) } })
        expect(result).toMatchObject({ needsLastFolderFor: null })
        expect(result.payload).not.toHaveProperty('projectRoot')
      }
    })

    it('an explicitly bound non-code session keeps its folder (a deliberate bind)', () => {
      expect(compose({ open: { sessionId: 's', templateType: 'agent', projectRoot: '/bound' } }))
        .toMatchObject({ payload: { projectRoot: '/bound' }, needsLastFolderFor: null })
    })

    it('the persisted template decides when the open names none (a restored boot pointer)', () => {
      expect(compose({ open: { sessionId: 's' }, persisted: { templateType: 'code' } }))
        .toMatchObject({ payload: { templateType: 'code' }, needsLastFolderFor: 'code' })
    })
  })
})
