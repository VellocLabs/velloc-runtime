import { declareTool, type ToolContract, type ToolOutcome } from '../../../toolkit/toolContract'
import { type ToolCallContext } from '../../../toolkit/toolCallContext'
import type { Message } from '../../../runtime/RuntimeTypes'
import { TraceRecorder, toJson } from './trace'

export type FakeToolSpec = {
  name: string
  readOnly?: boolean
  concurrencySafe?: boolean
  /** The tool's own permission check; default allows. */
  selfVerdict?: { behavior: 'allow' | 'deny' | 'ask'; message?: string }
  /** The tool's input validation; default valid. */
  invalid?: string
  haltsForUser?: boolean
  /** Progress payloads reported before the result. */
  progress?: unknown[]
  /** What the call answers. A string throws as a tool failure. */
  result?: { data: unknown; isError?: boolean; newMessages?: Message[]; agentMeta?: { actionHashes?: string[]; pageFingerprint?: unknown } }
  throws?: string
  /** A context modifier that tags the context; recorded when applied. */
  contextTag?: string
  /** Microtask ticks the call takes, so parallel calls overlap. */
  ticks?: number
  /** Runs inside the call (e.g. to abort the turn mid-tool). */
  during?: (context: ToolCallContext) => void
  /** Leave out every optional field: what `buildTool` fills in by default. */
  minimal?: boolean
}

/** Tracks the calls in flight so each start records its concurrency group. */
export class ToolActivity {
  private readonly inFlight: string[] = []
  private seq = 0
  constructor(private readonly recorder: TraceRecorder) {}

  nextId(name: string): string {
    this.seq += 1
    return `${name}#${this.seq}`
  }

  start(name: string, id: string): void {
    this.inFlight.push(id)
    this.recorder.trace.toolCalls.push({ event: 'start', tool: name, id, inFlight: [...this.inFlight] })
  }

  end(name: string, id: string): void {
    const at = this.inFlight.indexOf(id)
    if (at >= 0) this.inFlight.splice(at, 1)
    this.recorder.trace.toolCalls.push({ event: 'end', tool: name, id })
  }
}

export function fakeTool(spec: FakeToolSpec, activity: ToolActivity, recorder: TraceRecorder): ToolContract {
  const base = {
    name: spec.name,
    argsSchema: { type: 'object' as const, properties: { value: { type: 'string' as const } } },
    resultCharCap: 100_000,
    description: async () => `${spec.name} test tool.`,
    prompt: async () => `${spec.name} test tool.`,
    call: async (
      args: Record<string, unknown>,
      context: ToolCallContext,
      _canUseTool: unknown,
      _assistant: unknown,
      onProgress?: (progress: unknown) => void,
    ): Promise<ToolOutcome<unknown>> => {
      const id = typeof args.value === 'string' ? args.value : activity.nextId(spec.name)
      activity.start(spec.name, id)
      try {
        for (let i = 0; i < (spec.ticks ?? 3); i += 1) await Promise.resolve()
        for (const data of spec.progress ?? []) onProgress?.({ toolUseID: id, data })
        spec.during?.(context)
        if (spec.throws) throw new Error(spec.throws)
        const result: ToolOutcome<unknown> = {
          data: spec.result?.data ?? { ok: true, tool: spec.name, args },
          ...(spec.result?.isError ? { isError: true } : {}),
          ...(spec.result?.newMessages ? { extraRows: spec.result.newMessages } : {}),
          ...(spec.result?.agentMeta ? { agentMeta: spec.result.agentMeta as never } : {}),
        }
        if (spec.contextTag) {
          const tag = spec.contextTag
          result.contextPatch = ctx => {
            recorder.trace.toolCalls.push({ event: 'contextModifier', tag })
            return ctx
          }
        }
        return result
      } finally {
        activity.end(spec.name, id)
      }
    },
  }
  if (spec.minimal) return declareTool(base) as unknown as ToolContract
  return declareTool({
    ...base,
    readsOnly: () => spec.readOnly ?? false,
    parallelSafe: () => spec.concurrencySafe ?? false,
    ...(spec.selfVerdict
      ? {
          selfVerdict: async (input: Record<string, unknown>) => {
            recorder.trace.permissions.push({ step: 'tool.checkPermissions', tool: spec.name, input: toJson(input) })
            return { ...spec.selfVerdict!, updatedInput: input }
          },
        }
      : {}),
    ...(spec.invalid
      ? { checkInput: async () => ({ result: false as const, message: spec.invalid!, errorCode: 1 }) }
      : {}),
    ...(spec.haltsForUser ? { haltsForUser: () => true } : {}),
  }) as unknown as ToolContract
}
