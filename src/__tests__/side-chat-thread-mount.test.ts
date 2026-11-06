import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveComposerSendGate } from '../browser/webview/AssistantUiThread'
import { threadMount } from '../browser/webview/sideChat'
import {
  convertBrowserRuntimeStateToThreadMessages,
  isTurnAnchoredMessageId,
  sideChatCutForRow,
  sideChatCutForThreadRow,
} from '../browser/webview/assistantUiAdapter'
import type { BrowserRuntimeClientState } from '../browser/webview/BrowserRuntimeClient'
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

  it('a running row has no cut; the closing reply cuts at the end; any other row at itself', () => {
    expect(sideChatCutForRow('turn:3f2a:assistant', true)).toBeNull()
    expect(sideChatCutForRow('turn:3f2a:assistant', false)).toEqual({ cutUuid: undefined })
    expect(sideChatCutForRow('9c1d-row-uuid', false)).toEqual({ cutUuid: '9c1d-row-uuid' })
  })

  it('the streaming closing reply keeps its turn-anchored id, and has no cut until the turn ends', () => {
    const running = {
      status: 'submitting',
      snapshot: null,
      transcriptMessages: [
        { type: 'user', uuid: 'u-1', timestamp: '2026-04-03T12:00:00.000Z', message: { role: 'user', content: 'first' } },
        { type: 'assistant', uuid: 'a-1', timestamp: '2026-04-03T12:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
        { type: 'user', uuid: 'u-2', timestamp: '2026-04-03T12:00:02.000Z', message: { role: 'user', content: 'second' } },
      ],
      liveEvents: [
        { type: 'stream_request_start' },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'half an answer' } } },
      ],
      lastError: null,
      pendingPrompt: 'second',
      pendingPromptId: 'u-2',
    } as unknown as BrowserRuntimeClientState
    const rows = convertBrowserRuntimeStateToThreadMessages(running)
    const trailing = rows[rows.length - 1]! as { id: string; status?: { type: string } }
    expect(trailing.id).toBe('turn:u-2:assistant')
    expect(trailing.status?.type).toBe('running')
    expect(sideChatCutForThreadRow(rows, trailing.id)).toBeNull()
    expect(sideChatCutForThreadRow(rows, 'a-1')).toEqual({ cutUuid: 'a-1' })

    const idle = {
      ...running,
      status: 'idle',
      liveEvents: [],
      pendingPrompt: null,
      pendingPromptId: null,
      transcriptMessages: [
        ...running.transcriptMessages,
        { type: 'assistant', uuid: 'a-2', timestamp: '2026-04-03T12:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'half an answer, whole' }] } },
      ],
    } as unknown as BrowserRuntimeClientState
    const settled = convertBrowserRuntimeStateToThreadMessages(idle)
    const closing = settled[settled.length - 1]! as { id: string }
    expect(closing.id).toBe(trailing.id)
    expect(sideChatCutForThreadRow(settled, closing.id)).toEqual({ cutUuid: undefined })
    expect(sideChatCutForThreadRow(settled, 'not-a-row')).toBeNull()
  })

  it('the shell gate reads the session state through a ref, so the callback keeps its identity across stream updates', () => {
    const shell = readFileSync(join(__dirname, '..', 'browser', 'webview', 'MultiSessionShell.tsx'), 'utf8')
    const start = shell.indexOf('const handleStartSideChat = useMemo(')
    const handler = shell.slice(start, shell.indexOf('[forkSession', start) + 40)
    const actions = readFileSync(join(__dirname, '..', 'browser', 'webview', 'shellSelectionActions.ts'), 'utf8')
    const factoryStart = actions.indexOf('function createShellHandleStartSideChat(')
    const factory = actions.slice(factoryStart, actions.indexOf('\nexport function ', factoryStart + 1))
    expect(handler).toContain('createShellHandleStartSideChat(sessionStatesRef, forkSession)')
    expect(factory).toContain('sessionStatesRef.current.get(fromSessionId)')
    expect(handler).toMatch(/\[forkSession\],/)
    expect(handler).not.toContain('[forkSession, sessionStates]')
  })

  it('the toolbar button subscribes to the rows, so it re-enables when the reply ends', () => {
    const thread = readFileSync(join(__dirname, '..', 'components', 'assistant-ui', 'thread.tsx'), 'utf8')
    const button = thread.slice(thread.indexOf('const StartSideChatButton'), thread.indexOf('const ComposerQuote'))
    expect(button).toContain('useAssistantState((s) => s.thread.messages)')
    expect(button).toContain('sideChatCutForThreadRow(messages, currentRow)')
    expect(button).not.toContain(' disabled={streaming}')
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
