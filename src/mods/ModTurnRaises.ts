/**
 * The turn-seam raises of a mod slot (F-25): `prompt.submit` (the person's
 * and a plugin's), `tool.call`, `tool.check`, `classic.<Event>`, and
 * `command.run` with the registered commands it serves. Each falls back to
 * the engine's own behaviour when the chain fails.
 */

import { ModUiSurface } from './ModUiSurface'
import { errorMessage } from './chainRules'
import { isRecord } from './modNounKit'
import type { ClassicCore, ClassicSettlement } from './modRuntimeContract'
import type { ModNotifyBookings } from './modNotify'
import type { DispatchContext, TraceEntry } from './modTypes'
import type { PluginPromptArgs, PluginPromptOrigin, PluginPromptResult, PluginPromptTurn } from './promptNouns'
import type { CommandRunCore, CommandRunSettlement, PromptSubmitOutcome } from '../engine/extensionSeam'
import {
  aggregateOfClassicResult,
  classicResultOfAggregate,
  isClassicResult,
  isPreToolUseResult,
  preToolUseResultOfAggregate,
  type ClassicAggregate,
  type ClassicEventRaised,
  type ClassicResult,
  type PreToolUseResult,
} from './classicEvent'
import {
  commandRunArgsOf,
  commandRunEventOf,
  isCommandRunResult,
  type CommandRunResult,
  type ModCommandInfo,
  type ModCommandOrigin,
  type ModCommandRegistry,
  type ModCommandSpec,
} from './modCommands'
import {
  isToolCallResult,
  type ToolCallCore,
  type ToolCallEvent,
  type ToolCallSettlement,
  settledToolCheck,
  takesToolCheckResult,
  type ToolCheckCore,
  type ToolCheckEvent,
  type ToolCheckResult,
  type ToolCheckSettlement,
} from './toolCallEvent'

export abstract class ModTurnRaises extends ModUiSurface {
  abstract readonly commands: ModCommandRegistry
  protected abstract readonly bookings: ModNotifyBookings | undefined
  protected abstract personRan(startedAt: number, mark: number): void
  /** How many of the person's commands and prompts are being answered now:
   *  a `$.ui.open` under one is asked — "the person's command, prompt or
   *  press behind it" — and placed and shown at once. */
  protected personAsks = 0

  /**
   * `prompt.submit`: hooks may rewrite, add model-only context, or `{ drop }`. A
   * broken plugin never blocks a prompt: any failure enters it as typed. Only what
   * reached core entered.
   */
  async promptSubmit(text: string, signal?: AbortSignal): Promise<PromptSubmitOutcome> {
    const startedAt = Date.now()
    const mark = this.bookings?.personRunBegins() ?? 0
    try {
      return await this.promptSubmitThroughHooks(text, signal)
    } finally {
      this.personRan(startedAt, mark)
    }
  }

  private async promptSubmitThroughHooks(text: string, signal?: AbortSignal): Promise<PromptSubmitOutcome> {
    const typed: PromptSubmitOutcome = { entered: true, text, context: [] }
    if (this.disposed || !this.dispatcher.hasHooksFor('prompt.submit')) return typed
    let entered: { text: string; context: string[] } | undefined
    // The person's prompt: a pane opened under it is asked.
    this.personAsks += 1
    try {
      const result = await this.dispatcher.dispatch(
        'prompt.submit',
        { text, wait: false, origin: { kind: 'composer' } },
        e => {
          const arrived = (e ?? {}) as { text?: unknown; context?: unknown }
          entered = {
            text: typeof arrived.text === 'string' ? arrived.text : text,
            context: Array.isArray(arrived.context)
              ? arrived.context.filter((c): c is string => typeof c === 'string' && c !== '')
              : [],
          }
          return {
            text: entered.text,
            ...(entered.context.length > 0 ? { context: entered.context } : {}),
          }
        },
        {
          ...(signal ? { signal } : {}),
          accepts: isPromptSubmitResult,
          refusal: (reason, plugin) => ({ drop: reason, unreachable: plugin }),
        },
      )
      if (entered) return { entered: true, ...entered }
      const { drop, unreachable } = result as { drop?: unknown; unreachable?: unknown }
      return {
        entered: false,
        ...(typeof drop === 'string' && drop !== '' ? { reason: drop } : {}),
        ...(typeof unreachable === 'string' ? { unreachable } : {}),
      }
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: prompt.submit failed: ${errorMessage(error)}; the prompt enters as typed`)
      return entered ? { entered: true, ...entered } : typed
    } finally {
      this.personAsks -= 1
    }
  }

  /**
   * `$.prompt.submit`: a plugin's prompt, raised past the caller's hook; core queues
   * it as its own turn (not raised again). Resolves once queued, or `{ drop }`.
   */
  async pluginSubmit(
    args: PluginPromptArgs,
    enqueue: (turn: PluginPromptTurn) => void | Promise<void>,
    raise: { context: DispatchContext; signal?: AbortSignal },
  ): Promise<PluginPromptResult> {
    const name = raise.context.origin.plugin
    const origin: PluginPromptOrigin = { kind: 'plugin', name, ...(args.asUser ? { asUser: true as const } : {}) }
    const queue = async (text: string, context: string[]): Promise<PluginPromptResult> => {
      await enqueue({ text, context, plugin: name, ...(args.asUser ? { asUser: true as const } : {}) })
      return { text, ...(context.length > 0 ? { context } : {}), origin }
    }
    if (this.disposed || !this.dispatcher.hasHooksFor('prompt.submit')) return queue(args.text, [])
    let queued: PluginPromptResult | undefined
    try {
      const result = await this.dispatcher.dispatch(
        'prompt.submit',
        { text: args.text, wait: false, origin },
        async e => {
          const arrived = (e ?? {}) as { text?: unknown; context?: unknown; origin?: unknown }
          // "`next(e)` passes it on as received; no hook may set one."
          if (arrived.origin !== undefined && JSON.stringify(arrived.origin) !== JSON.stringify(origin)) {
            throw new Error('the rewritten event is refused: origin is pinned')
          }
          const text = typeof arrived.text === 'string' && arrived.text.trim() !== '' ? arrived.text : args.text
          const context = Array.isArray(arrived.context)
            ? arrived.context.filter((c): c is string => typeof c === 'string' && c !== '')
            : []
          queued = await queue(text, context)
          return queued
        },
        {
          signal: raise.signal,
          context: raise.context,
          accepts: isPromptSubmitResult,
          refusal: reason => ({ drop: reason }),
        },
      )
      if (queued) return queued
      const drop = (result as { drop?: unknown }).drop
      const reason = typeof drop === 'string' && drop !== '' ? drop : 'a hook answered without next'
      this.options.report(`mods: prompt.submit (${name}) dropped by a hook: ${reason}`)
      return { drop: reason }
    } catch (error) {
      if (queued) return queued
      if (raise.signal?.aborted) throw error
      this.options.report(`mods: prompt.submit (${name}) failed: ${errorMessage(error)}; the prompt is queued as written`)
      return queue(args.text, [])
    }
  }

  /** Whether any loaded hook selects `tool.call`. A session whose mods do not
   *  hook it runs its tools exactly as a session without mods. */
  hasToolCallHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('tool.call')
  }

  /**
   * Contract: `tool.call`. `core` runs the call as it ARRIVED and may run more than
   * once or never. When the chain settles, every core run nobody awaits is aborted.
   * Never rejects: not settled means abandoned or failed, and the caller falls back
   * to the engine's own behaviour.
   */
  async toolCall(
    e: ToolCallEvent,
    core: ToolCallCore,
    signal?: AbortSignal,
    context?: DispatchContext,
  ): Promise<ToolCallSettlement> {
    // The model's call is only raised when a hook selects it. A plugin's own
    // (`context` given) always is: with no other hook the chain is core alone.
    if (this.disposed && context) return { settled: false, refused: "the session's mods are gone" }
    if (this.disposed || (!context && !this.hasToolCallHooks())) return { settled: false }
    const running = new Set<AbortController>()
    try {
      const result = await this.dispatcher.dispatch(
        'tool.call',
        e,
        async arrived => {
          const run = new AbortController()
          running.add(run)
          try {
            return await core(arrived, run.signal)
          } finally {
            running.delete(run)
          }
        },
        {
          ...(signal ? { signal } : {}),
          ...(context ? { context } : {}),
          accepts: isToolCallResult,
          refusal: reason => ({ deny: reason }),
        },
      )
      return { settled: true, result }
    } catch (error) {
      if (signal?.aborted) return { settled: false }
      if (context) {
        // A call from inside the chain (a hook's `$.tool.call`): run without
        // its hooks it would pass every guard the chain holds — and at the
        // depth bound, every level unwinding would run one.
        this.options.report(`mods: tool.call failed: ${errorMessage(error)}; the call is refused`)
        return { settled: false, refused: `tool.call failed: ${errorMessage(error)}` }
      }
      this.options.report(
        `mods: tool.call failed: ${errorMessage(error)}; the call runs without its hooks`,
      )
      return { settled: false }
    } finally {
      for (const run of running) run.abort()
    }
  }

  /** Whether any loaded hook selects `tool.check`. A session whose mods do
   *  not hook it decides its tools' permission exactly as without mods. */
  hasToolCheckHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('tool.check')
  }

  /**
   * `tool.check`: `e` is pinned and `core` is the engine's verdict; this only settles
   * the chain. Never rejects: not settled means the engine's own verdict stands.
   */
  async toolCheck(
    e: ToolCheckEvent,
    core: ToolCheckCore,
    signal?: AbortSignal,
    context?: DispatchContext,
  ): Promise<ToolCheckSettlement> {
    if (this.disposed || (!context && !this.hasToolCheckHooks())) return { settled: false }
    const running = new Set<AbortController>()
    let entries: readonly TraceEntry[] = []
    try {
      const result = await this.dispatcher.dispatch(
        'tool.check',
        e,
        async () => {
          const run = new AbortController()
          running.add(run)
          try {
            return await core(run.signal)
          } finally {
            running.delete(run)
          }
        },
        {
          ...(signal ? { signal } : {}),
          ...(context ? { context } : {}),
          accepts: takesToolCheckResult,
          refusal: reason => ({ decision: 'deny', reason }),
          trace: settled => {
            entries = settled
          },
        },
      )
      return { settled: true, result: settledToolCheck(result as ToolCheckResult, entries) }
    } catch (error) {
      if (!signal?.aborted) {
        this.options.report(
          `mods: tool.check failed: ${errorMessage(error)}; the engine's own verdict stands`,
        )
      }
      return { settled: false }
    } finally {
      for (const run of running) run.abort()
    }
  }

  /** Whether any loaded hook selects `classic.<event>`. A session whose mods
   *  do not hook it runs the classic hooks exactly as before. */
  hasClassicHooks(event: ClassicEventRaised): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor(`classic.${event}`)
  }

  /**
   * `classic.<Event>`: the settings hooks beneath every plugin's hooks; `core` runs
   * the executor. Answering without `next` pre-empts them. Never rejects.
   */
  async classic(
    event: ClassicEventRaised,
    e: Record<string, unknown>,
    core: ClassicCore,
    signal?: AbortSignal,
    context?: DispatchContext,
  ): Promise<ClassicSettlement> {
    if (!this.hasClassicHooks(event)) return { settled: false }
    const runs = new Map<number, ClassicAggregate>()
    const running = new Set<AbortController>()
    const isPreToolUse = event === 'PreToolUse'
    try {
      const result = await this.dispatcher.dispatch(
        `classic.${event}`,
        e,
        async () => {
          const run = new AbortController()
          running.add(run)
          try {
            const aggregate = await core(run.signal)
            const ref = runs.size + 1
            runs.set(ref, aggregate)
            return isPreToolUse
              ? preToolUseResultOfAggregate(aggregate, ref)
              : classicResultOfAggregate(aggregate, ref)
          } finally {
            running.delete(run)
          }
        },
        {
          ...(signal ? { signal } : {}),
          ...(context ? { context } : {}),
          accepts: isPreToolUse ? isPreToolUseResult : isClassicResult,
          ...(isPreToolUse ? { refusal: (reason: string) => ({ deny: reason }) } : {}),
        },
      )
      const settled = result as ClassicResult | PreToolUseResult
      if (isPreToolUse) {
        const decision = settled as PreToolUseResult
        if (decision.allow !== undefined || decision.ask !== undefined) {
          // Velloc's permission flow runs BEFORE its PreToolUse hooks, so
          // there is no prompt left to skip or to force here. Said, never
          // silently dropped.
          this.options.report(
            `mods: classic.PreToolUse answered ${decision.allow ? '{ allow }' : '{ ask }'}, which this engine ` +
              'does not support yet; the call goes through the permission flow as before',
          )
        }
        if (decision.updatedInput !== undefined) {
          // The same order: the permission flow has already judged the
          // model's input, so a rewrite here would run unchecked. A mod
          // rewrites a tool's arguments through `tool.call`, which core checks.
          this.options.report(
            'mods: classic.PreToolUse answered { updatedInput }, which this engine does not support yet; ' +
              'the tool runs with the input the permission flow checked — rewrite arguments through tool.call',
          )
        }
      } else {
        const classic = settled as ClassicResult
        if (classic.preventContinuation) {
          this.options.report(
            `mods: classic.${event} answered { preventContinuation }, which this engine does not support yet; ` +
              'the session goes on',
          )
        }
      }
      return {
        settled: true,
        aggregate: aggregateOfClassicResult(settled, runs),
      }
    } catch (error) {
      if (!signal?.aborted) {
        this.options.report(
          `mods: classic.${event} failed: ${errorMessage(error)}; the classic hooks run without it`,
        )
      }
      return { settled: false }
    } finally {
      for (const run of running) run.abort()
    }
  }

  /** Whether any loaded hook selects `command.run`. */
  hasCommandRunHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('command.run')
  }

  /** The registered command of that name, if a mod serves one. */
  registeredCommand(name: string): ModCommandSpec | undefined {
    const command = this.commands.get(name)
    return command
      ? {
          name: command.name,
          description: command.description,
          ...(command.argumentHint !== undefined ? { argumentHint: command.argumentHint } : {}),
          ...(command.immediate ? { immediate: true as const } : {}),
        }
      : undefined
  }

  /** The registered commands, in registration order, with who serves each. */
  listRegisteredCommands(): Array<ModCommandSpec & { plugin: string }> {
    return this.commands.list().map(({ seat: _seat, ...command }) => command)
  }

  /** `$.command.list()`: the engine's commands, then the registered ones that
   *  do not share a name with one — the order the picker lists them. */
  listCommands(): ModCommandInfo[] {
    const engine = this.options.engineCommands?.() ?? []
    const taken = new Set(engine.map(c => c.name))
    const registered = this.commands
      .list()
      .filter(c => !taken.has(c.name))
      .map(c => ({ name: c.name, description: c.description, source: 'plugin' as const, plugin: c.plugin }))
    return [...engine, ...registered]
  }

  /**
   * `command.run`: core is the engine's command (a registered one has none and is
   * `unanswered` unless a hook answered); `command` and `presentation` are pinned.
   * Never rejects: not settled runs the engine's command as if there were no mods.
   */
  async commandRun(
    input: { command: string; args: string },
    core: CommandRunCore | undefined,
    signal?: AbortSignal,
    context?: DispatchContext,
    origin: ModCommandOrigin = { kind: 'composer' },
  ): Promise<CommandRunSettlement> {
    const startedAt = Date.now()
    const person = !context && origin.kind !== 'plugin'
    const mark = person ? (this.bookings?.personRunBegins() ?? 0) : 0
    try {
      return await this.commandRunThroughHooks(input, core, signal, context, origin)
    } finally {
      if (person) this.personRan(startedAt, mark)
    }
  }

  private async commandRunThroughHooks(
    input: { command: string; args: string },
    core: CommandRunCore | undefined,
    signal: AbortSignal | undefined,
    context: DispatchContext | undefined,
    origin: ModCommandOrigin,
  ): Promise<CommandRunSettlement> {
    const registered = this.commands.has(input.command)
    if (this.disposed || (!context && !registered && !this.hasCommandRunHooks())) {
      return { settled: false }
    }
    const running = new Set<AbortController>()
    let ref = 0
    let answeredByCore = false
    // The person's command (not a plugin's `$.command.run`): a pane opened
    // under it is asked.
    const isPersons = !context && origin.kind !== 'plugin'
    if (isPersons) this.personAsks += 1
    try {
      const result = await this.dispatcher.dispatch(
        'command.run',
        commandRunEventOf(input.command, input.args, origin),
        async arrived => {
          ref += 1
          const args = commandRunArgsOf(arrived, input.args)
          if (!core) {
            // A registered command has no engine behaviour: the chain alone
            // answers, and a run nobody answered says so.
            return { ref, text: undefined } as CommandRunResult
          }
          const run = new AbortController()
          running.add(run)
          try {
            const answer = await core(args, run.signal)
            answeredByCore = true
            return { ...answer, ref }
          } finally {
            running.delete(run)
          }
        },
        {
          ...(signal ? { signal } : {}),
          ...(context ? { context } : {}),
          accepts: isCommandRunResult,
        },
      )
      const settled = result as CommandRunResult
      const unanswered = !core && settled.ref !== undefined && settled.text === undefined && !answeredByCore
      return { settled: true, result: settled, unanswered }
    } catch (error) {
      if (!signal?.aborted) {
        this.options.report(
          `mods: command.run failed: ${errorMessage(error)}; /${input.command} runs without its hooks`,
        )
      }
      return { settled: false }
    } finally {
      if (isPersons) this.personAsks -= 1
      for (const run of running) run.abort()
    }
  }

  /** Whether `/<name>` is a registered command that declared `immediate`. */
  isImmediateCommand(name: string): boolean {
    return !this.disposed && this.commands.get(name)?.immediate === true
  }

  /**
   * An `immediate` command during a turn: its text shows as the plugin's toast (a row
   * would break the running turn's tool pairing); `context` is dropped. Stop does
   * not abort it. Never rejects.
   */
  async commandRunImmediate(input: { command: string; args: string }): Promise<void> {
    const plugin = this.commands.get(input.command)?.plugin
    if (plugin === undefined) return
    const settlement = await this.commandRun(input, undefined)
    if (!settlement.settled) return
    const { result, unanswered } = settlement
    if (unanswered) {
      this.options.report(`mods: no hook answered /${input.command}, run while a turn was in flight`)
      return
    }
    if (typeof result.text === 'string' && result.text !== '') this.ui.toast(plugin, result.text)
    if (result.context?.some(c => c !== '')) {
      this.options.report(
        `mods: /${input.command} ran while a turn was in flight; its context has no prompt to ride and was dropped`,
      )
    }
  }

  /** `$.command.run` from a hook: a registered command through the chain
   *  (the calling hook skipped); an engine command is not run from here yet
   *  — refused by name (F-25). */
  protected async runCommandForMod(
    input: { command: string; args: string },
    raise: { context: DispatchContext; signal?: AbortSignal },
  ): Promise<CommandRunResult> {
    if (!this.commands.has(input.command)) {
      const engine = this.options.engineCommands?.() ?? []
      const error = engine.some(c => c.name === input.command)
        ? Object.assign(
            new Error(
              `$.command.run: /${input.command} is the engine's own command, which a plugin cannot run yet; ` +
                'only a command registered with $.command.register runs through $.command.run',
            ),
            { name: 'NotSupportedError' },
          )
        : new Error(`$.command.run: no command is named "${input.command}"`)
      throw error
    }
    const settlement = await this.commandRun(
      input,
      undefined,
      raise.signal,
      raise.context,
      { kind: 'plugin', name: raise.context.origin.plugin },
    )
    if (!settlement.settled) {
      const error = new Error(`$.command.run: /${input.command} was abandoned`)
      error.name = 'AbortError'
      throw error
    }
    // "Absent on … `$.command.run`'s": no `ref` — the run is not the
    // conversation's.
    const { ref: _ref, ...result } = settlement.result
    return result
  }
}

function isPromptSubmitResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  const { text, drop } = value as { text?: unknown; drop?: unknown }
  return typeof text === 'string' || typeof drop === 'string'
}
