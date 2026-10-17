/**
 * `mods` — every session's mod state (F-25): `mods.list` and the `mods/state` topic, both `observe`
 * (metadata only); a session-limited connection sees only its sessions' slots. A refused, failed or
 * dead module is also a `modState` notification, once per (session, module, generation).
 */
import {
  MODS_ACTION_SCOPES,
  MODS_CAPABILITY,
  MODS_STATE_EVENT,
  MODS_STATE_TOPIC,
  MODS_UI_COMPOSER_EVENT,
  MODS_UI_PAGE_EVENT,
  MODS_UI_STALE_EVENT,
  MODS_UI_STATE_EVENT,
  MODS_UI_TOAST_EVENT,
  MODS_UI_TOPIC_PREFIX,
  isModsAskAnswerPayload,
  isModsComposerAnswerPayload,
  isModsPromptEditPayload,
  isModsPromptAutocompletePayload,
  isModsPromptChangePayload,
  isModsListPayload,
  isModsPageAnswerPayload,
  isModsPanePayload,
  isModsSeatPayload,
  isModsRenderPayload,
  isModsSetOptionsPayload,
  isModsUiInputPayload,
  parseTopic,
  topic,
  wireError,
  type ModStateRow,
  type ModsAskAnswerPayload,
  type ModsComposerAnswerPayload,
  type ModsPromptEditPayload,
  type ModsPromptAutocompletePayload,
  type ModsPromptAutocompleteResult,
  type ModsPromptChangePayload,
  type ModsPromptEditResult,
  type ModsPageAnswerPayload,
  type ModsRenderPayload,
  type ModsRenderResult,
  type ModsUiInputPayload,
  type ModsUiInputResult,
  type ModsPanePayload,
  type ModsSeatPayload,
  type ModsSetOptionsPayload,
  type ModsSessionState,
  type ModsStatePayload,
  type RuntimeNotification,
  type TopicId,
} from '../runtimeProtocol'
import {
  modSlotDrawing,
  modSlotStates,
  modSlotUiState,
  onModSlotsChanged,
  onModUiEvents,
  type ModSlotStatus,
} from '../../mods/modSlotRegistry'
import { scopeAllows, type CapabilityRegistry } from './CapabilityRegistry'
import type { TopicBroker } from './TopicBroker'
import type { ConnectionInfo, SnapshotPage, TopicProvider } from './types'

function rowOf(status: ModSlotStatus): ModStateRow {
  return {
    plugin: status.plugin,
    path: status.path,
    state: status.state,
    ...(status.reason !== undefined ? { reason: status.reason } : {}),
    ...(status.generation !== undefined ? { generation: status.generation } : {}),
    ...(status.events !== undefined ? { events: [...status.events] } : {}),
    ...(status.uses !== undefined && status.uses.calls.length > 0 ? { calls: [...status.uses.calls] } : {}),
    ...(status.nouns !== undefined && status.nouns.length > 0 ? { nouns: [...status.nouns] } : {}),
    ...(status.version !== undefined ? { version: status.version } : {}),
    ...(status.description !== undefined ? { description: status.description } : {}),
    ...(status.provenance !== undefined ? { provenance: status.provenance } : {}),
    ...(status.root !== undefined ? { root: status.root } : {}),
    ...(status.tier !== undefined ? { tier: status.tier } : {}),
    ...(status.config !== undefined
      ? {
          config: {
            fields: Object.fromEntries(
              Object.entries(status.config.fields).map(([name, field]) => [
                name,
                { ...field, ...(field.options ? { options: [...field.options] } : {}) },
              ]),
            ),
            values: { ...status.config.values },
          },
        }
      : {}),
  }
}

/** The whole state, as the topic and `mods.list` answer it. */
export function modsStatePayload(): ModsStatePayload {
  return {
    sessions: modSlotStates().map(({ sessionId, mods }) => ({ sessionId, mods: mods.map(rowOf) })),
  }
}

/** The payload as `conn` may see it: its sessions' slots alone. */
export function projectModsState(payload: ModsStatePayload, conn: ConnectionInfo): ModsStatePayload {
  if (conn.scope.sessions === 'all') return payload
  const allowed = conn.scope.sessions
  return { sessions: payload.sessions.filter(session => allowed.includes(session.sessionId)) }
}

export function modsStateTopicProvider(getState: () => ModsStatePayload = modsStatePayload): TopicProvider {
  return {
    matches: (id: TopicId) => id === MODS_STATE_TOPIC,
    authorize: (_id, conn) => scopeAllows(conn.scope.mode, 'observe'),
    async *snapshot(_id, conn): AsyncIterable<SnapshotPage> {
      yield { type: MODS_STATE_EVENT, payload: projectModsState(getState(), conn) }
    },
    project: (_id, conn, evt) => projectModsState(evt.payload as ModsStatePayload, conn),
  }
}

/**
 * `mods/ui/<sessionId>` — one slot's mod-authored lines (F-25): the
 * snapshot and every `state` delta carry the status lines and the notices;
 * a `toast` delta is a moment. Session-bound: a connection sees the topic of
 * a session in its scope alone.
 */
export function modsUiTopicProvider(
  getState: (sessionId: string) => { status: unknown[]; notices: unknown[] } = modSlotUiState,
): TopicProvider {
  const sessionOf = (id: TopicId): string | undefined => {
    const parsed = parseTopic(id)
    return parsed?.family === 'modsUi' ? parsed.sessionId : undefined
  }
  return {
    matches: (id: TopicId) => id.startsWith(MODS_UI_TOPIC_PREFIX) && sessionOf(id) !== undefined,
    authorize: (id, conn) => {
      if (!scopeAllows(conn.scope.mode, 'observe')) return false
      const sessionId = sessionOf(id)
      return sessionId !== undefined && (conn.scope.sessions === 'all' || conn.scope.sessions.includes(sessionId))
    },
    async *snapshot(id): AsyncIterable<SnapshotPage> {
      const sessionId = sessionOf(id)
      yield { type: MODS_UI_STATE_EVENT, payload: sessionId ? getState(sessionId) : { status: [], notices: [] } }
    },
  }
}

/** The states a person is told about: the module is not running and will not
 *  come back on its own. */
const NOTIFIED_STATES: ReadonlySet<ModStateRow['state']> = new Set(['refused', 'failed', 'dead'])

/** What a mod notification carries beside the text: the client composes the
 *  line in the user's language from these. */
export type ModStateNotification = RuntimeNotification & {
  mod: { plugin: string; state: ModStateRow['state']; reason?: string }
}

export function registerModsCapability(
  registry: CapabilityRegistry,
  broker: TopicBroker,
  options: {
    getState?: () => ModsStatePayload
    notify?: (notification: ModStateNotification) => void
    /** `mods.reload`: every session reloads its changed mods. */
    reloadAll?: () => void
    /** The drawing half of a session's slot; defaults to the registry's. */
    drawing?: (sessionId: string) => ReturnType<typeof modSlotDrawing>
    /** `mods.setOptions`: write a plugin's `userConfig` values and reload
     *  every session's plugins. Absent: the action is refused. */
    setOptions?: (
      plugin: string,
      options: ModsSetOptionsPayload['options'],
      keep?: readonly string[],
    ) => Promise<void>
  } = {},
): { publish(): void; dispose(): void } {
  const getState = options.getState ?? modsStatePayload
  // The drawing actions reach one session's slot: a connection
  // bound to a list of sessions may draw and press in those alone.
  const inScope = (conn: ConnectionInfo, sessionId: string): boolean =>
    conn.scope.sessions === 'all' || conn.scope.sessions.includes(sessionId)
  const slotOf = (conn: ConnectionInfo, sessionId: string) => {
    if (!inScope(conn, sessionId)) throw wireError('forbidden_scope', `session ${sessionId} is not in this connection's scope`)
    return options.drawing?.(sessionId) ?? modSlotDrawing(sessionId)
  }
  registry.registerCapability({
    cap: MODS_CAPABILITY,
    actions: {
      list: { scope: MODS_ACTION_SCOPES.list, guard: isModsListPayload },
      reload: { scope: MODS_ACTION_SCOPES.reload, guard: isModsListPayload },
      render: { scope: MODS_ACTION_SCOPES.render, guard: isModsRenderPayload },
      uiInput: { scope: MODS_ACTION_SCOPES.uiInput, guard: isModsUiInputPayload },
      closePane: { scope: MODS_ACTION_SCOPES.closePane, guard: isModsPanePayload },
      showPane: { scope: MODS_ACTION_SCOPES.showPane, guard: isModsPanePayload },
      seat: { scope: MODS_ACTION_SCOPES.seat, guard: isModsSeatPayload },
      setOptions: { scope: MODS_ACTION_SCOPES.setOptions, guard: isModsSetOptionsPayload },
      composerAnswer: { scope: MODS_ACTION_SCOPES.composerAnswer, guard: isModsComposerAnswerPayload },
      promptEdit: { scope: MODS_ACTION_SCOPES.promptEdit, guard: isModsPromptEditPayload },
      promptAutocomplete: { scope: MODS_ACTION_SCOPES.promptAutocomplete, guard: isModsPromptAutocompletePayload },
      promptChange: { scope: MODS_ACTION_SCOPES.promptChange, guard: isModsPromptChangePayload },
      askAnswer: { scope: MODS_ACTION_SCOPES.askAnswer, guard: isModsAskAnswerPayload },
      pageAnswer: { scope: MODS_ACTION_SCOPES.pageAnswer, guard: isModsPageAnswerPayload },
    },
    handle: async request => {
      switch (request.route.act) {
        case 'reload':
          options.reloadAll?.()
          return {}
        case 'list':
          return projectModsState(getState(), request.conn)
        case 'render': {
          const payload = request.payload as ModsRenderPayload
          const slot = slotOf(request.conn, payload.sessionId)
          if (!slot?.render) return { kind: 'engine' } satisfies ModsRenderResult
          const drawn = await slot.render({
            component: payload.component,
            requestId: payload.requestId,
            props: payload.props as never,
            ...(payload.viewport ? { viewport: payload.viewport } : {}),
            client: request.conn.connectionId,
          })
          return drawn satisfies ModsRenderResult
        }
        case 'uiInput': {
          const payload = request.payload as ModsUiInputPayload
          const slot = slotOf(request.conn, payload.sessionId)
          if (!slot?.uiInput) return { ok: false, reason: 'the session has no mod runtime' } satisfies ModsUiInputResult
          const { sessionId: _sessionId, ...input } = payload
          return (await slot.uiInput({ ...input, client: request.conn.connectionId })) satisfies ModsUiInputResult
        }
        case 'closePane': {
          const payload = request.payload as ModsPanePayload
          const slot = slotOf(request.conn, payload.sessionId)
          return { closed: (await slot?.closePane?.(payload.plugin, payload.id)) === true }
        }
        case 'showPane': {
          const payload = request.payload as ModsPanePayload
          const slot = slotOf(request.conn, payload.sessionId)
          return { shown: slot?.showPane?.(payload.plugin, payload.id) === true }
        }
        case 'seat': {
          // Kept by connection: "client references live only on the
          // connection" — its close drops the seat (`clientGone`).
          const payload = request.payload as ModsSeatPayload
          const slot = slotOf(request.conn, payload.sessionId)
          slot?.seat?.(
            request.conn.connectionId,
            payload.seat === 'none'
              ? null
              : payload.seat === 'dock-visible'
                ? { kind: 'dock-visible', ...(payload.showing ? { showing: payload.showing } : {}) }
                : { kind: payload.seat },
          )
          return {}
        }
        case 'composerAnswer': {
          // The first page to answer settles the request; a late one is
          // told nothing waits for it.
          const { sessionId, ...answer } = request.payload as ModsComposerAnswerPayload
          const slot = slotOf(request.conn, sessionId)
          return { accepted: slot?.composerAnswer?.(answer) === true }
        }
        case 'promptEdit': {
          const { sessionId, edit } = request.payload as ModsPromptEditPayload
          const slot = slotOf(request.conn, sessionId)
          if (!slot?.promptEdit) return { box: null } satisfies ModsPromptEditResult
          return { box: await slot.promptEdit(edit) } satisfies ModsPromptEditResult
        }
        case 'promptAutocomplete': {
          const { sessionId, query } = request.payload as ModsPromptAutocompletePayload
          const slot = slotOf(request.conn, sessionId)
          if (!slot?.promptAutocomplete) return { suggestions: [] } satisfies ModsPromptAutocompleteResult
          return { suggestions: await slot.promptAutocomplete(query) } satisfies ModsPromptAutocompleteResult
        }
        case 'promptChange': {
          const { sessionId, change } = request.payload as ModsPromptChangePayload
          await slotOf(request.conn, sessionId)?.promptChange?.(change)
          return {}
        }
        case 'askAnswer': {
          // The first page to answer settles the question; a late one (the
          // person answered in another window) is told nothing waits.
          const { sessionId, ...answer } = request.payload as ModsAskAnswerPayload
          const slot = slotOf(request.conn, sessionId)
          return { accepted: slot?.askAnswer?.(answer) === true }
        }
        case 'pageAnswer': {
          // The first page to succeed settles the request; a failure waits
          // a moment for another page to do better (`modPage.ts`).
          const { sessionId, ...answer } = request.payload as ModsPageAnswerPayload
          const slot = slotOf(request.conn, sessionId)
          return { accepted: slot?.pageAnswer?.(answer) === true }
        }
        case 'setOptions': {
          const payload = request.payload as ModsSetOptionsPayload
          if (!options.setOptions) throw wireError('host_unavailable', 'this runtime stores no plugin options')
          await options.setOptions(payload.plugin, payload.options, payload.keep)
          return {}
        }
        default:
          throw wireError('unknown_route', `mods has no action '${request.route.act}'`)
      }
    },
  })
  broker.registerProvider(modsStateTopicProvider(getState))
  broker.registerProvider(modsUiTopicProvider())
  const unsubscribeUi = onModUiEvents((sessionId, event) => {
    if (event.kind === 'state') {
      broker.publish(topic.modsUi(sessionId), event.state, { type: MODS_UI_STATE_EVENT })
    } else if (event.kind === 'toast') {
      broker.publish(topic.modsUi(sessionId), event.toast, { type: MODS_UI_TOAST_EVENT })
    } else if (event.kind === 'composer') {
      broker.publish(topic.modsUi(sessionId), event.composer, { type: MODS_UI_COMPOSER_EVENT })
    } else if (event.kind === 'page') {
      broker.publish(topic.modsUi(sessionId), event.page, { type: MODS_UI_PAGE_EVENT })
    } else {
      broker.publish(topic.modsUi(sessionId), event.stale, { type: MODS_UI_STALE_EVENT })
    }
  })

  // Told once per (session, module, generation) that reached a final state.
  const told = new Set<string>()
  const tell = (state: ModsStatePayload): void => {
    if (!options.notify) return
    for (const session of state.sessions) {
      for (const row of session.mods) {
        if (!NOTIFIED_STATES.has(row.state)) continue
        const key = `${session.sessionId}\u0000${row.path}\u0000${row.generation ?? 0}\u0000${row.state}`
        if (told.has(key)) continue
        told.add(key)
        options.notify({
          // English, for a client that does not know the kind; a client that
          // does composes the line from `mod` in the user's language.
          message: describeModState(row),
          title: row.plugin,
          notificationType: `mod_${row.state}`,
          sessionId: session.sessionId,
          mod: {
            plugin: row.plugin,
            state: row.state,
            ...(row.reason !== undefined ? { reason: row.reason } : {}),
          },
        })
      }
    }
  }

  const publish = (): void => {
    const state = getState()
    broker.publish(MODS_STATE_TOPIC, state, { type: MODS_STATE_EVENT })
    tell(state)
  }
  const unsubscribe = onModSlotsChanged(() => publish())
  return {
    publish,
    dispose: () => {
      unsubscribe()
      unsubscribeUi()
      told.clear()
    },
  }
}

/** The English line behind a mod notification. */
export function describeModState(row: ModStateRow): string {
  switch (row.state) {
    case 'refused':
      return `The plugin's hooks module was refused${row.reason ? `: ${row.reason}` : ''}`
    case 'failed':
      return `The plugin's hooks module did not load${row.reason ? `: ${row.reason}` : ''}`
    case 'dead':
      return `The plugin's hooks module stopped and stays off${row.reason ? `: ${row.reason}` : ''}`
    case 'crashed':
      return `The plugin's hooks module is restarting${row.reason ? `: ${row.reason}` : ''}`
    default:
      return `The plugin's hooks module is loaded`
  }
}

export type { ModsSessionState }
