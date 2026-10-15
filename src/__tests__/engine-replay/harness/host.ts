import type { PlatformCapabilities } from '../../../runtime/interfaces/PlatformCapabilities'
import { NoopPlatformCapabilities } from '../../../runtime/testing/noopAdapters'
import { TraceRecorder, toJson } from './trace'

/** What a lifecycle hook command prints and exits with, given its stdin. */
export type HookAnswer = (input: Record<string, unknown>) => { output?: string; exit_code?: number }

/**
 * The host: records every `session.setAgentLoopSettings` push, and runs the
 * session's lifecycle hook commands — each run is recorded with the payload
 * it read on stdin, and answered by the scenario's script for that event
 * (default: exit 0, no output).
 */
export function fakeHost(recorder: TraceRecorder, hookAnswers: Partial<Record<string, HookAnswer>> = {}): PlatformCapabilities {
  return Object.assign(new NoopPlatformCapabilities(), {
    session: {
      async setAgentLoopSettings(params: Record<string, unknown>) {
        recorder.trace.hostPushes.push(toJson(params))
      },
    },
    browser: {
      async callTool(request: { name?: string; args: { hook_stdin?: string; command?: string } }) {
        const stdin = request.args.hook_stdin
        if (typeof stdin !== 'string') {
          recorder.trace.hooks.push({ unexpectedHostTool: request.name, args: toJson(request.args) })
          return { output: '', exit_code: 0 }
        }
        const input = JSON.parse(stdin) as Record<string, unknown>
        const event = String(input.hook_event_name)
        recorder.trace.hooks.push({ event, command: request.args.command, stdin: input })
        const answer = hookAnswers[event]?.(input) ?? {}
        return { output: answer.output ?? '', exit_code: answer.exit_code ?? 0 }
      },
    },
  }) as unknown as PlatformCapabilities
}
