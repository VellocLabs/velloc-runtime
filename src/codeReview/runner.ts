import { deriveChildToolContext } from '../agents/forkedRun'
import { runTurnLoop } from '../engine/turnInterpreter'
import { createGeneratedUserMessage } from '../messages/messageFactories'
import type { PromptContextProvider } from '../runtime/interfaces/PromptContextProvider'
import type { QueryRuntimeDeps } from '../runtime/interfaces/QueryRuntimeDeps'
import type { Message } from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { ToolContractList } from '../toolkit/toolContract'
import type { PermissionDecider } from '../toolkit/permissionVerdict'
import type { ReviewPromptBlock } from './composer'

export interface ReviewModelRequest {
  blocks: readonly ReviewPromptBlock[]
  tools: ToolContractList
  signal: AbortSignal
  taskId: string
  execution?: 'isolated' | 'inline'
  maxTurns?: number
  reasoningLevel?: string
}
export interface ReviewModelResult { text: string; interrupted: boolean }
export type ReviewModelRunner = (request: ReviewModelRequest) => Promise<ReviewModelResult>

/** A fresh task transcript and tool set; generic system safety is assembled even on the first turn. */
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
    try {
      if (cancelSource.signal.aborted) throw new Error('review-cancelled')
      const options = { ...input.context.options, tools: request.tools, commands: [], refreshTools: () => request.tools }
      const context = request.execution === 'inline'
        ? { ...input.context, options, cancelSource, messages: [] }
        : deriveChildToolContext(input.context, {
          agentId: request.taskId, messages: [], readFileState: new Map(), abortController: cancelSource, options,
        })
      context.requestToolUseConfirm = input.context.requestToolUseConfirm
      context.toolRunSeams = input.context.toolRunSeams
      const prompt = await input.promptContextProvider.gatherSystemPromptSources({
        tools: request.tools, visibleToolNames: request.tools.map(tool => tool.name),
        mainLoopModel: context.options.mainLoopModel, extraWorkspaceRoots: [], mcpClients: [],
        cwd: context.options.cwd, providerId: context.options.mainLoopProviderId,
        templateType: context.options.templateType,
      })
      if (cancelSource.signal.aborted) throw new Error('review-cancelled')
      const opening = request.blocks.map(block => Object.assign(
        createGeneratedUserMessage([{ type: 'text' as const, text: JSON.stringify({ source: block.source, provenance: block.provenance, text: block.text }) }]),
        { reviewSource: { provenance: block.provenance, source: block.source } },
      ))
      let lastText = ''
      let interrupted = false
      for await (const row of runTurnLoop({
        messages: opening, baseInstructions: prompt.defaultSystemPrompt,
        userAmbient: prompt.userContext, systemAmbient: prompt.systemContext,
        callContext: context, decidePermission: input.decidePermission,
        turnCaller: 'skill_fork', providerId: context.options.mainLoopProviderId,
        thinkingTier: request.reasoningLevel, stepLimit: request.maxTurns ?? 32,
        outputTokenCapOverride: 12_000, noCacheWrite: true,
        deps: input.deps, useRememberedCallModel: true,
        commitTerminal: async conclusion => { interrupted = conclusion.kind !== 'outcome' || conclusion.outcome.reason !== 'completed' },
      })) {
        if (row.type !== 'assistant') continue
        const content = (row as Message & { message?: { content?: unknown } }).message?.content
        if (typeof content === 'string') lastText = content
        else if (Array.isArray(content)) {
          const text = content.filter((part): part is { type: 'text'; text: string } =>
            !!part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
            .map(part => part.text).join('\n')
          if (text) lastText = text
        }
      }
      return { text: lastText, interrupted: interrupted || cancelSource.signal.aborted }
    } finally { request.signal.removeEventListener('abort', abort) }
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
