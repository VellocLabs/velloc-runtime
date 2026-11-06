/**
 * A mod slot's UI surface (F-25): the drawings its render sites answer, the
 * person's presses and typings routed back to their handlers, panes, the
 * page and prompt-box round trips, the prompt box's edit / autocomplete /
 * change hooks, the `$.state` values each drawing read, and `$.ui.invalidate`.
 * ModRuntime extends this with the slot's lifecycle and commands.
 */

import type { DispatchContext, TraceEntry } from './modTypes'
import type { ModInstance } from './ModInstance'
import { ModComposerBridge, type DecoratedPromptBox, type ModComposerAnswer } from './modComposer'
import { ModEngineEvents } from './ModEngineEvents'
import { errorMessage } from './chainRules'
import { ModPageBridge, type ModPageAnswer } from './modPage'
import { ModPaneRegistry, type ModPaneSeat } from './modPanes'
import { ModUiState, type ModUiAskAnswer, type ModUiEvent, type ModUiSnapshot, type ModUiStale } from './modUi'
import {
  RENDER_SURFACE,
  drawnBy,
  drewOf,
  sectionsOf,
  handlesIn,
  engineNodesIn,
  isRenderAnswer,
  renderMatcherSite,
  engineRewriteOf,
  validateRenderTree,
  type EngineRewrite,
  type RenderInput,
  type RenderOutcome,
  type RenderSite,
} from './modRender'
import { applyPromptEdit, raisePromptEdit, type PromptEdit } from './modPromptEdit'
import {
  raisePromptAutocomplete,
  raisePromptChange,
  type PromptAutocompleteInput,
  type PromptAutocompleteSuggestion,
  type PromptChangeInput,
} from './promptBoxEvents'

export abstract class ModUiSurface extends ModEngineEvents {
  abstract readonly ui: ModUiState
  abstract readonly panes: ModPaneRegistry
  protected abstract readonly composer: ModComposerBridge | undefined
  protected abstract readonly page: ModPageBridge | undefined
  protected abstract instanceOf(plugin: string): ModInstance | undefined
  /** How many of the person's presses, typings and picks are being answered
   *  now: a `$.ui.scroll` of a transcript row is theirs to ask. */
  protected personInputs = 0
  /** Each drawing's handlers, by drawing then plugin: what the worker keeps
   *  "for the lifetime of the drawing", dropped when it is drawn again. */
  private readonly drawings = new Map<string, Map<string, Set<number>>>()
  /** The ask of each drawing's render still in flight, the latest only. */
  private readonly latestRender = new Map<string, number>()
  private renderAsks = 0
  /** Which drawings read which `$.state` value while drawn, both ways. */
  private readonly readersOf = new Map<string, Set<string>>()
  private readonly readsOf = new Map<string, Set<string>>()
  /** `$.ui.invalidate` folds: "ten a second at most". */
  private readonly invalidations = new Map<string, ReturnType<typeof setTimeout>>()

  // ── `ui.render`, the panes, and the input a drawing raises ──

  /** The ui state as the client reads it: the lines, the panes, the hooked
   *  sites. */
  uiSnapshot(): ModUiSnapshot {
    return {
      ...this.ui.snapshot(),
      panes: this.panes.list().map(pane => ({
        plugin: pane.plugin,
        id: pane.id,
        title: pane.title,
        isShown: pane.isShown,
        isFocused: pane.isFocused,
        isPlaced: pane.isPlaced,
        asked: pane.asked,
        focus: pane.focus,
        openSeq: pane.openSeq,
        closeOnEscape: pane.closeOnEscape,
        ...(pane.rows !== undefined ? { rows: pane.rows } : {}),
        ...(pane.columns !== undefined ? { columns: pane.columns } : {}),
      })),
      hooked: this.renderSites(),
      ...(this.hasPromptEditHooks() ? { editHooked: true } : {}),
      ...(this.hasPromptAutocompleteHooks() ? { autocompleteHooked: true } : {}),
      ...(this.hasPromptChangeHooks() ? { changeHooked: true } : {}),
      ...(this.turnNote ? { turnNote: this.turnNote } : {}),
    }
  }

  protected emitUi(event: ModUiEvent): void {
    try {
      this.options.onUiChanged?.(event.kind === 'state' ? { kind: 'state', state: this.uiSnapshot() } : event)
    } catch (error) {
      this.options.report(`mods: the ui listener failed: ${errorMessage(error)}`)
    }
  }

  protected emitUiState(): void {
    if (this.disposed || !this.options.onUiChanged) return
    this.emitUi({ kind: 'state', state: this.ui.snapshot() })
  }

  /** The `ui.render` sites some loaded hook may draw — "an unhooked site is
   *  never asked for". A matcher naming no component hooks every
   *  site; one naming a site this surface does not draw hooks none. */
  renderSites(): Array<{ plugin: string; component?: RenderSite; requestId?: string }> {
    if (this.disposed) return []
    return this.dispatcher.matchersFor('ui.render').flatMap(({ plugin, matcher }) => {
      const site = renderMatcherSite(matcher)
      if (site.unraised !== undefined) return []
      return [{
        plugin,
        ...(site.component !== undefined ? { component: site.component } : {}),
        ...(site.requestId !== undefined ? { requestId: site.requestId } : {}),
      }]
    })
  }

  /**
   * `ui.render` for one instance: the chain's tree validated for this surface, or
   * `engine` (an invalid tree or props draws the engine's own). The drawing's
   * handlers replace the previous drawing's. Never rejects.
   */
  async render(
    input: {
      component: RenderSite
      requestId: string
      props: RenderInput['props']
      viewport?: RenderInput['viewport']
      /** The client drawing it: each client's drawing of a site holds its
       *  own handles, so two clients never drop each other's. */
      client?: string
    },
    signal?: AbortSignal,
  ): Promise<RenderOutcome> {
    if (this.disposed || !this.dispatcher.hasHooksFor('ui.render')) return { kind: 'engine' }
    const key = drawingKeyOf(input.component, input.requestId, input.client)
    // The latest ask for a drawing is the one its client shows: an earlier
    // one still in flight must not replace its handles when it settles.
    const ask = ++this.renderAsks
    this.latestRender.set(key, ask)
    const overtaken = (): boolean => this.latestRender.get(key) !== ask
    this.unsubscribeAll(key)
    const e: RenderInput = {
      surface: RENDER_SURFACE,
      component: input.component,
      requestId: input.requestId,
      ...(input.viewport ? { viewport: input.viewport } : {}),
      props: input.props,
    }
    let ref = 0
    const rewrites = new Map<number, EngineRewrite>()
    const core = async (arrived: unknown) => {
      const drawn = ref++
      const checked = engineRewriteOf(
        input.component,
        input.props,
        isRecord(arrived) ? arrived.props : undefined,
      )
      if (checked && !checked.ok) {
        this.options.report(
          `hooks: ui.render (${input.component}) props refused: ${checked.reason}; the engine drew the original`,
        )
      } else if (checked?.rewrite) {
        rewrites.set(drawn, checked.rewrite)
      }
      return { type: 'engine', ref: drawn }
    }
    const rewriteOf = (node: unknown): EngineRewrite | undefined =>
      isRecord(node) && typeof node.ref === 'number' ? rewrites.get(node.ref) : undefined
    let result: unknown
    let trace: readonly TraceEntry[] = []
    // Each hook's tree is checked as it answers: a refused one fails that hook
    // alone, so what the hooks beneath drew stands in its place.
    const refused: Array<{ plugin: string; tree: unknown; reason: string }> = []
    try {
      result = await this.dispatcher.dispatch('ui.render', e, core, {
        ...(signal ? { signal } : {}),
        scope: { render: { key } },
        accepts: (answer, plugin) => {
          if (!isRenderAnswer(answer)) return false
          const checked = validateRenderTree(answer)
          if (!checked.ok) refused.push({ plugin, tree: answer, reason: checked.reason })
          return checked.ok
        },
        trace: entries => {
          trace = entries
        },
      })
    } catch (error) {
      if (!signal?.aborted) {
        this.options.report(
          `mods: ui.render (${input.component}) failed: ${errorMessage(error)}; the engine drew its own`,
        )
      }
      if (overtaken()) {
        this.dropRefused(refused, this.drawings.get(key) ?? new Map())
        return { kind: 'engine' }
      }
      this.latestRender.delete(key)
      this.replaceHandles(key, new Map())
      this.dropRefused(refused, new Map())
      return { kind: 'engine' }
    }
    const held = handlesIn(result)
    if (overtaken()) {
      // Nobody shows this tree: its handlers, and the refused trees', go.
      const current = this.drawings.get(key) ?? new Map<string, Set<number>>()
      this.dropRefused([...refused, { tree: result }], current)
      return { kind: 'engine' }
    }
    this.latestRender.delete(key)
    // "The engine draws its own instead": the transcript's `<plugin>: ui.render
    // (<Component>) refused: <reason>`, for each hook whose tree was left out.
    const isEngine = isRecord(result) && result.type === 'engine'
    for (const each of refused) {
      this.options.report(
        `${each.plugin}: ui.render (${input.component}) refused: ${each.reason}; ${isEngine ? 'the engine drew its own' : 'the rest was drawn without it'}`,
      )
    }
    this.dropRefused(refused, held)
    if (isEngine) {
      this.replaceHandles(key, new Map())
      const rewrite = rewriteOf(result)
      return rewrite ? { kind: 'engine', rewrite } : { kind: 'engine' }
    }
    const validated = validateRenderTree(result)
    if (!validated.ok) {
      // "The engine draws its own instead and writes to the debug log a line
      // beginning `ui.render (<Component>): a hook returned a tree that does
      // not validate`" — and the transcript's `<plugin>: ui.render
      // (<Component>) refused: <reason>; the engine drew its own`.
      this.options.report(
        `${drawnBy(result) ?? 'hooks'}: ui.render (${input.component}) refused: ${validated.reason}; the engine drew its own`,
      )
      this.replaceHandles(key, new Map())
      // The refused tree's handlers are nobody's: dropped at once.
      for (const [plugin, handles] of held) this.instanceOf(plugin)?.dropHandles([...handles])
      return { kind: 'engine' }
    }
    this.replaceHandles(key, held)
    const plugin = drawnBy(validated.tree)
    const plugins = drewOf(trace)
    const sections = input.component === 'AbovePrompt' ? sectionsOf(trace, validated.tree, plugins) : undefined
    const drawnRewrites: Record<string, EngineRewrite> = {}
    for (const node of engineNodesIn(validated.tree)) {
      const rewrite = rewriteOf(node)
      if (rewrite) drawnRewrites[String(node.ref)] = rewrite
    }
    return {
      kind: 'tree',
      tree: validated.tree,
      ...(plugin !== undefined ? { plugin } : {}),
      ...(plugins.length > 0 ? { plugins } : {}),
      ...(sections ? { sections } : {}),
      ...(Object.keys(drawnRewrites).length > 0 ? { rewrites: drawnRewrites } : {}),
    }
  }

  /** The handlers of refused trees that the drawing does not hold: nobody's,
   *  so dropped at once. */
  protected dropRefused(
    refused: ReadonlyArray<{ tree: unknown }>,
    held: ReadonlyMap<string, ReadonlySet<number>>,
  ): void {
    for (const { tree } of refused) {
      for (const [plugin, handles] of handlesIn(tree)) {
        const kept = held.get(plugin)
        const gone = [...handles].filter(handle => !kept?.has(handle))
        if (gone.length > 0) this.instanceOf(plugin)?.dropHandles(gone)
      }
    }
  }

  /**
   * A press, a typing or a pick on an element a drawing holds: `ui.press`,
   * `ui.input`, `ui.select` — "`next(e)` runs the hooks beneath, then core:
   * the element's own closure, in its plugin's environment, resolving to
   * `{ element }`" (`{ element, value }`). Never rejects: a drawing that is
   * gone, a closure that threw, a chain that failed each answer `ok: false`
   * with the reason, said in the report.
   */
  async uiInput(
    input: {
      kind: 'press' | 'input' | 'select'
      plugin: string
      element: string
      component: RenderSite
      requestId: string
      handle: number
      inputKind?: 'change' | 'submit'
      value?: string
      link?: { href: string }
      /** The client pressing: only its own drawing's handles press. */
      client?: string
    },
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.disposed) return { ok: false, reason: 'the mod runtime is disposed' }
    const key = drawingKeyOf(input.component, input.requestId, input.client)
    const owned = this.drawings.get(key)?.get(input.plugin)?.has(input.handle) === true
    if (!owned) return { ok: false, reason: 'the drawing is gone' }
    const instance = this.instanceOf(input.plugin)
    if (!instance) return { ok: false, reason: `${input.plugin} is not loaded` }
    const event = input.kind === 'press' ? 'ui.press' : input.kind === 'input' ? 'ui.input' : 'ui.select'
    const base = {
      plugin: input.plugin,
      element: input.element,
      component: input.component,
      requestId: input.requestId,
      surface: RENDER_SURFACE,
    }
    const e: Record<string, unknown> =
      input.kind === 'press'
        ? { ...base, ...(input.link ? { link: input.link } : {}) }
        : input.kind === 'input'
          ? { ...base, kind: input.inputKind ?? 'submit', value: input.value ?? '' }
          : { ...base, value: input.value ?? '' }
    const core = async (arrived: unknown): Promise<unknown> => {
      const got = isRecord(arrived) ? arrived : e
      const value = typeof got.value === 'string' ? got.value : (e.value as string | undefined)
      if (input.kind === 'press') {
        const link = isRecord(got.link) && typeof got.link.href === 'string' ? got.link : undefined
        await instance.runHandle(input.handle, undefined, [link ? { ...got, link } : got], signal)
        return { element: input.element }
      }
      if (input.kind === 'input') {
        const which = got.kind === 'change' ? 'change' : 'submit'
        await instance.runHandle(input.handle, which, [value ?? '', got], signal)
        return { element: input.element, value: value ?? '' }
      }
      await instance.runHandle(input.handle, undefined, [value ?? '', got], signal)
      return { element: input.element, value: value ?? '' }
    }
    // While it is answered, a `$.ui.scroll` of a transcript row is the
    // person's own ask.
    this.personInputs += 1
    try {
      await this.dispatcher.dispatch(event, e, core, {
        ...(signal ? { signal } : {}),
        accepts: result => isRecord(result) && typeof result.element === 'string',
      })
      return { ok: true }
    } catch (error) {
      const reason = errorMessage(error)
      if (!signal?.aborted) this.options.report(`${input.plugin}: ${event} on ${input.element} failed: ${reason}`)
      return { ok: false, reason }
    } finally {
      this.personInputs -= 1
    }
  }

  /**
   * The person closes a pane (its close mark): `ui.close` with origin
   * `person` — "a hook answering without `next` keeps the pane open". True
   * when the pane went.
   */
  async closePane(plugin: string, id: string, signal?: AbortSignal): Promise<boolean> {
    if (this.disposed || !this.panes.get(plugin, id)) return false
    if (!this.dispatcher.hasHooksFor('ui.close')) return this.closePaneNow(plugin, id)
    let closed = false
    try {
      await this.dispatcher.dispatch(
        'ui.close',
        { id, origin: { kind: 'person' } },
        async () => {
          closed = this.closePaneNow(plugin, id)
          return { value: undefined }
        },
        { ...(signal ? { signal } : {}), accepts: () => true },
      )
    } catch (error) {
      if (!signal?.aborted) this.options.report(`mods: ui.close failed: ${errorMessage(error)}; the pane closes`)
      return this.closePaneNow(plugin, id)
    }
    return closed
  }

  /** A page's answer to a `page` request (`mods.pageAnswer`). */
  pageAnswer(answer: ModPageAnswer): boolean {
    return !this.disposed && this.page?.answer(answer) === true
  }

  /** A page's answer to a `composer` request (`mods.composerAnswer`). */
  composerAnswer(answer: ModComposerAnswer): boolean {
    return !this.disposed && this.composer?.answer(answer) === true
  }

  /** Whether any loaded hook selects `prompt.edit`: the page asks for its
   *  edits only then. */
  hasPromptEditHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('prompt.edit')
  }

  /** `prompt.edit` for one edit the person made in the page's box
   *  (`mods.promptEdit`): the box the page shows. Never rejects. */
  async promptEdit(edit: PromptEdit, signal?: AbortSignal): Promise<DecoratedPromptBox> {
    if (this.disposed) return applyPromptEdit(edit)
    return raisePromptEdit(this.dispatcher, edit, this.options.report, signal)
  }

  /** Whether any loaded hook selects `prompt.autocomplete`: the page asks
   *  for rows only then. */
  hasPromptAutocompleteHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('prompt.autocomplete')
  }

  /** `prompt.autocomplete` for the token at a page's caret
   *  (`mods.promptAutocomplete`): the rows the mods add. Never rejects. */
  async promptAutocomplete(input: PromptAutocompleteInput, signal?: AbortSignal): Promise<PromptAutocompleteSuggestion[]> {
    if (this.disposed) return []
    try {
      return await raisePromptAutocomplete(this.dispatcher, input, this.options.report, signal)
    } catch {
      return []
    }
  }

  /** Whether any loaded hook selects `prompt.change`: the page tells its
   *  box's untyped changes only then. */
  hasPromptChangeHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('prompt.change')
  }

  /** `prompt.change` for a change of the box no one typed: a page's clear or
   *  undo (`mods.promptChange`), a plugin's fill (`context` its call). Never
   *  rejects. */
  async promptChange(change: PromptChangeInput, context?: DispatchContext): Promise<void> {
    if (this.disposed) return
    await raisePromptChange(this.dispatcher, change, this.options.report, context)
  }

  /** A page's answer to a `$.ui.ask` question, or the person dismissing it
   *  (`mods.askAnswer`). False when nothing waits for it. */
  askAnswer(answer: ModUiAskAnswer): boolean {
    return !this.disposed && this.ui.answerAsk(answer)
  }

  /** The person clicked a pane's tab. */
  showPane(plugin: string, id: string): boolean {
    return !this.disposed && this.panes.showPane(plugin, id)
  }

  /** Where a client draws this session's panes (`mods.seat`), null when it
   *  stopped drawing the session: what `isPlaced` and `isShown` read. */
  seat(client: string, seat: ModPaneSeat | null): void {
    if (this.disposed || client === '') return
    this.panes.setSeat(client, seat)
  }

  protected closePaneNow(plugin: string, id: string): boolean {
    const went = this.panes.close(plugin, id)
    if (went) for (const key of this.keysOfSite('Pane', id)) this.forgetDrawing(key, plugin)
    return went
  }

  /** Every client's drawing of one site. */
  protected keysOfSite(component: string, requestId: string): string[] {
    const site = siteKeyOf(component, requestId)
    return [...this.drawings.keys()].filter(key => key.startsWith(site))
  }

  /** A client went away: its drawings, their handles in the workers and
   *  their `$.state` subscriptions go with it — nothing in the runtime
   *  outlives the client it was drawn for. */
  clientGone(client: string): void {
    if (this.disposed || client === '') return
    this.panes.setSeat(client, null)
    for (const key of [...this.drawings.keys()]) {
      if (clientOfKey(key) === client) this.forgetDrawing(key)
    }
  }

  /** `$.ui.invalidate(event)`: the plugin's drawings are asked for again,
   *  folded to ten a second. */
  protected invalidate(plugin: string, event: string): void {
    if (this.disposed) return
    // The describe caches: cleared, and the picker's list built again.
    if (event === 'tool.describe') {
      this.toolDescriptions.clear()
      return
    }
    if (event === 'command.describe') {
      this.commandCache.clear()
      this.options.onCommandsChanged?.()
      return
    }
    if (event === 'config.describe') {
      this.configDescriptions.clear()
      return
    }
    if (event !== 'ui.render') return
    if (this.invalidations.has(plugin)) return
    this.invalidations.set(
      plugin,
      setTimeout(() => {
        this.invalidations.delete(plugin)
        if (!this.disposed) this.emitUi({ kind: 'stale', stale: { plugin } })
      }, 100),
    )
  }

  protected stateWritten(address: { plugin: string; key: string; id?: string }): void {
    const readers = this.readersOf.get(stateKeyOf(address))
    if (!readers || readers.size === 0) return
    // One event per site, however many clients draw it: each redraws its own.
    const sites = new Set([...readers].map(key => JSON.stringify(drawingOfKey(key))))
    for (const site of sites) this.emitUi({ kind: 'stale', stale: JSON.parse(site) as ModUiStale })
  }

  protected subscribe(drawing: string, stateKey: string): void {
    let readers = this.readersOf.get(stateKey)
    if (!readers) {
      readers = new Set()
      this.readersOf.set(stateKey, readers)
    }
    readers.add(drawing)
    let reads = this.readsOf.get(drawing)
    if (!reads) {
      reads = new Set()
      this.readsOf.set(drawing, reads)
    }
    reads.add(stateKey)
  }

  protected unsubscribeAll(drawing: string): void {
    const reads = this.readsOf.get(drawing)
    if (!reads) return
    this.readsOf.delete(drawing)
    for (const stateKey of reads) {
      const readers = this.readersOf.get(stateKey)
      readers?.delete(drawing)
      if (readers && readers.size === 0) this.readersOf.delete(stateKey)
    }
  }

  /** The drawing was drawn again: the handlers it no longer holds are
   *  dropped in their plugins' workers. */
  protected replaceHandles(drawing: string, held: Map<string, Set<number>>): void {
    const previous = this.drawings.get(drawing)
    if (previous) {
      for (const [plugin, handles] of previous) {
        const kept = held.get(plugin)
        const gone = [...handles].filter(handle => !kept?.has(handle))
        if (gone.length > 0) this.instanceOf(plugin)?.dropHandles(gone)
      }
    }
    if (held.size === 0) this.drawings.delete(drawing)
    else this.drawings.set(drawing, held)
  }

  protected forgetDrawing(drawing: string, plugin?: string): void {
    const held = this.drawings.get(drawing)
    if (!held) return
    for (const [owner, handles] of held) {
      if (plugin !== undefined && owner !== plugin) continue
      this.instanceOf(owner)?.dropHandles([...handles])
      held.delete(owner)
    }
    if (held.size === 0) {
      this.drawings.delete(drawing)
      this.unsubscribeAll(drawing)
    }
  }

  /** The slot is disposed: pending invalidations are cancelled and every
   *  drawing's handlers and `$.state` reads are let go. */
  protected disposeUi(): void {
    for (const timer of this.invalidations.values()) clearTimeout(timer)
    this.invalidations.clear()
    this.drawings.clear()
    this.readersOf.clear()
    this.readsOf.clear()
  }

  /** A plugin unloaded or lost its worker: its panes go ("`unload` drops a
   *  pane nothing draws any more … gone before the hooks hear of it"), and
   *  its drawings are forgotten. */
  protected pluginGone(plugin: string): void {
    for (const id of this.panes.clearPlugin(plugin)) {
      for (const key of this.keysOfSite('Pane', id)) {
        this.drawings.delete(key)
        this.unsubscribeAll(key)
      }
    }
    for (const [key, held] of [...this.drawings]) {
      if (held.delete(plugin) && held.size === 0) {
        this.drawings.delete(key)
        this.unsubscribeAll(key)
      }
    }
  }
}

/** A drawing: one client's drawing of one site (`component`, `requestId`). */
function drawingKeyOf(component: string, requestId: string, client = ''): string {
  return `${siteKeyOf(component, requestId)}${client}`
}

/** The site a drawing key names. */
function drawingOfKey(key: string): ModUiStale {
  const at = key.indexOf('\u0000')
  if (at < 0) return {}
  const end = key.indexOf('\u0001', at + 1)
  return { component: key.slice(0, at), requestId: key.slice(at + 1, end < 0 ? undefined : end) }
}

function clientOfKey(key: string): string {
  const at = key.lastIndexOf('\u0001')
  return at < 0 ? '' : key.slice(at + 1)
}

/** A site's key, every client's drawing of it starting with it. */
export function siteKeyOf(component: string, requestId: string): string {
  return `${component}\u0000${requestId}\u0001`
}

export function stateKeyOf(address: { plugin: string; key: string; id?: unknown }): string {
  return `${address.plugin}\u0000${address.key}\u0000${typeof address.id === 'string' ? address.id : ''}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
