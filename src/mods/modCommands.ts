/**
 * Slash commands a mod serves (F-25): `$.command.register`, the roster, and the
 * `command.run` shapes. A built-in's name is refused. The roster is the slot's; a
 * command belongs to its seat and goes with it. Pure.
 */

import {
  BROWSER_SLASH_COMMANDS,
  HIDDEN_BROWSER_SLASH_COMMANDS,
} from '../input/slashCommandCatalog'

/** `CommandSpec` — what `$.command.register` takes. */
export type ModCommandSpec = {
  name: string
  description: string
  argumentHint?: string
  immediate?: true
}

/** One registered command, with who serves it. */
export type ModCommand = ModCommandSpec & {
  plugin: string
  /** The chain seat (`ModRuntime`'s `Seat.key`) that registered it. */
  seat: string
}

/** `CommandInfo` — a row of `$.command.list()`. */
export type ModCommandInfo = {
  name: string
  description: string
  source: 'builtin' | 'plugin' | 'user' | 'mcp'
  plugin?: string
}

/** "Letters, digits, `_`, `-`; up to 64." */
const COMMAND_NAME = /^[A-Za-z0-9_-]{1,64}$/

const BUILTIN_NAMES: ReadonlySet<string> = new Set<string>([
  ...BROWSER_SLASH_COMMANDS,
  ...HIDDEN_BROWSER_SLASH_COMMANDS,
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether `name` is one of the engine's own commands. */
export function isBuiltinCommandName(name: string): boolean {
  return BUILTIN_NAMES.has(name)
}

/** The spec as the worker sent it, checked. Throws a TypeError naming what
 *  is wrong; a built-in's name is a `NotAllowedError`. */
export function modCommandSpecOf(value: unknown): ModCommandSpec {
  if (!isRecord(value)) throw new TypeError('$.command.register takes { name, description, argumentHint?, immediate? }')
  const { name, description, argumentHint, immediate } = value
  if (typeof name !== 'string' || !COMMAND_NAME.test(name)) {
    throw new TypeError(
      '$.command.register: name must be 1-64 letters, digits, "_" or "-" (no slash)',
    )
  }
  if (typeof description !== 'string') {
    throw new TypeError('$.command.register: description must be a string')
  }
  if (argumentHint !== undefined && typeof argumentHint !== 'string') {
    throw new TypeError('$.command.register: argumentHint must be a string')
  }
  if (immediate !== undefined && immediate !== true) {
    throw new TypeError('$.command.register: immediate is true or left out')
  }
  if (isBuiltinCommandName(name)) {
    const error = new Error(`$.command.register: /${name} is a built-in command's name`)
    error.name = 'NotAllowedError'
    throw error
  }
  return {
    name,
    description,
    ...(argumentHint !== undefined ? { argumentHint } : {}),
    ...(immediate ? { immediate: true as const } : {}),
  }
}

export class ModCommandRegistry {
  private readonly commands = new Map<string, ModCommand>()

  constructor(private readonly onChanged: () => void = () => {}) {}

  /** Register (or replace) `/<spec.name>` as `plugin`'s, served from `seat`. */
  register(spec: ModCommandSpec, plugin: string, seat: string): ModCommand {
    const command: ModCommand = { ...spec, plugin, seat }
    this.commands.set(spec.name, command)
    this.onChanged()
    return command
  }

  get(name: string): ModCommand | undefined {
    return this.commands.get(name)
  }

  has(name: string): boolean {
    return this.commands.has(name)
  }

  /** Every command, in registration order. */
  list(): ModCommand[] {
    return [...this.commands.values()]
  }

  /** The seat is gone (its worker died, it was removed): its commands too. */
  unregisterSeat(seat: string): void {
    let changed = false
    for (const [name, command] of this.commands) {
      if (command.seat !== seat) continue
      this.commands.delete(name)
      changed = true
    }
    if (changed) this.onChanged()
  }

  clear(): void {
    if (this.commands.size === 0) return
    this.commands.clear()
    this.onChanged()
  }
}

// ── `command.run` ──

/** `PromptOrigin`, as `command.run` carries it. */
export type ModCommandOrigin = { kind: 'composer' } | { kind: 'bridge' } | { kind: 'sdk' } | { kind: 'plugin'; name: string }

/** `CommandRunInput`: "one slash command about to run, the way the person
 *  typed it (`/name args`), and where the run came from". */
export type CommandRunEvent = {
  command: string
  args: string
  origin: ModCommandOrigin
  /** Pinned: Velloc has no fullscreen layout and no terminal width. */
  presentation: { isFullscreen: false; columns: number }
}

/** Velloc's `presentation`: "80 where no terminal has measured". */
export const MOD_COMMAND_PRESENTATION: CommandRunEvent['presentation'] = Object.freeze({
  isFullscreen: false,
  columns: 80,
})

/** `CommandRunResult`. `ref` names the engine's run (its messages stay on
 *  the host side); absent on a hook's own answer. */
export type CommandRunResult = {
  text?: string
  context?: readonly string[]
  exitCode?: number
  ref?: number
}

export function commandRunEventOf(
  command: string,
  args: string,
  origin: ModCommandOrigin = { kind: 'composer' },
): CommandRunEvent {
  return { command, args, origin, presentation: MOD_COMMAND_PRESENTATION }
}

/** The `args` a rewrite settled on; `command` and `presentation` are pinned
 *  ("a rewrite is refused" / "one that changes it is refused" — Velloc
 *  ignores it, as the tool path does a reserved key), and `origin` passes
 *  on as received. */
export function commandRunArgsOf(arrived: unknown, original: string): string {
  if (!isRecord(arrived)) return original
  return typeof arrived.args === 'string' ? arrived.args : original
}

/** Whether a hook's return is an answer to `command.run`. `{}` is one: the
 *  command "showed nothing as text". */
export function isCommandRunResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  const { text, context, exitCode, ref } = value
  if (text !== undefined && typeof text !== 'string') return false
  if (context !== undefined && !(Array.isArray(context) && context.every(c => typeof c === 'string'))) {
    return false
  }
  if (
    exitCode !== undefined &&
    !(typeof exitCode === 'number' && Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255)
  ) {
    return false
  }
  if (ref !== undefined && typeof ref !== 'number') return false
  return true
}

/** The non-empty strings of a result's `context`. */
export function commandRunContextOf(result: unknown): string[] {
  if (!isRecord(result) || !Array.isArray(result.context)) return []
  return result.context.filter((c): c is string => typeof c === 'string' && c !== '')
}
