import { launchFork, recallForkPrefix, type ForkPrefixSnapshot } from '../agents/forkedRun'
import type { TurnConclusion } from '../engine/turnOutcome'
import { createGeneratedUserMessage } from '../messages/messageFactories'
import type { PromptContextProvider } from '../runtime/interfaces/PromptContextProvider'
import type { QueryRuntimeDeps } from '../runtime/interfaces/QueryRuntimeDeps'
import type { Message } from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { ToolContractList } from '../toolkit/toolContract'
import type { PermissionDecider } from '../toolkit/permissionVerdict'
import { createSidechainAgentId, getContextSidechainStore } from '../utils/sidechainTranscripts'
import type { ReviewPromptBlock } from './composer'
import type { ReviewRunEnd, ReviewTaskRole } from './contracts'

/** Observes one review task's life; every callback carries the review-side task key. */
export interface ReviewTaskObserver {
  started(info: { key: string; agentId: string; role: ReviewTaskRole; label: string }): void
  activity(info: { key: string; action: string }): void
  ended(info: { key: string; end: ReviewRunEnd }): void
}

export interface ReviewModelRequest {
  blocks: readonly ReviewPromptBlock[]
  tools: ToolContractList
  signal: AbortSignal
  taskId: string
  execution?: 'isolated' | 'inline'
  maxTurns?: number
  reasoningLevel?: string
  role?: ReviewTaskRole
  label?: string
  observer?: ReviewTaskObserver
}
export interface ReviewModelResult { text: string; interrupted: boolean; end?: ReviewRunEnd; agentId?: string }
/** A result without an explicit end reads its `interrupted` flag. */
export const endOf = (result: Pick<ReviewModelResult, 'interrupted' | 'end'>): ReviewRunEnd => result.end ?? { kind: result.interrupted ? 'crash' : 'completed' }
export type ReviewModelRunner = (request: ReviewModelRequest) => Promise<ReviewModelResult>

/** Contract: the loop's terminal reason, as the run reports it. */
export function reviewRunEnd(conclusion: TurnConclusion): ReviewRunEnd {
  if (conclusion.kind === 'crash') return { kind: 'crash', detail: conclusion.error instanceof Error ? conclusion.error.message : String(conclusion.error) }
  const outcome = conclusion.outcome as { reason: string; error?: string }
  switch (outcome.reason) {
    case 'completed': case 'stop_hook_prevented': return { kind: 'completed' }
    case 'aborted_streaming': return { kind: 'cancelled' }
    case 'max_turns': return { kind: 'step-limit' }
    case 'max_output_tokens': return { kind: 'output-cap' }
    case 'prompt_too_long': return { kind: 'context-overflow' }
    case 'api_error': return { kind: 'model-error', detail: outcome.error }
    case 'max_failures': return { kind: 'failure-limit' }
    case 'awaiting_user_interaction': return { kind: 'awaiting-user' }
    default: return { kind: 'crash', detail: outcome.reason }
  }
}

/** The last assistant row's text; empty when the run produced none, so the report parser sees no placeholder. */
function lastAssistantText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const row = messages[i]
    if (row?.type !== 'assistant') continue
    const content = (row as Message & { message?: { content?: unknown } }).message?.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) continue
    const text = content.filter((part): part is { type: 'text'; text: string } => !!part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n')
    if (text) return text
  }
  return ''
}

/** The last tool call an assistant row issued, as one short line for the task tree. */
export function describeActivity(row: Message): string | undefined {
  const content = (row as Message & { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return undefined
  const calls = content.filter((part): part is { type: 'tool_use'; name: string; input?: Record<string, unknown> } =>
    !!part && typeof part === 'object' && part.type === 'tool_use' && typeof part.name === 'string')
  const last = calls.at(-1)
  if (!last) return undefined
  const input = last.input ?? {}
  const detail = [input.role, input.operation, input.path, input.query].filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ')
  return detail ? `${last.name} ${detail}`.slice(0, 200) : last.name
}

/**
 * Every review model run is a fork on the shared substrate: it registers as this
 * session's task, records its transcript and ends with a precise reason. An
 * isolated run seeds nothing; an inline run seeds the invoking conversation.
 */
export function createReviewModelRunner(input: {
  context: ToolCallContext
  promptContextProvider: PromptContextProvider
  decidePermission: PermissionDecider
  deps?: QueryRuntimeDeps
}): ReviewModelRunner {
  return async request => {
    const cancelSource = new AbortController()
    const abort = () => cancelSource.abort(request.signal.reason)
    request.signal.addEventListener('abort', abort, { once: true })
    if (request.signal.aborted) abort()
    const role = request.role ?? 'coordinator'
    const label = request.label ?? role
    const agentId = createSidechainAgentId(`review-${role}`)
    let end: ReviewRunEnd | undefined
    try {
      if (cancelSource.signal.aborted) throw new Error('review-cancelled')
      const parent = input.context
      const options = { ...parent.options, tools: request.tools, commands: [], refreshTools: () => request.tools }
      const prompt = await input.promptContextProvider.gatherSystemPromptSources({
        tools: request.tools, visibleToolNames: request.tools.map(tool => tool.name),
        mainLoopModel: options.mainLoopModel, extraWorkspaceRoots: [], mcpClients: [],
        cwd: options.cwd, providerId: options.mainLoopProviderId,
        templateType: options.templateType,
      })
      if (cancelSource.signal.aborted) throw new Error('review-cancelled')
      const inherited = request.execution === 'inline' ? recallForkPrefix(parent.options.runtimeConfig) : null
      const forkPrefix: ForkPrefixSnapshot = {
        systemPrompt: prompt.defaultSystemPrompt, userContext: prompt.userContext, systemContext: prompt.systemContext,
        toolUseContext: parent, forkSeedRows: inherited?.forkSeedRows ?? [],
        providerId: options.mainLoopProviderId, thinkingTier: request.reasoningLevel,
      }
      const opening = request.blocks.map(block => Object.assign(
        createGeneratedUserMessage([{ type: 'text' as const, text: JSON.stringify({ source: block.source, provenance: block.provenance, text: block.text }) }]),
        { reviewSource: { provenance: block.provenance, source: block.source } },
      ))
      request.observer?.started({ key: request.taskId, agentId, role, label })
      const outcome = await launchFork({
        openingRows: opening, forkPrefix, canUseTool: input.decidePermission,
        querySource: 'skill_fork', forkLabel: 'code-review', agentType: `review-${role}`, description: label, agentId,
        overrides: { options, abortController: cancelSource, messages: [], readFileState: new Map(), inheritConfirm: true },
        systemPromptOverride: prompt.defaultSystemPrompt,
        omitParentContext: !inherited,
        maxTurns: request.maxTurns ?? 32, maxOutputTokens: 12_000, skipCacheWrite: true, useRealModelTransport: true,
        sidechainStore: getContextSidechainStore(parent), spawnerSessionId: parent.options.sessionId || undefined,
        onMessage: row => { const action = describeActivity(row); if (action) request.observer?.activity({ key: request.taskId, action }) },
        onConclusion: conclusion => { end = reviewRunEnd(conclusion) },
      })
      if (!end) end = cancelSource.signal.aborted ? { kind: 'cancelled' } : { kind: 'crash', detail: 'no-conclusion' }
      if (cancelSource.signal.aborted && end.kind === 'completed') end = { kind: 'cancelled' }
      return { text: lastAssistantText(outcome.messages), interrupted: end.kind !== 'completed', end, agentId }
    } catch (error) {
      if (!end) end = cancelSource.signal.aborted ? { kind: 'cancelled' } : { kind: 'crash', detail: error instanceof Error ? error.message : String(error) }
      throw error
    } finally {
      request.signal.removeEventListener('abort', abort)
      if (end) request.observer?.ended({ key: request.taskId, end })
    }
  }
}

/** Serial admission with bounded active tasks; queued work never starts after cancellation. */
export class ReviewWorkerPool {
  private active = 0
  private readonly waiters: Array<() => void> = []
  constructor(private readonly concurrency = 4) {}
  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new Error('review-cancelled')
    if (this.active >= this.concurrency) await new Promise<void>((resolve, reject) => {
      const resume = () => { signal.removeEventListener('abort', abort); resolve() }
      const abort = () => { const index = this.waiters.indexOf(resume); if (index >= 0) this.waiters.splice(index, 1); reject(new Error('review-cancelled')) }
      this.waiters.push(resume)
      signal.addEventListener('abort', abort, { once: true })
    })
    else this.active += 1
    const release = () => { const next = this.waiters.shift(); if (next) next(); else this.active -= 1 }
    if (signal.aborted) { release(); throw new Error('review-cancelled') }
    try { return await task() } finally { release() }
  }
}
