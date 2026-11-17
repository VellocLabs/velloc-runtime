/**
 * `plugin.register`, `engine.create`, and the nouns plugins add to `$`
 * (F-25): the table each `$` call is held to, the nouns withheld from it,
 * and a plugin noun served by the seat that provides it.
 */

import { ModSessionLifecycle } from './ModSessionLifecycle'
import { errorMessage } from './chainRules'
import { isOpResult, isRecord } from './modNounKit'
import { implementedNouns } from './modNouns'
import { EMPTY_USES, pluginNounCalls } from './modScan'
import { isEngineTable, type EngineTable } from './modEngineTable'
import { pluginRootOf, type Seat } from './modSeat'
import type { ModState } from './modRuntimeContract'
import type { ModCall } from './ModInstance'
import type { TraceEntry } from './modTypes'

export abstract class ModPluginNouns extends ModSessionLifecycle {
  protected abstract readonly seats: Seat[]
  protected abstract readonly states: Map<Seat, ModState>
  protected abstract note(seat: Seat, state: Omit<ModState, 'plugin' | 'path' | 'generation'>): void
  protected abstract forgetTools(plugin: string): void
  /** The nouns plugins' `engine.create` steps added to `$`: each
   *  served by the seat that provides it. */
  protected readonly pluginNouns = new Map<string, { seat: Seat; methods: readonly string[] }>()
  /** The nouns a step withheld from `$`, by the plugin that did: "the host
   *  refuses an op on one". */
  protected readonly withheld = new Map<string, string>()
  /** The `engine.create` steps that failed in the fold under way, by link. */
  protected readonly createFailures = new Set<string>()

  /** The `$` calls the plugins' nouns raise, as events (`voice.say`). */
  protected pluginNounEvents(): string[] {
    return [...this.pluginNouns].flatMap(([noun, entry]) => entry.methods.map(method => `${noun}.${method}`))
  }

  /**
   * `plugin.register` for a seat whose module has run `register` but whose
   * hooks have not joined: "`{ allow: true }` from core, or `{ refuse:
   * reason }`". Resolves to the refusal line, naming who refused, or null.
   * A hook that fails is skipped; a dispatch that fails admits (a broken
   * judge never blocks).
   */
  protected async pluginRegister(seat: Seat): Promise<string | null> {
    if (!this.dispatcher.hasHooksFor('plugin.register')) return null
    const { ref } = seat
    const e = {
      name: ref.plugin,
      tier: ref.tier ?? 'user',
      root: ref.root ?? pluginRootOf(ref.path),
      ...(ref.version !== undefined ? { version: ref.version } : {}),
      provenance: ref.provenance ?? `${ref.plugin}@inline`,
      uses: seat.uses ?? EMPTY_USES,
    }
    let entries: readonly TraceEntry[] = []
    try {
      const result = (await this.dispatcher.dispatch('plugin.register', e, () => ({ allow: true }), {
        accepts: isPluginRegisterResult,
        refusal: reason => ({ refuse: reason }),
        // A restarting seat (this one's own previous generation included) is
        // not among the plugins admitted before it: it does not judge.
        passStandIns: true,
        trace: trace => {
          entries = trace
        },
      })) as { allow?: true; refuse?: string }
      if (typeof result.refuse !== 'string') return null
      const reason = result.refuse
      // Who refused: the deepest hook whose own answer carries this reason;
      // failing that, the outermost that answered.
      const answered = entries.filter(entry => entry.outcome === 'returned' && entry.plugin !== 'engine')
      const refuser =
        [...answered].reverse().find(entry => isRecord(entry.returned) && entry.returned.refuse === reason) ??
        answered[0]
      return `${refuser?.plugin ?? 'a plugin'} refused it at plugin.register — ${reason}`
    } catch (error) {
      this.options.report(`mods: plugin.register failed: ${errorMessage(error)}; ${ref.plugin} loads`)
      return null
    }
  }

  /** The table `$` is built from as it stands: the engine's nouns less the
   *  withheld, and every plugin noun but those of `folding`. */
  private engineTable(folding: readonly Seat[]): EngineTable {
    const nouns: Record<string, string[]> = {}
    const owners: Record<string, string> = {}
    for (const call of implementedNouns()) {
      const noun = call.slice(0, call.indexOf('.'))
      if (this.withheld.has(noun)) continue
      ;(nouns[noun] ??= []).push(call.slice(noun.length + 1))
      owners[noun] = 'engine'
    }
    if (!this.withheld.has('plugin')) {
      nouns.plugin = []
      owners.plugin = 'engine'
    }
    for (const [noun, entry] of this.pluginNouns) {
      if (folding.includes(entry.seat)) continue
      nouns[noun] = [...entry.methods]
      owners[noun] = entry.seat.ref.plugin
    }
    return { nouns, owners, withheld: Object.fromEntries(this.withheld) }
  }

  /**
   * `engine.create`: "the fold that builds `$`, once per load, core
   * innermost … `plugins`: the whole set at a load, this plugin alone at its
   * reload". The result is the table every `$` call is then held to: a
   * plugin's noun is served by the seat that added it, a withheld one is
   * refused. "A step that fails unloads its plugin; `$` is rebuilt": the
   * fold runs again without it. Never rejects.
   */
  protected async createEngine(seats: readonly Seat[], options: { alone?: boolean } = {}): Promise<void> {
    let folding = seats.filter(seat => seat.loaded)
    // No step anywhere: `$` is the engine's table, and nothing is to do — a
    // slot whose modules add nothing pays no dispatch.
    if (!this.dispatcher.hasHooksFor('engine.create')) return
    for (let round = 0; folding.length > 0 && !this.disposed; round++) {
      const e = { plugins: folding.map(seat => seat.ref.plugin) }
      this.createFailures.clear()
      let table: EngineTable
      try {
        table = await this.dispatcher.dispatch('engine.create', e, () => this.engineTable(folding), {
          accepts: isEngineTable,
          // Seats loaded alone fold alone, the rest of the table standing;
          // the whole set folds together.
          ...(options.alone ? { onlyGroup: folding.map(seat => seat.key) } : {}),
        })
      } catch (error) {
        this.options.report(`mods: engine.create failed: ${errorMessage(error)}; $ stands as it was`)
        return
      }
      const failed = folding.filter(seat =>
        [...this.createFailures].some(linkId => linkId.startsWith(`${seat.key}#${seat.generation}/`)),
      )
      this.createFailures.clear()
      if (failed.length === 0) {
        this.applyEngineTable(table, folding)
        return
      }
      for (const seat of failed) {
        this.unload(seat, 'failed', 'its engine.create step failed (see the line above); its plugin does not load')
      }
      folding = folding.filter(seat => !failed.includes(seat) && seat.loaded)
      if (round >= this.seats.length) return
    }
  }

  /** Read the fold's result into the tables `serveCall` consults. */
  private applyEngineTable(table: EngineTable, folding: readonly Seat[]): void {
    for (const seat of folding) this.dropNouns(seat)
    for (const [noun, methods] of Object.entries(table.nouns)) {
      const owner = table.owners[noun]
      if (owner === undefined || owner === 'engine') continue
      const seat = folding.find(s => s.ref.plugin === owner && s.loaded) ?? this.pluginNouns.get(noun)?.seat
      if (!seat?.loaded) continue
      this.pluginNouns.set(noun, { seat, methods })
    }
    // A noun of the engine's missing from the table was withheld — by the
    // step the table names, or by the one that returned without `next`.
    const engineNouns = new Set(implementedNouns().map(call => call.slice(0, call.indexOf('.'))))
    engineNouns.add('plugin')
    for (const noun of engineNouns) {
      if (noun in table.nouns) this.withheld.delete(noun)
      else {
        const by = table.withheld[noun] ?? table.withheldAll ?? this.withheld.get(noun) ?? 'a plugin'
        if (!this.withheld.has(noun)) this.options.report(`${by}: $.${noun} is withheld at engine.create`)
        this.withheld.set(noun, by)
      }
    }
    for (const seat of folding) {
      const state = this.states.get(seat)
      if (state?.state === 'loaded') this.note(seat, { state: 'loaded', ...(state.events ? { events: state.events } : {}) })
      const provided = [...this.pluginNouns].filter(([, entry]) => entry.seat === seat).map(([noun]) => noun)
      if (provided.length > 0) this.options.report(`${seat.ref.plugin}: added $.${provided.join(', $.')} at engine.create`)
    }
  }

  /** "A module calling a noun no plugin provides", or hooking one by name:
   *  refused once the fold has run, naming the call. True when the seat
   *  stands. */
  protected admitPluginNounCalls(seat: Seat): boolean {
    if (!seat.loaded) return false
    const provides = (call: string): boolean => {
      const noun = call.slice(0, call.indexOf('.'))
      return this.pluginNouns.get(noun)?.methods.includes(call.slice(noun.length + 1)) === true
    }
    const provided = this.pluginNouns.size > 0 ? ` (the plugins provide: ${this.pluginNounEvents().join(', ')})` : ''
    const unraised = (seat.tentative ?? []).filter(pattern => !provides(pattern))
    seat.tentative = []
    if (unraised.length > 0) {
      this.unload(
        seat,
        'refused',
        `it hooks ${unraised.length === 1 ? 'an event' : 'events'} this engine does not raise yet: ${unraised.join(', ')}` +
          ` (no loaded plugin's engine.create step adds the noun${provided})`,
      )
      return false
    }
    if (!seat.uses) return true
    const missing = pluginNounCalls(seat.uses).filter(({ call }) => !provides(call))
    if (missing.length === 0) return true
    this.unload(
      seat,
      'refused',
      `it calls ${missing.map(({ call }) => `$.${call}`).join(', ')}, which no loaded plugin's engine.create step provides${provided}`,
    )
    return false
  }

  /** A loaded seat that is not to stay loaded (its step failed, it calls
   *  what nothing provides): its worker closed, its hooks and nouns out,
   *  reported. */
  private unload(seat: Seat, state: 'refused' | 'failed', reason: string): void {
    const loaded = seat.loaded
    seat.loaded = undefined
    if (loaded) {
      loaded.instance.dispose()
      loaded.worker.close()
    }
    this.bookings?.dropSeat(seat.key)
    this.dispatcher.unregister(seat.key)
    this.commands.unregisterSeat(seat.key)
    this.dropNouns(seat)
    this.forgetTools(seat.ref.plugin)
    this.note(seat, { state, reason })
    this.options.report(`${seat.ref.plugin}: the hooks module was ${state === 'refused' ? 'refused' : 'not loaded'} — ${reason}`)
  }

  /** The seat's nouns leave `$`, and what its plugin withheld is withheld
   *  no more. */
  protected dropNouns(seat: Seat): void {
    for (const [noun, entry] of [...this.pluginNouns]) if (entry.seat === seat) this.pluginNouns.delete(noun)
    if (!this.seats.some(other => other !== seat && other.ref.plugin === seat.ref.plugin && other.loaded)) {
      for (const [noun, by] of [...this.withheld]) if (by === seat.ref.plugin) this.withheld.delete(noun)
    }
  }

  /** A `$` call of a noun a plugin added: raised like any other, its core
   *  the providing seat's worker. */
  protected servePluginNoun(call: ModCall, entry: { seat: Seat; methods: readonly string[] }): Promise<unknown> {
    const provider = entry.seat
    if (!entry.methods.includes(call.method)) {
      const error = new Error(
        `$.${call.noun}.${call.method} is not a method ${provider.ref.plugin} provides ` +
          `(it provides: ${entry.methods.map(method => `${call.noun}.${method}`).join(', ')})`,
      )
      error.name = 'NotSupportedError'
      return Promise.reject(error)
    }
    const e: unknown = call.args.length > 0 ? call.args[0] : {}
    return this.dispatcher
      .dispatch(
        `${call.noun}.${call.method}`,
        e,
        async arrived => {
          const loaded = provider.loaded
          if (!loaded) {
            throw new Error(`$.${call.noun}.${call.method}: ${provider.ref.plugin}, which provides it, is not loaded`)
          }
          const args = call.args.length > 0 ? [arrived, ...call.args.slice(1)] : []
          return { value: await loaded.instance.serve(call.noun, call.method, args, call.plugin, call.signal) }
        },
        {
          context: call.context,
          scope: call.scope,
          ...(call.signal ? { signal: call.signal } : {}),
          accepts: result => isOpResult(result, undefined),
        },
      )
      .then(result => {
        const settled = result as { value?: unknown; deny?: string }
        if (typeof settled.deny === 'string') {
          const error = new Error(settled.deny)
          error.name = 'DeniedError'
          throw error
        }
        return settled.value
      })
  }
}

function isPluginRegisterResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  return value.allow === true || typeof value.refuse === 'string'
}
