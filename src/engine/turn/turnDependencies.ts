/**
 * The engine's outside dependencies, assembled with defaults.
 *
 * `assembleTurnDependencies` returns a complete `QueryRuntimeDeps`: every
 * default below, with any `overrides` laid over it field by field. The model
 * call is the bridge transport when one is supplied and a placeholder
 * otherwise; an explicit `callModel` override wins over both.
 */
import type { RuntimeConfig } from '../../runtime/interfaces/RuntimeConfig'
import type { QueryRuntimeDeps } from '../../runtime/interfaces/QueryRuntimeDeps'
import { createBrowserToolMicrocompact } from '../../context/compaction/browserObservationTrim'
import {
  MSG_TYPE_ASSISTANT,
  ROLE_ASSISTANT,
  PART_TEXT,
} from '../../runtime/VercelModelConstants'
import { createTimestamp, createUUID } from './runtimeIds'
import type { ModelTransportOptions } from './modelTrace'
import { bridgeModelTransport } from './modelTransport'
import { createStopHandler } from './stopHandling'

export type { QueryRuntimeDeps } from '../../runtime/interfaces/QueryRuntimeDeps'

/** Answers every call with a fixed note; used when no bridge is wired. */
function placeholderModelTransport(
  runtimeConfig?: RuntimeConfig,
): QueryRuntimeDeps['callModel'] {
  return async function* callModel(params) {
    yield {
      type: MSG_TYPE_ASSISTANT,
      uuid: createUUID(runtimeConfig),
      timestamp: createTimestamp(runtimeConfig),
      message: {
        role: ROLE_ASSISTANT,
        content: [
          {
            type: PART_TEXT,
            text:
              'No model transport is connected: the engine ran without a bridge, so this reply is a placeholder.',
          },
        ],
        model: params.callContext.options.mainLoopModel,
      },
    }
  }
}

export function assembleTurnDependencies(
  runtimeConfig?: RuntimeConfig,
  overrides: Partial<QueryRuntimeDeps> = {},
  modelTransport?: ModelTransportOptions,
): QueryRuntimeDeps {
  const callModel = overrides.callModel
    ?? (modelTransport?.bridgeTransport
      ? bridgeModelTransport(
          modelTransport.bridgeTransport,
          modelTransport.runtimeConfig ?? runtimeConfig,
          modelTransport.traceLogger,
        )
      : placeholderModelTransport(runtimeConfig))

  // Stop handling reports through the caller's logger when one is given.
  const logEvent: QueryRuntimeDeps['logEvent'] = overrides.logEvent ?? (() => {})

  const defaults: QueryRuntimeDeps = {
    callModel,
    // Observation trimming is on by default; pass a no-op to turn it off.
    microcompact: createBrowserToolMicrocompact(),
    async autocompact() {
      return {}
    },
    uuid() {
      return createUUID(runtimeConfig)
    },
    runTurnEndHooks: createStopHandler(logEvent),
    async *getQueuedAttachments(params) {
      if (!modelTransport?.queuedAttachmentProvider) return
      yield* modelTransport.queuedAttachmentProvider(params)
    },
    async createToolUseSummary() {
      return null
    },
    logEvent() {},
    getRuntimeGatesSnapshot() {
      return {
        emitToolUseSummaries: false,
        enableQueuedAttachments: true,
      }
    },
  }

  return { ...defaults, ...overrides }
}
