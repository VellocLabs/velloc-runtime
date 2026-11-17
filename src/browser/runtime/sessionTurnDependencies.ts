import type { BrowserRuntimeConfig } from '../../config/BrowserRuntimeConfig'
import { createBrowserToolMicrocompact } from '../../context/compaction/browserObservationTrim'
import {
  createBrowserAutoCompact,
  performCompaction,
} from '../../context/compaction/autoTrigger'
import type { AutoCompactWindowSettings } from '../../context/compaction/windowSettings'
import { assembleTurnDependencies } from '../../engine/turn/turnDependencies'
import { collectQueuedAttachmentMessages } from '../../messages/contextAttachments'
import { createGeneratedUserMessage } from '../../messages/messageFactories'
import type { AppSurfaceHost } from '../../mods/app/appSurfaceHost'
import type { Message } from '../../runtime/RuntimeTypes'
import type { BrowserConversationStore } from '../../sessions/sessionStore'
import { createA2uiTurnEndCheck } from '../../toolkit/builtin/a2ui/express/a2uiReplyCheck'
import type { CreateBrowserRuntimeOptions } from './createAgentRuntimeOptions'

const metaNote = (text: string): Message => createGeneratedUserMessage(text, { isMeta: true })

export type SessionTurnDependenciesInput = {
  options: CreateBrowserRuntimeOptions
  resolvedOptions: CreateBrowserRuntimeOptions & { sessionId: string }
  runtimeConfig: BrowserRuntimeConfig
  autoCompactWindows: AutoCompactWindowSettings
  resolvedSessionId: string
  conversationStore: BrowserConversationStore
  appSurface: Pick<AppSurfaceHost, 'wrapTurnEndCheck'> | undefined
  takeModFaults: NonNullable<Parameters<typeof collectQueuedAttachmentMessages>[0]['takeModFaults']>
}

/** The session's turn dependencies: compaction (automatic and `/compact`), queued attachments, the turn-end check. */
export function assembleSessionTurnDependencies({
  options,
  resolvedOptions,
  runtimeConfig,
  autoCompactWindows,
  resolvedSessionId,
  conversationStore,
  appSurface,
  takeModFaults,
}: SessionTurnDependenciesInput) {
  return assembleTurnDependencies(
    runtimeConfig,
    {
      microcompact: createBrowserToolMicrocompact(
        options.hostManifest?.compactableToolNames,
      ),
      // Forward the per-engine `messageCompaction` override so the
      // autocompact closure sees the same thresholds the QueryEngine
      // does. Without this, autocompact construction binds the
      // hard-coded defaults (25 steps / 40K chars) and any override
      // passed via `BrowserRuntimeOptions.agentLoopSettings` is
      // silently ignored — that's the bug the e2e compaction test
      // surfaced.
      autocompact: createBrowserAutoCompact(
        options.bridgeTransport,
        runtimeConfig,
        options.agentLoopSettings?.messageCompaction,
        autoCompactWindows,
      ),
      autoCompactWindows,
      // User-triggered `/compact [instructions]`. Bypasses the
      // step-cadence and char-floor gates that `autocompact` runs
      // (those gates are for the per-turn auto-trigger, not the
      // user's explicit ask). Shares `performCompaction` with the
      // auto path so the wire shape and summary format stay
      // identical.
      forceCompact: async ({ messages, mainLoopModel, customInstructions, providerId }) => {
        return performCompaction({
          messages,
          bridgeTransport: options.bridgeTransport,
          runtimeConfig,
          mainLoopModel,
          providerId,
          trigger: 'manual',
          customInstructions,
          requester: {
            sessionId: resolvedSessionId,
            spawnerSessionId: (resolvedOptions as { spawnerSessionId?: string }).spawnerSessionId,
          },
        })
      },
      async saveStrippedResults(strippedResults) {
        for (const [toolCallId, compactContent] of strippedResults) {
          await conversationStore.promoteToolCallDetailToOrigin(toolCallId, compactContent)
        }
      },
    },
    {
      bridgeTransport: options.bridgeTransport,
      runtimeConfig,
      traceLogger: options.traceLogger,
      turnEndCheck: appSurface
        ? appSurface.wrapTurnEndCheck(createA2uiTurnEndCheck(metaNote), metaNote)
        : createA2uiTurnEndCheck(metaNote),
      queuedAttachmentProvider: params =>
        collectQueuedAttachmentMessages({
          messages: params.messages,
          toolUseContext: params.toolUseContext,
          runtimeConfig,
          assistantMessages: params.assistantMessages,
          querySource: params.querySource,
          sessionId: resolvedOptions.sessionId,
          drainTaskNotifications: options.drainTaskNotifications,
          drainTeamMessages: options.drainTeamMessages,
          drainInjectMessages: options.drainInjectMessages,
          takeModFaults,
        }),
    },
  )
}
