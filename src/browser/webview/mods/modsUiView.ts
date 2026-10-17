/**
 * The client's read of `mods/ui/<sessionId>` (F-25): snapshot and `state` deltas
 * replace status lines and notices; a `toast` delta adds a row for `timeoutMs`.
 * One store per (connection, session), released by the last listener.
 */
import * as React from 'react'

import {
  MODS_CAPABILITY,
  MODS_UI_COMPOSER_EVENT,
  MODS_UI_PAGE_EVENT,
  MODS_UI_STALE_EVENT,
  MODS_UI_STATE_EVENT,
  MODS_UI_TOAST_EVENT,
  isModToastPayload,
  isModsComposerRequest,
  isModsPageRequest,
  isModsUiStalePayload,
  isModsUiState,
  topic,
  type ModsAskAnswer,
  type ModsComposerAnswer,
  type ModsComposerRequest,
  type ModsPageAnswer,
  type ModsPageRequest,
  type ModsPromptAutocompleteQuery,
  type ModsPromptAutocompleteResult,
  type ModsPromptChange,
  type ModsPromptEdit,
  type ModsPromptEditResult,
  type ModsRenderResult,
  type ModsUiInputResult,
} from '../../runtimeProtocol'
import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import type { ModUiContextValue, ModUiToastRow } from '../../../components/assistant-ui/mod-ui-context'
import { EMPTY_MOD_UI, staleKeyOf } from '../../../components/assistant-ui/mod-ui-context'

export type ModsUiView = Pick<ModUiContextValue, 'isLoaded' | 'status' | 'notices' | 'toasts' | 'panes' | 'hooked' | 'editHooked' | 'autocompleteHooked' | 'changeHooked' | 'stale' | 'turnNote' | 'asks' | 'view'>

type Listener = (view: ModsUiView) => void

type ToastTimer = { row: ModUiToastRow; timer: ReturnType<typeof setTimeout> | null; left: number; since: number }

type Store = {
  view: ModsUiView
  listeners: Set<Listener>
  unsubscribe: (() => void) | null
  toasts: Map<string, ToastTimer>
  nextId: number
  /** Who answers the session's `composer` requests: the composer the page
   *  draws for it. None registered → the request is left unanswered. */
  composers: Set<(request: ModsComposerRequest) => void>
  /** Who answers the session's `page` requests (`$.ui.copy` / `.focus` /
   *  `.scroll`): the thread the page draws for it. */
  pages: Set<(request: ModsPageRequest) => void>
}

const stores = new WeakMap<Pick<RuntimeConnection, 'subscribe'>, Map<string, Store>>()

const emptyView = (): ModsUiView => ({ status: [], notices: [], toasts: [], panes: [], hooked: [], stale: { all: 0, sites: {} }, asks: [] })

function storeFor(connection: Pick<RuntimeConnection, 'subscribe'>, sessionId: string): Store {
  let bySession = stores.get(connection)
  if (!bySession) {
    bySession = new Map()
    stores.set(connection, bySession)
  }
  let store = bySession.get(sessionId)
  if (!store) {
    store = { view: emptyView(), listeners: new Set(), unsubscribe: null, toasts: new Map(), nextId: 0, composers: new Set(), pages: new Set() }
    bySession.set(sessionId, store)
  }
  return store
}

function emit(store: Store): void {
  for (const each of Array.from(store.listeners)) each(store.view)
}

function removeToast(store: Store, id: string): void {
  const held = store.toasts.get(id)
  if (!held) return
  if (held.timer) clearTimeout(held.timer)
  store.toasts.delete(id)
  store.view = { ...store.view, toasts: store.view.toasts.filter(row => row.id !== id) }
  emit(store)
}

function startTimer(store: Store, held: ToastTimer): void {
  held.since = Date.now()
  held.timer = setTimeout(() => removeToast(store, held.row.id), held.left)
}

/** Controls over the session's toasts, for the context's `dismissToast` and
 *  `holdToast`. */
export function modsUiToastControls(
  connection: Pick<RuntimeConnection, 'subscribe'>,
  sessionId: string,
): Pick<ModUiContextValue, 'dismissToast' | 'holdToast'> {
  const store = storeFor(connection, sessionId)
  return {
    dismissToast: id => removeToast(store, id),
    holdToast: (id, isHeld) => {
      const held = store.toasts.get(id)
      if (!held) return
      if (isHeld) {
        if (held.timer) {
          clearTimeout(held.timer)
          held.timer = null
          held.left = Math.max(250, held.left - (Date.now() - held.since))
        }
      } else if (!held.timer) {
        startTimer(store, held)
      }
    },
  }
}

export function holdModsUiView(
  connection: Pick<RuntimeConnection, 'subscribe'>,
  sessionId: string,
  listener: Listener,
): () => void {
  const store = storeFor(connection, sessionId)
  store.listeners.add(listener)
  if (store.unsubscribe === null) {
    store.unsubscribe = connection.subscribe<unknown>(topic.modsUi(sessionId), event => {
      if (event.type === MODS_UI_COMPOSER_EVENT) {
        // `$.prompt.read` / `.fill` / `.suggest`: the latest composer
        // mounted for the session answers; none, and the runtime times out.
        if (!isModsComposerRequest(event.payload)) return
        const answerer = [...store.composers].at(-1)
        answerer?.(event.payload)
        return
      }
      if (event.type === MODS_UI_PAGE_EVENT) {
        // The latest thread mounted for the session answers; none, and the
        // runtime times out (another page may answer).
        if (!isModsPageRequest(event.payload)) return
        const answerer = [...store.pages].at(-1)
        answerer?.(event.payload)
        return
      }
      if (event.type === MODS_UI_TOAST_EVENT) {
        if (!isModToastPayload(event.payload)) return
        const row: ModUiToastRow = { id: `t${++store.nextId}`, ...event.payload }
        const held: ToastTimer = { row, timer: null, left: row.timeoutMs, since: Date.now() }
        store.toasts.set(row.id, held)
        startTimer(store, held)
        store.view = { ...store.view, toasts: [...store.view.toasts, row] }
        emit(store)
        return
      }
      if (event.type === MODS_UI_STALE_EVENT) {
        // A drawing is to be asked for again: one site's counter,
        // or every site's when only the plugin is named.
        if (!isModsUiStalePayload(event.payload)) return
        const { component, requestId } = event.payload
        const stale =
          component !== undefined && requestId !== undefined
            ? {
                ...store.view.stale,
                sites: {
                  ...store.view.stale.sites,
                  [staleKeyOf(component, requestId)]: (store.view.stale.sites[staleKeyOf(component, requestId)] ?? 0) + 1,
                },
              }
            : { ...store.view.stale, all: store.view.stale.all + 1 }
        store.view = { ...store.view, stale }
        emit(store)
        return
      }
      if (!isModsUiState(event.payload)) return
      const { turnNote: _previousNote, ...kept } = store.view
      store.view = {
        ...kept,
        isLoaded: true,
        status: event.payload.status,
        notices: event.payload.notices,
        panes: event.payload.panes ?? [],
        hooked: event.payload.hooked ?? [],
        editHooked: event.payload.editHooked === true,
        autocompleteHooked: event.payload.autocompleteHooked === true,
        changeHooked: event.payload.changeHooked === true,
        asks: event.payload.asks ?? [],
        ...(event.payload.turnNote ? { turnNote: event.payload.turnNote } : {}),
        ...(event.payload.view ? { view: event.payload.view } : {}),
      }
      emit(store)
    })
  } else {
    listener(store.view)
  }
  return () => {
    if (!store.listeners.delete(listener)) return
    if (store.listeners.size > 0) return
    store.unsubscribe?.()
    store.unsubscribe = null
    for (const id of [...store.toasts.keys()]) {
      const held = store.toasts.get(id)
      if (held?.timer) clearTimeout(held.timer)
    }
    store.toasts.clear()
    store.view = emptyView()
  }
}

/** The drawing actions over the connection, for the context: each
 *  absent when the connection's scope cannot do it. */
export function modsUiActions(
  connection: Pick<RuntimeConnection, 'request' | 'can'>,
  sessionId: string,
): Pick<ModUiContextValue, 'render' | 'uiInput' | 'closePane' | 'showPane' | 'reportSeat' | 'answerAsk'> {
  const can = (act: string): boolean => {
    try {
      return connection.can(MODS_CAPABILITY, act)
    } catch {
      return false
    }
  }
  return {
    ...(can('render')
      ? {
          render: async input => {
            const result = await connection.request<ModsRenderResult>('mods.render', { sessionId, ...input })
            return result && typeof result === 'object' && (result.kind === 'engine' || result.kind === 'tree')
              ? result
              : { kind: 'engine' }
          },
        }
      : {}),
    ...(can('uiInput')
      ? {
          uiInput: async input => {
            const result = await connection.request<ModsUiInputResult>('mods.uiInput', { sessionId, ...input })
            return { ok: result?.ok === true }
          },
        }
      : {}),
    ...(can('closePane')
      ? {
          closePane: async (plugin, id) => {
            await connection.request('mods.closePane', { sessionId, plugin, id })
          },
        }
      : {}),
    ...(can('showPane')
      ? {
          showPane: async (plugin, id) => {
            await connection.request('mods.showPane', { sessionId, plugin, id })
          },
        }
      : {}),
    ...(can('seat')
      ? {
          reportSeat: async (seat, showing) => {
            await connection.request('mods.seat', {
              sessionId,
              seat,
              ...(seat === 'dock-visible' && showing ? { showing } : {}),
            })
          },
        }
      : {}),
    ...(can('askAnswer')
      ? {
          answerAsk: async (answer: ModsAskAnswer) => {
            await connection.request('mods.askAnswer', { sessionId, ...answer })
          },
        }
      : {}),
  }
}

/** The prompt box's half of the round trip: hear the session's
 *  `composer` requests and answer them. Absent where the connection may not
 *  answer (`mods.composerAnswer` is `control`): the box is the runtime's to
 *  see as headless. */
export function modsComposerControls(
  connection: Pick<RuntimeConnection, 'subscribe' | 'request' | 'can'>,
  sessionId: string,
): Pick<ModUiContextValue, 'onComposerRequest' | 'answerComposer' | 'promptEdit' | 'promptAutocomplete' | 'promptChange'> {
  const can = (action: 'composerAnswer' | 'promptEdit' | 'promptAutocomplete' | 'promptChange'): boolean => {
    try {
      return connection.can(MODS_CAPABILITY, action)
    } catch {
      return false
    }
  }
  const promptEdit = {
    ...(can('promptEdit')
      ? {
          promptEdit: async (edit: ModsPromptEdit) =>
            (await connection.request<ModsPromptEditResult>('mods.promptEdit', { sessionId, edit })).box,
        }
      : {}),
    ...(can('promptAutocomplete')
      ? {
          promptAutocomplete: async (query: ModsPromptAutocompleteQuery) =>
            (await connection.request<ModsPromptAutocompleteResult>('mods.promptAutocomplete', { sessionId, query }))
              .suggestions,
        }
      : {}),
    ...(can('promptChange')
      ? {
          promptChange: async (change: ModsPromptChange) => {
            await connection.request('mods.promptChange', { sessionId, change })
          },
        }
      : {}),
  }
  if (!can('composerAnswer')) return promptEdit
  const store = storeFor(connection, sessionId)
  return {
    ...promptEdit,
    onComposerRequest: listener => {
      store.composers.add(listener)
      return () => {
        store.composers.delete(listener)
      }
    },
    answerComposer: async (answer: ModsComposerAnswer) => {
      await connection.request('mods.composerAnswer', { sessionId, ...answer })
    },
  }
}

/** The page's half of `$.ui.copy` / `.focus` / `.scroll`: hear the
 *  session's `page` requests and answer them. Absent where the connection may
 *  not answer (`mods.pageAnswer` is `control`). */
export function modsPageControls(
  connection: Pick<RuntimeConnection, 'subscribe' | 'request' | 'can'>,
  sessionId: string,
): Pick<ModUiContextValue, 'onPageRequest' | 'answerPage'> {
  let allowed = false
  try {
    allowed = connection.can(MODS_CAPABILITY, 'pageAnswer')
  } catch {
    allowed = false
  }
  if (!allowed) return {}
  const store = storeFor(connection, sessionId)
  return {
    onPageRequest: listener => {
      store.pages.add(listener)
      return () => {
        store.pages.delete(listener)
      }
    },
    answerPage: async (answer: ModsPageAnswer) => {
      await connection.request('mods.pageAnswer', { sessionId, ...answer })
    },
  }
}

/** The context value for one session's thread: nothing until the connection
 *  and the first snapshot are there. */
export function useModsUiView(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
  sessionId: string | undefined,
): ModUiContextValue {
  // Tagged with the session it was read for: on a switch, the render before
  // the new session's view lands must not show (or let the shell fold into
  // the new session's Right Panel) the previous session's panes.
  const [held, setHeld] = React.useState<{ sessionId: string; value: ModUiContextValue } | null>(null)
  React.useEffect(() => {
    if (!runtimeConnection || !sessionId) {
      setHeld(null)
      return
    }
    let live = true
    let release: (() => void) | null = null
    void runtimeConnection().then(
      conn => {
        if (!live) return
        const controls = modsUiToastControls(conn, sessionId)
        const actions = {
          ...modsUiActions(conn, sessionId),
          ...modsComposerControls(conn, sessionId),
          ...modsPageControls(conn, sessionId),
        }
        release = holdModsUiView(conn, sessionId, view => {
          if (live) setHeld({ sessionId, value: { ...view, ...controls, ...actions } })
        })
      },
      () => {
        // No connection → nothing drawn.
      },
    )
    return () => {
      live = false
      release?.()
    }
  }, [runtimeConnection, sessionId])
  return held !== null && held.sessionId === sessionId ? held.value : EMPTY_MOD_UI
}
