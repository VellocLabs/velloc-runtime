import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveComposerSendGate } from '../browser/webview/AssistantUiThread'
import { threadMount } from '../browser/webview/sideChat'
import { isTurnAnchoredMessageId } from '../browser/webview/assistantUiAdapter'
import type { AgentRuntimeWorkerSnapshot } from '../browser/worker/workerProtocol'

// A side chat's conversation in the pane is its own foreground session: a send
// from its composer passes the session gate although another session is the
// viewed one, and the pane thread carries none of the model, settings or
// folder controls. (F-36)

function snapshot(sessionId: string): AgentRuntimeWorkerSnapshot {
  return {
    initialized: true,
    sessionId,
    cwd: '/workspace',
    currentProviderId: 'demo',
    activeModelId: 'demo-model',
    currentSelection: { providerId: 'demo', modelId: 'demo-model' },
    modelCatalog: {
      providers: [
        { id: 'demo', name: 'Demo', enabled: true, models: [{ id: 'demo-model', name: 'Demo Model', enabled: true }] },
      ],
      defaultSelection: { providerId: 'demo', modelId: 'demo-model' },
    } as unknown as AgentRuntimeWorkerSnapshot['modelCatalog'],
    availableModels: ['demo-model'],
    toolNames: [],
    commandNames: [],
    messageCount: 1,
    isBusy: false,
    isStopping: false,
    pendingBridgeRequestIds: [],
  }
}

describe('the row a side chat is cut at', () => {
  it('the closing assistant row is turn-anchored, every other row is its uuid', () => {
    expect(isTurnAnchoredMessageId('turn:3f2a-user-uuid:assistant')).toBe(true)
    expect(isTurnAnchoredMessageId('3f2a-user-uuid')).toBe(false)
    expect(isTurnAnchoredMessageId('turn:3f2a:live-stream')).toBe(false)
  })
})

describe('a side chat mounted in the pane', () => {
  it('sends from its composer while its parent is the viewed session', () => {
    const mount = threadMount('side', true, 'parent')
    expect(
      resolveComposerSendGate({
        snapshot: snapshot('side'),
        activeSessionId: mount.foregroundSessionId,
        canAdoptDefault: false,
      }),
    ).toEqual({ kind: 'send' })
  })

  it('in the chat slot, a hidden session still refuses a send meant for the viewed one', () => {
    const mount = threadMount('hidden', false, 'viewed')
    expect(
      resolveComposerSendGate({
        snapshot: snapshot('hidden'),
        activeSessionId: mount.foregroundSessionId,
        canAdoptDefault: false,
      }),
    ).toEqual({ kind: 'wrong-session' })
    expect(threadMount('viewed', false, 'viewed').lightControls).toBe(false)
  })

  it('carries light controls: no model, settings or folder control reaches the pane thread', () => {
    expect(threadMount('side', true, 'parent').lightControls).toBe(true)
    const shell = readFileSync(join(__dirname, '..', 'browser', 'webview', 'MultiSessionShell.tsx'), 'utf8')
    const start = shell.indexOf('const renderSessionThread = (')
    const end = shell.indexOf('<ThreadErrorBoundary', start)
    const block = shell.slice(start, shell.indexOf('</ThreadErrorBoundary>', end))
    expect(block).toContain('activeSessionId={mount.foregroundSessionId}')
    for (const prop of [
      'openSettings',
      'onSelectSessionModel',
      'onSelectProjectFolder',
      'onOpenProjectFolder',
      'onRevealProjectFolder',
    ]) {
      expect(block).toContain(`${prop}={mount.lightControls ? undefined : `)
    }
  })
})
