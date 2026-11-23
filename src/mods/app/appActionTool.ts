/**
 * `AppAction` (F-40): the model's way to run one of the actions an app
 * declares, through the path a person's press takes to the app's script.
 * Security: only a name the manifest declares is offered to the script, and an
 * action the script does not finish is an error here, never a turn of its own.
 */

import { APP_ACTION_CONTEXT_MAX_BYTES } from '../../browser/runtimeProtocol/modApps'
import { declareTool, type ToolContract } from '../../toolkit/toolContract'
import type { AppActionOutcome } from './appActionBus'
import { APP_ACTION_TOOL_NAME } from './appToolNames'

export type AppActionToolInput = { action: string; context?: Record<string, unknown> }

export type AppActionToolOptions = {
  /** The manifest's `localActions`. */
  actions: readonly string[]
  /** Offers a declared action to the app's script. */
  run(action: string, context: unknown): Promise<AppActionOutcome>
}

const encoder = new TextEncoder()

const named = (actions: readonly string[]): string => actions.map(name => `\`${name}\``).join(', ')

/** The app block's line on `AppAction`; none for an app that declares no action. */
export function appActionPromptLine(actions: readonly string[]): string[] {
  if (actions.length === 0) return []
  return [
    `- The app's script answers these actions, the ones its controls raise: ${named(actions)}. Call ${APP_ACTION_TOOL_NAME} to run one yourself, as when you changed a file the script reads and it has to take the change in; the person then need not press anything. It returns what the script answered, or an error when the script did not take the action.`,
  ]
}

function failure(message: string): { data: string; isError: true } {
  return { data: message, isError: true }
}

/** The script's answer as the tool's text, cut at the size a context may have. */
function resultText(action: string, result: unknown): string {
  if (result === undefined) return `The app's script handled "${action}".`
  let json: string | undefined
  try {
    json = JSON.stringify(result)
  } catch {
    json = undefined
  }
  if (json === undefined) return `The app's script handled "${action}"; its answer is not JSON and is not shown.`
  if (encoder.encode(json).byteLength <= APP_ACTION_CONTEXT_MAX_BYTES) {
    return `The app's script handled "${action}" and answered:\n${json}`
  }
  // Cut the JSON at a byte boundary; slicing the string by code units would
  // leave a partial code point or overshoot the budget for multibyte text.
  let cut = APP_ACTION_CONTEXT_MAX_BYTES
  while (cut > 0 && encoder.encode(json.slice(0, cut)).byteLength > APP_ACTION_CONTEXT_MAX_BYTES) cut -= 1
  return `The app's script handled "${action}" and answered:\n${json.slice(0, cut)}… (cut)`
}

export function createAppActionTool(options: AppActionToolOptions): ToolContract<AppActionToolInput, string> {
  const { actions, run } = options
  return declareTool({
    name: APP_ACTION_TOOL_NAME,
    discoveryHint: "run one of this app's declared actions in its script",
    argsSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...actions], description: "One of the app's declared actions." },
        context: { type: 'object', description: 'What the action needs, as the control that raises it would send; omit when it needs nothing.' },
      },
      required: ['action'],
    },
    description: async () =>
      `Run one of this app's actions in its script, as a press on the app's page does, and return what the script answered. The app's actions: ${named(actions)}. Call it when the script has to act on something you did, such as a file you changed that it reads. An action the script does not take, or does not finish in time, is returned as an error.`,
    async call(input: AppActionToolInput) {
      const action = typeof input?.action === 'string' ? input.action : ''
      if (!actions.includes(action)) {
        return failure(`"${action}" is not an action of this app. Its actions: ${named(actions)}.`)
      }
      const context = input && typeof input === 'object' ? (input as { context?: unknown }).context : undefined
      if (context !== undefined) {
        if (typeof context !== 'object' || context === null || Array.isArray(context)) return failure('context must be an object.')
        let contextJson: string
        try {
          contextJson = JSON.stringify(context)
        } catch {
          return failure('context is not JSON-serializable.')
        }
        if (contextJson === undefined) return failure('context is not JSON-serializable.')
        if (encoder.encode(contextJson).byteLength > APP_ACTION_CONTEXT_MAX_BYTES) {
          return failure(`context is over the ${APP_ACTION_CONTEXT_MAX_BYTES}-byte limit.`)
        }
      }
      let outcome: AppActionOutcome
      try {
        outcome = await run(action, context)
      } catch (error) {
        return failure(`"${action}" failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      switch (outcome.status) {
        case 'handled':
          return { data: resultText(action, outcome.result) }
        case 'timeout':
          return failure(`The app's script did not finish "${action}" in time. Nothing else was done with it; what the script changed before then stays.`)
        case 'unavailable':
          return failure(`The app's script is not running or answers no action, so "${action}" was not run.`)
        default:
          return failure(`The app's script did not handle "${action}": it declined the action or failed on it. Nothing else was done with it.`)
      }
    },
  }) as unknown as ToolContract<AppActionToolInput, string>
}
