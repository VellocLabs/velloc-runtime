/**
 * The page-facing `$` nouns (F-25): `$.ui` (status line, panes, page calls, notify, place,
 * selection, view), `$.theme`, and `$.prompt` (fill, paint, suggest, compose, media), with the
 * host lookups and prompt-box helpers only they use.
 */

import { uiAskArgsOf, type ModUiAskArgs } from './modUi'
import {
  isUiSelectionResult,
  uiCopy,
  uiCopyArgsOf,
  uiFocus,
  uiFocusArgsOf,
  uiScroll,
  uiScrollArgsOf,
  uiSelectionCore,
  type ModPageCall,
  type UiCopyArgs,
  type UiFocusArgs,
  type UiScrollArgs,
} from './modPage'
import { uiBlit, uiBlitArgsOf, type UiBlitArgs } from './modBlit'
import { isPaneId } from './modRender'
import { isUiPlaceResult, uiPlaceArgsOf, type UiPlaceArgs } from './modPlaces'
import { isThemeResult, themeSetArgsOf } from './modTheme'
import { isPaneBackground, type ModPaneOpenArgs } from './modPanes'
import {
  isUiCancelNotifyResult,
  isUiNotifyResult,
  uiCancelNotifyArgsOf,
  uiCancelNotifyCore,
  uiNotifyArgsOf,
  uiNotifyCore,
} from './modNotify'
import { isUiViewResult, uiViewArgsOf, uiViewCore } from './modAgentView'
import { promptMediaArgsOf, promptMediaOf, type PromptMediaArgs } from './modManagedReads'
import {
  pluginPromptArgsOf,
  promptComposeArgsOf,
  type ModPromptHost,
  type PluginPromptArgs,
  type PromptComposeArgs,
} from './promptNouns'
import {
  EMPTY_PROMPT_BOX,
  HEADLESS_COMPOSER,
  PROMPT_FILL_MODES,
  isDecoration,
  isPromptBox,
  isPromptPainted,
  promptFillArgsOf,
  promptSuggestArgsOf,
  promptPaintArgsOf,
  withoutInvisible,
  type ModComposerHost,
  type PromptBox,
  type PromptFillArgs,
  type PromptFillMode,
  type PromptFillRefusal,
  type PromptDecoration,
  type PromptFilled,
  type PromptPainted,
  type PromptSuggestArgs,
} from './modComposer'
import type { ModNounHost, ModPaneHost, NounContext, NounMethod } from './modNouns'
import { VOID, isRecord, notSupported, isOpResult, type OpResult } from './modNounKit'

export const UI_NOUNS: Record<string, Record<string, NounMethod>> = {
  ui: Object.assign(Object.create(null), {
    // `e` is `{ text }`; "`text` undefined clears the line". A hook above may
    // rewrite the text. Shown as the calling plugin's line, whatever a hook
    // does to it.
    status: {
      ...VOID,
      input: (args: readonly unknown[]) => {
        if (args[0] !== undefined && typeof args[0] !== 'string') {
          throw new TypeError('$.ui.status(text): text must be a string, or undefined to clear it')
        }
        return { text: args[0] }
      },
      run: (e: unknown, { call, session }: NounContext) => {
        const text = isRecord(e) ? e.text : undefined
        uiHost(session).setStatus(call.plugin, typeof text === 'string' ? text : undefined)
      },
    },
    // `e` is `{ text, timeoutMs? }`.
    toast: {
      ...VOID,
      input: (args: readonly unknown[]) => {
        if (typeof args[0] !== 'string') throw new TypeError('$.ui.toast(text): text must be a string')
        const timeoutMs = isRecord(args[1]) ? args[1].timeoutMs : undefined
        if (timeoutMs !== undefined && typeof timeoutMs !== 'number') {
          throw new TypeError('$.ui.toast: timeoutMs must be a number')
        }
        return { text: args[0], ...(timeoutMs !== undefined ? { timeoutMs } : {}) }
      },
      run: (e: unknown, { call, session }: NounContext) => {
        const text = isRecord(e) && typeof e.text === 'string' ? e.text : ''
        const timeoutMs = isRecord(e) && typeof e.timeoutMs === 'number' ? e.timeoutMs : undefined
        uiHost(session).toast(call.plugin, text, timeoutMs)
      },
    },
    // `e` is `{ text, title?, key?, delayMs?, at?, untilBack? }`: the
    // `Notification` hooks run, now or when booked, then no channel writes on
    // the desktop (`modNotify.ts`).
    notify: {
      input: (args: readonly unknown[]) => uiNotifyArgsOf(args[0], args[1]),
      run: (e: unknown, { call, session }: NounContext) => uiNotifyCore(e, call, session.notifications),
      accepts: isUiNotifyResult,
    },
    // `e` is `{ key }`: drops the caller's booking not yet due (`modNotify.ts`).
    cancelNotify: {
      input: (args: readonly unknown[]) => uiCancelNotifyArgsOf(args[0]),
      run: (e: unknown, { call, session }: NounContext) => uiCancelNotifyCore(e, call, session.notifications),
      accepts: isUiCancelNotifyResult,
    },
    // `e` is `{ agentId? }`: the view published on the slot's state for the
    // page; an id that is no agent of this session is answered `{ deny }`
    // (`modAgentView.ts`).
    view: {
      input: (args: readonly unknown[]) => uiViewArgsOf(args[0]),
      run: (e: unknown, { session }: NounContext) => {
        const ui = uiHost(session)
        if (!ui.setView) return notSupported('$.ui.view is not available: this session draws nothing')
        const setView = ui.setView.bind(ui)
        return uiViewCore(e, session.agents, view => setView(view))
      },
      accepts: isUiViewResult,
    },
    // `e` is `{ tool_use_id, text }`; the id is identity, pinned.
    notice: {
      ...VOID,
      input: (args: readonly unknown[]) => {
        if (typeof args[0] !== 'string' || args[0] === '') {
          throw new TypeError('$.ui.notice(tool_use_id, text): tool_use_id must be a non-empty string')
        }
        if (args[1] !== undefined && typeof args[1] !== 'string') {
          throw new TypeError('$.ui.notice(tool_use_id, text): text must be a string, or undefined to remove it')
        }
        return { tool_use_id: args[0], text: args[1] }
      },
      run: (e: unknown, { call, session }: NounContext) => {
        const text = isRecord(e) ? e.text : undefined
        uiHost(session).setNotice(call.plugin, call.args[0] as string, typeof text === 'string' ? text : undefined)
      },
    },
    // "Asks the user `question` in the engine's own AskUserQuestion dialog
    // and resolves to the label they chose, or the text typed under
    // 'Other' … A `tool.call` of `AskUserQuestion` through every hook but
    // the calling one." Raised by the host as `tool.call`, not as `ui.ask`
    // (`ModRuntime.askPerson`, `modAsk.ts`).
    ask: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => uiAskArgsOf(args[0], args[1]),
      run: (e: unknown, { call, session }: NounContext) => {
        const host = uiHost(session)
        if (!host.ask) return notSupported('$.ui.ask is not available: no one to ask in this session')
        return host.ask(call.plugin, e as ModUiAskArgs, {
          context: call.context,
          ...(call.signal ? { signal: call.signal } : {}),
        })
      },
    },
    // "Puts `text` on the clipboard of a surface the session draws on …
    // Raised as `ui.copy` with that target on `e`": an op event whose
    // `{ deny }` is `reason: 'refused'`, so the noun raises it itself
    // (`modPage.ts`).
    copy: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => uiCopyArgsOf(args[0]),
      run: (e: unknown, context: NounContext) => uiCopy(e as UiCopyArgs, pageCallOf(context, 'copy')),
    },
    // `read`-like op event: what the person last selected with the mouse and
    // the row it lies in; a hook above may scrub it or deny it (`modPage.ts`).
    selection: {
      input: () => ({}),
      run: (_e: unknown, context: NounContext) => {
        const { host, signal } = pageCallOf(context, 'selection')
        return uiSelectionCore(host, signal, () => mayReadBox(context))
      },
      accepts: isUiSelectionResult,
    },
    // "Moves the focus ring of one of this plugin's sites onto an element it
    // drew there … Raised as `ui.focus`, origin `plugin`."
    focus: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => uiFocusArgsOf(args[0]),
      run: (e: unknown, context: NounContext) => uiFocus(e as UiFocusArgs, pageCallOf(context, 'focus')),
    },
    // "Scrolls something into view as the DOM's `scrollIntoView` would … A
    // site of this plugin's … moves under the event `ui.scroll`."
    scroll: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => uiScrollArgsOf(args[0]),
      run: (e: unknown, context: NounContext) => uiScroll(e as UiScrollArgs, pageCallOf(context, 'scroll')),
    },
    // "Repaints a mounted `Raster` … or swaps a keyed `Image`": raised as
    // `ui.blit`, its address and kind pinned; the desktop draws neither, so
    // core answers `{ deny }` (`modBlit.ts`).
    blit: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => uiBlitArgsOf(args[0]),
      run: (e: unknown, { call, dispatcher }: NounContext) =>
        uiBlit(e as UiBlitArgs, {
          plugin: call.plugin,
          context: call.context,
          ...(call.signal ? { signal: call.signal } : {}),
          dispatcher,
        }),
    },
    // "Show state without starting a turn": a line in the debug log. `e` is
    // `{ text, to }`; `to` is always `debug` here (nothing is drawn on screen
    // for it in Velloc), and a hook rewriting it changes nothing.
    log: {
      ...VOID,
      input: (args: readonly unknown[]) => ({
        text: typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0]),
        to: 'debug',
      }),
      run: (e: unknown, { call, report }: NounContext) => {
        const text = isRecord(e) && typeof e.text === 'string' ? e.text : JSON.stringify(e)
        report(`${call.plugin}: ${text}`)
      },
    },
    // `$.ui.open({ id, title, focus, closeOnEscape, holdToasts, backgroundColor, rows, columns, placement })`
    // "a hook above the opener may retitle it or refuse it with
    // `{ deny }`, never rename it" — `id` is pinned. Core: the slot's roster.
    open: {
      input: (args: readonly unknown[]) => {
        const pane = args[0]
        if (!isRecord(pane) || !isPaneId(pane.id)) {
          throw new TypeError('$.ui.open(pane): pane.id must be 1-64 of letters, digits, _ and -')
        }
        if (pane.title !== undefined) {
          if (typeof pane.title !== 'string') throw new TypeError('$.ui.open: title must be a string')
          // eslint-disable-next-line no-control-regex
          if (/[\x00-\x1f\x7f]/.test(pane.title)) throw new TypeError('$.ui.open: title holds a control character')
        }
        for (const flag of ['focus', 'closeOnEscape', 'holdToasts'] as const) {
          if (pane[flag] !== undefined && pane[flag] !== true) throw new TypeError(`$.ui.open: ${flag} is true or absent`)
        }
        for (const size of ['rows', 'columns'] as const) {
          const value = pane[size]
          if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 1)) {
            throw new TypeError(`$.ui.open: ${size} is a whole number of at least 1`)
          }
        }
        if (pane.backgroundColor !== undefined && !isPaneBackground(pane.backgroundColor)) {
          throw new TypeError('$.ui.open: backgroundColor is a theme key, a raw color or "transparent"')
        }
        return {
          id: pane.id,
          ...(pane.title !== undefined ? { title: pane.title } : {}),
          ...(pane.focus === true ? { focus: true } : {}),
          ...(pane.closeOnEscape === true ? { closeOnEscape: true } : {}),
          ...(pane.holdToasts === true ? { holdToasts: true } : {}),
          ...(pane.backgroundColor !== undefined ? { backgroundColor: pane.backgroundColor } : {}),
          ...(pane.rows !== undefined ? { rows: pane.rows } : {}),
          ...(pane.columns !== undefined ? { columns: pane.columns } : {}),
          // Any other placement is ignored, not refused.
          ...(pane.placement === 'widget' ? { placement: 'widget' } : {}),
        }
      },
      run: (e: unknown, { call, session }: NounContext) => {
        const asked = call.args[0] as { id: string }
        const arrived = isRecord(e) ? e : {}
        const title = typeof arrived.title === 'string' ? arrived.title : undefined
        return paneHost(session).open(call.plugin, {
          ...(arrived as ModPaneOpenArgs),
          ...(title !== undefined ? { title } : {}),
          // Pinned: "`next(e)` passes it on" — a rename is ignored by core.
          id: asked.id,
        })
      },
      accepts: (result: unknown) => isRecord(result) && typeof result.isPlaced === 'boolean',
    },
    // `$.ui.place({ id })`: an op event, `id` pinned; core the slot's rows.
    place: {
      input: (args: readonly unknown[]) => uiPlaceArgsOf(args[0]),
      run: (_e: unknown, { call, session }: NounContext) => {
        if (!session.places) return notSupported('$.ui.place is not available: this session draws no transcript')
        return session.places.place(call.plugin, (call.args[0] as UiPlaceArgs).id)
      },
      accepts: isUiPlaceResult,
    },
    // `$.ui.close({ id })`: `e` is `{ id, origin: { kind: 'plugin' } }`; "a hook
    // that answers without `next` keeps the pane open". Core closes it.
    close: {
      ...VOID,
      input: (args: readonly unknown[]) => {
        const pane = args[0]
        if (!isRecord(pane) || !isPaneId(pane.id)) throw new TypeError('$.ui.close(pane): pane.id must be a pane id')
        return { id: pane.id, origin: { kind: 'plugin' } }
      },
      run: (_e: unknown, { call, session }: NounContext) => {
        paneHost(session).close(call.plugin, (call.args[0] as { id: string }).id)
      },
    },
    // `$.ui.panes()`: "this plugin's own open panes … the engine's record".
    panes: {
      run: (_e: unknown, { call, session }: NounContext) =>
        paneHost(session)
          .list(call.plugin)
          .map(pane => ({
            id: pane.id,
            title: pane.title,
            isShown: pane.isShown,
            isFocused: pane.isFocused,
            isPlaced: pane.isPlaced,
          })),
      accepts: (result: unknown) => Array.isArray(result),
    },
    // `$.ui.invalidate(event)`: "re-runs an event whose results the engine
    // caches: `ui.render` draws the instances this plugin may draw again".
    invalidate: {
      ...VOID,
      input: (args: readonly unknown[]) => {
        if (typeof args[0] !== 'string' || args[0] === '') throw new TypeError('$.ui.invalidate(event): event must be a string')
        return { event: args[0] }
      },
      run: (e: unknown, { call, session }: NounContext) => {
        const event = isRecord(e) && typeof e.event === 'string' ? e.event : (call.args[0] as string)
        paneHost(session).invalidate(call.plugin, event)
      },
    },
  }),
  // `$.prompt.submit` and `.compose` are "the event `prompt.<x>`" itself, the
  // plugin's own call of it: raised with the caller's context (the calling
  // hook skipped), as `$.tool.call` raises `tool.call`.
  // `$.theme.set` / `.clear`: op events, `e` the attributes (none for a
  // clear); core the session's one theme.
  theme: Object.assign(Object.create(null), {
    set: {
      input: (args: readonly unknown[]) => themeSetArgsOf(args[0]),
      run: (e: unknown, { call, session }: NounContext) => {
        if (!session.theme) return notSupported('$.theme.set is not available: this session draws no theme')
        return session.theme.set(call.plugin, themeSetArgsOf(e))
      },
      accepts: isThemeResult,
    },
    clear: {
      input: () => ({}),
      run: (_e: unknown, { session }: NounContext) => {
        if (!session.theme) return notSupported('$.theme.clear is not available: this session draws no theme')
        return session.theme.clear()
      },
      accepts: isThemeResult,
    },
  }),
  prompt: Object.assign(Object.create(null), {
    submit: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => pluginPromptArgsOf(args[0]),
      run: (e: unknown, { call, session }: NounContext) =>
        promptHost(session, 'submit').submit(e as PluginPromptArgs, {
          context: call.context,
          ...(call.signal ? { signal: call.signal } : {}),
        }),
    },
    // "The engine's own read, no event: no hook answers for it", for a
    // managed install alone (`modManagedReads.ts`).
    media: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => promptMediaArgsOf(args[0]),
      run: (e: unknown, { call }: NounContext) => promptMediaOf(e as PromptMediaArgs, call.context.origin),
    },
    // `read` is an op event: a hook above may scrub the box, or deny it.
    read: {
      input: () => ({}),
      run: (_e: unknown, { call, session }: NounContext) => composerHost(session).read(call.signal),
      accepts: isPromptBox,
    },
    // `fill` and `suggest` are the plugin's own calls of `prompt.fill` /
    // `prompt.suggest`, raised with its context, `origin` pinned.
    fill: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => promptFillArgsOf(args[0]),
      run: (e: unknown, context: NounContext) => promptFill(e as PromptFillArgs, context),
    },
    // An op event: a hook above may rewrite the runs or `{ deny }` them.
    paint: {
      input: (args: readonly unknown[]) => promptPaintArgsOf(args[0]),
      run: (e: unknown, context: NounContext) => promptPaint(e, context),
      accepts: isPromptPainted,
    },
    suggest: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => promptSuggestArgsOf(args[0]),
      run: (e: unknown, context: NounContext) => promptSuggest(e as PromptSuggestArgs, context),
    },
    compose: {
      raisesItself: true as const,
      input: (args: readonly unknown[]) => promptComposeArgsOf(args[0]),
      run: (e: unknown, { call, session }: NounContext) =>
        promptHost(session, 'compose').compose(e as PromptComposeArgs, {
          context: call.context,
          ...(call.signal ? { signal: call.signal } : {}),
        }),
    },
  }),
}

function promptHost(session: ModNounHost, method: string): ModPromptHost {
  if (!session.prompt) notSupported(`$.prompt.${method} is not available: this session takes no prompts from plugins`)
  return session.prompt!
}

function composerHost(session: ModNounHost): ModComposerHost {
  return session.composer ?? HEADLESS_COMPOSER
}

function isPinned(arrived: unknown, origin: unknown): boolean {
  const sent = isRecord(arrived) ? arrived.origin : undefined
  return sent === undefined || JSON.stringify(sent) === JSON.stringify(origin)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `$.prompt.fill` raised with the plugin origin; core is the page's box. The box
 * handed back is the caller's own `prompt.read` view. A chain that fails fills as
 * asked.
 */
async function promptFill(args: PromptFillArgs, context: NounContext): Promise<PromptFilled> {
  const { call, session, dispatcher, report } = context
  const host = composerHost(session)
  const origin = { kind: 'plugin' as const, name: call.plugin }
  const e = {
    text: args.text,
    mode: args.mode ?? ('replace' as PromptFillMode),
    origin,
    ...(args.decorations ? { decorations: args.decorations } : {}),
  }
  let core: { isFilled: boolean; refusal?: PromptFillRefusal; box: PromptBox } | undefined
  const runCore = async (arrived: unknown): Promise<{ isFilled: boolean; refusal?: PromptFillRefusal }> => {
    const input = isRecord(arrived) ? arrived : {}
    const text = withoutInvisible(typeof input.text === 'string' ? input.text : e.text)
    const mode = PROMPT_FILL_MODES.includes(input.mode as PromptFillMode) ? (input.mode as PromptFillMode) : e.mode
    const decorations = Array.isArray(input.decorations) ? (input.decorations as PromptFillArgs['decorations']) : undefined
    core = await host.fill({ text, mode, ...(decorations ? { decorations } : {}) }, call.signal, call.context)
    return { isFilled: core.isFilled, ...(core.refusal ? { refusal: core.refusal } : {}) }
  }
  let result: { isFilled?: unknown; refusal?: unknown }
  if (!dispatcher.hasHooksFor('prompt.fill')) {
    result = await runCore(e)
  } else {
    try {
      result = (await dispatcher.dispatch(
        'prompt.fill',
        e,
        async arrived => {
          if (!isPinned(arrived, origin)) throw new Error('the rewritten event is refused: origin is pinned')
          return runCore(arrived)
        },
        {
          context: call.context,
          ...(call.signal ? { signal: call.signal } : {}),
          accepts: r => isRecord(r) && typeof r.isFilled === 'boolean',
        },
      )) as { isFilled?: unknown; refusal?: unknown }
    } catch (error) {
      if (call.signal?.aborted) throw error
      if (core) {
        result = { isFilled: core.isFilled, refusal: core.refusal }
      } else {
        report(`mods: prompt.fill (${call.plugin}) failed: ${messageOf(error)}; the box is filled as asked`)
        result = await runCore(e)
      }
    }
  }
  const filled = core as { isFilled: boolean; refusal?: PromptFillRefusal; box: PromptBox } | undefined
  const isFilled = result.isFilled === true && filled?.isFilled === true
  const refusal =
    !isFilled && filled && !filled.isFilled && filled.refusal !== undefined && result.refusal === filled.refusal
      ? filled.refusal
      : undefined
  const outcome = { isFilled, ...(refusal ? { refusal } : {}) }
  if (!session.composer?.readsBox?.(call.plugin)) return { ...outcome, ...EMPTY_PROMPT_BOX }
  return { ...outcome, ...(await boxAsRead(filled?.box, context)) }
}

/** Whether the caller may see the draft as it stands: its module reads the
 *  box and no other plugin hooks `prompt.read` (a scrub the draft would skip). */
function mayReadBox({ call, session, dispatcher }: NounContext): boolean {
  if (dispatcher.matchersFor('prompt.read').some(hook => hook.plugin !== call.plugin)) return false
  return session.composer?.readsBox?.(call.plugin) === true
}

/**
 * Core of `prompt.paint`: the caller's runs over the draft, nothing else in
 * the box changed. Refused where another plugin hooks `prompt.read` (its
 * scrub of the draft would not be the draft painted) and where the caller
 * may not read the box; the box handed back is then empty.
 */
async function promptPaint(e: unknown, context: NounContext): Promise<PromptPainted> {
  const { call, session } = context
  const composer = session.composer
  if (!composer?.paint || !mayReadBox(context)) return { isPainted: false, ...EMPTY_PROMPT_BOX }
  const arrived = isRecord(e) ? e : {}
  const decorations = Array.isArray(arrived.decorations) && arrived.decorations.every(isDecoration) ? arrived.decorations : []
  const text = typeof arrived.text === 'string' ? arrived.text : undefined
  const painted = await composer.paint(
    { plugin: call.plugin, ...(text !== undefined ? { text } : {}), decorations: decorations as PromptDecoration[] },
    call.signal,
  )
  return { isPainted: painted.isPainted, ...painted.box }
}

/** The box as the caller's `$.prompt.read()` would read it: `prompt.read`
 *  with the caller's context, core the box already known (or one read). A
 *  denial is the empty box. */
async function boxAsRead(known: PromptBox | undefined, { call, session, dispatcher, report }: NounContext): Promise<PromptBox> {
  const core = async (): Promise<PromptBox> => known ?? (await composerHost(session).read(call.signal))
  if (!dispatcher.hasHooksFor('prompt.read')) return core()
  try {
    const result = (await dispatcher.dispatch('prompt.read', {}, async () => ({ value: await core() }), {
      context: call.context,
      ...(call.signal ? { signal: call.signal } : {}),
      accepts: r => isOpResult(r, isPromptBox),
    })) as OpResult
    return typeof result.deny === 'string' ? { ...EMPTY_PROMPT_BOX } : (result.value as PromptBox)
  } catch (error) {
    if (call.signal?.aborted) throw error
    report(`mods: prompt.read (${call.plugin}) failed: ${messageOf(error)}; the box is the empty box`)
    return { ...EMPTY_PROMPT_BOX }
  }
}

/**
 * `$.prompt.suggest`: `prompt.suggest` with `origin: { kind: 'plugin', name }`,
 * core the page — which shows it while the box is empty and no turn runs. A
 * blank text is not shown, asked of no page. A chain that fails proposes the
 * text as the plugin wrote it.
 */
async function promptSuggest(args: PromptSuggestArgs, { call, session, dispatcher, report }: NounContext): Promise<{ isShown: boolean }> {
  const host = composerHost(session)
  const origin = { kind: 'plugin' as const, name: call.plugin }
  const e = { text: args.text, origin }
  const core = async (arrived: unknown): Promise<{ isShown: boolean }> => {
    const input = isRecord(arrived) ? arrived : {}
    const text = withoutInvisible(typeof input.text === 'string' ? input.text : e.text)
    if (text.trim() === '') return { isShown: false }
    return host.suggest({ text }, call.signal)
  }
  if (!dispatcher.hasHooksFor('prompt.suggest')) return core(e)
  try {
    const result = (await dispatcher.dispatch(
      'prompt.suggest',
      e,
      async arrived => {
        if (!isPinned(arrived, origin)) throw new Error('the rewritten event is refused: origin is pinned')
        return core(arrived)
      },
      {
        context: call.context,
        ...(call.signal ? { signal: call.signal } : {}),
        accepts: r => isRecord(r) && typeof r.isShown === 'boolean',
      },
    )) as { isShown?: unknown }
    return { isShown: result.isShown === true }
  } catch (error) {
    if (call.signal?.aborted) throw error
    report(`mods: prompt.suggest (${call.plugin}) failed: ${messageOf(error)}; the text is proposed as written`)
    return core(e)
  }
}

function paneHost(session: ModNounHost): ModPaneHost {
  if (session.panes) return session.panes
  return notSupported('$.ui.open is not available: this session draws no panes')
}

/** What `$.ui.copy` / `.focus` / `.scroll` run with; refused by name where
 *  the slot supplies no page host. */
function pageCallOf({ call, session, dispatcher, report }: NounContext, method: string): ModPageCall {
  if (!session.page) notSupported(`$.ui.${method} is not available: this session has no page to draw on`)
  return {
    plugin: call.plugin,
    context: call.context,
    ...(call.signal ? { signal: call.signal } : {}),
    host: session.page!,
    dispatcher,
    report,
  }
}

function uiHost(session: ModNounHost): NonNullable<ModNounHost['ui']> {
  if (session.ui) return session.ui
  return notSupported('$.ui is not available: this session draws nothing')
}
