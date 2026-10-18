/**
 * `terminal` — the runtime's terminals on the protocol (F-31): the actions create / write / resize /
 * restart / close, the topic `terminals` (the list; snapshot and `state` deltas carry the whole object)
 * and `terminal/<id>` (size, title, state and scrollback, then `output` / `resize` / `title` / `state`
 * deltas). The service owns the terminals; this file only translates.
 * Security: every action and both topics are `full` — a terminal runs programs on the host as the person
 * and shows whatever they print. Guards refuse unknown fields, oversized writes, bad sizes, unknown shells.
 */
import { parseTopic, topic, wireError, type TopicId } from '../runtimeProtocol'
import {
  isTerminalSize,
  TERMINAL_ACTION_SCOPES,
  TERMINAL_ACTIONS,
  TERMINAL_CAPABILITY,
  TERMINAL_WRITE_MAX_BYTES,
  type TerminalAction,
  type TerminalClosePayload,
  type TerminalCreatePayload,
  type TerminalResizePayload,
  type TerminalRestartPayload,
  type TerminalWritePayload,
  type TerminalsState,
} from '../../terminal/protocol'
import type { TerminalService, TerminalServiceEvent } from '../../terminal/TerminalService'
import type { CapabilityRegistry } from './CapabilityRegistry'
import type { TopicBroker } from './TopicBroker'
import type { ActionSpec, ConnectionInfo, SnapshotPage, TopicProvider } from './types'

/** The `terminals` topic's `state` delta type. */
export const TERMINALS_STATE_EVENT = 'state'

const NO_TERMINALS: TerminalsState = { available: false, shells: [], terminals: [] }

type Dict = Record<string, unknown>
const isDict = (value: unknown): value is Dict =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === 'string'
const onlyKeys = (payload: Dict, keys: readonly string[]): boolean =>
  Object.keys(payload).every(key => keys.includes(key))

const encoder = new TextEncoder()

/** `data` within the write cap, measured in UTF-8 bytes (the code-unit count is a cheap lower bound). */
function withinWriteCap(data: string): boolean {
  if (data.length > TERMINAL_WRITE_MAX_BYTES) return false
  return encoder.encode(data).length <= TERMINAL_WRITE_MAX_BYTES
}

function guardsFor(service: TerminalService | null): Record<TerminalAction, (payload: unknown) => boolean> {
  const knownShell = (shell: unknown): boolean =>
    shell === undefined ||
    (isString(shell) && (service?.list().shells.some(known => known.id === shell) ?? false))
  return {
    create: payload =>
      isDict(payload) &&
      onlyKeys(payload, ['sessionId', 'shell', 'cols', 'rows']) &&
      isString(payload.sessionId) &&
      payload.sessionId.length > 0 &&
      knownShell(payload.shell) &&
      isTerminalSize(payload.cols, payload.rows),
    write: payload =>
      isDict(payload) &&
      onlyKeys(payload, ['id', 'data']) &&
      isString(payload.id) &&
      isString(payload.data) &&
      withinWriteCap(payload.data),
    resize: payload =>
      isDict(payload) &&
      onlyKeys(payload, ['id', 'cols', 'rows']) &&
      isString(payload.id) &&
      isTerminalSize(payload.cols, payload.rows),
    restart: payload => isDict(payload) && onlyKeys(payload, ['id']) && isString(payload.id),
    close: payload => isDict(payload) && onlyKeys(payload, ['id']) && isString(payload.id),
  }
}

const fullOnly = (_id: TopicId, conn: ConnectionInfo): boolean => conn.scope.mode === 'full'

/** `terminals`: the whole list as the snapshot, and again in every `state` delta. */
export function terminalsTopicProvider(service: TerminalService | null): TopicProvider {
  return {
    matches: id => id === topic.terminals(),
    authorize: fullOnly,
    async *snapshot(): AsyncIterable<SnapshotPage> {
      yield { type: TERMINALS_STATE_EVENT, payload: service?.list() ?? NO_TERMINALS }
    },
  }
}

/**
 * `terminal/<id>`: the terminal's size, title, state and scrollback as the
 * snapshot — what a late subscriber, or one whose `since` fell out of the
 * replay ring, gets — then its deltas. An id the service does not hold is
 * `not_found`, which is why `matches` asks the service.
 */
export function terminalTopicProvider(service: TerminalService | null): TopicProvider {
  const terminalIdOf = (id: TopicId): string | null => {
    const parsed = parseTopic(id)
    return parsed?.family === 'terminal' ? parsed.terminalId : null
  }
  return {
    matches: id => {
      const terminalId = terminalIdOf(id)
      return terminalId !== null && (service?.has(terminalId) ?? false)
    },
    authorize: fullOnly,
    async *snapshot(id): AsyncIterable<SnapshotPage> {
      const terminalId = terminalIdOf(id)
      const snapshot = terminalId === null ? undefined : service?.snapshot(terminalId)
      if (snapshot) yield { payload: snapshot }
    },
  }
}

/**
 * Register the capability and both topics on one runtime's registry and
 * broker; the service's events become topic deltas. Without a service the
 * list says unavailable and every action answers `host_unavailable`.
 */
export function registerTerminalCapability(
  registry: CapabilityRegistry,
  broker: TopicBroker,
  options: { service: TerminalService | null },
): { dispose(): void } {
  const { service } = options
  broker.registerProvider(terminalsTopicProvider(service))
  broker.registerProvider(terminalTopicProvider(service))

  const guards = guardsFor(service)
  const actions = Object.fromEntries(
    TERMINAL_ACTIONS.map(action => [
      action,
      { scope: TERMINAL_ACTION_SCOPES[action], guard: guards[action] } satisfies ActionSpec,
    ]),
  )

  registry.registerCapability({
    cap: TERMINAL_CAPABILITY,
    actions,
    handle: async request => {
      if (!service) throw wireError('host_unavailable', 'terminal: this runtime has no terminal service')
      const payload = request.payload
      switch (request.route.act as TerminalAction) {
        case 'create':
          return { id: await service.create(payload as TerminalCreatePayload) }
        case 'write': {
          const { id, data } = payload as TerminalWritePayload
          await service.write(id, data)
          return undefined
        }
        case 'resize': {
          const { id, cols, rows } = payload as TerminalResizePayload
          await service.resize(id, cols, rows)
          return undefined
        }
        case 'restart':
          await service.restart((payload as TerminalRestartPayload).id)
          return undefined
        case 'close':
          service.close((payload as TerminalClosePayload).id)
          return undefined
        default:
          throw wireError('unknown_route', `terminal has no action '${request.route.act}'`)
      }
    },
  })

  const onEvent = (event: TerminalServiceEvent): void => {
    switch (event.kind) {
      case 'list':
        broker.publish(topic.terminals(), service?.list() ?? NO_TERMINALS, { type: TERMINALS_STATE_EVENT })
        return
      case 'output':
        broker.publish(topic.terminal(event.id), { data: event.data }, { type: 'output' })
        return
      case 'resize':
        broker.publish(topic.terminal(event.id), { cols: event.cols, rows: event.rows }, { type: 'resize' })
        return
      case 'title':
        broker.publish(topic.terminal(event.id), { title: event.title }, { type: 'title' })
        return
      case 'state':
        broker.publish(topic.terminal(event.id), { state: event.state }, { type: 'state' })
        return
      case 'closed':
        broker.dropTopic(topic.terminal(event.id))
        return
    }
  }
  const unsubscribe = service?.subscribe(onEvent) ?? (() => {})
  return { dispose: () => unsubscribe() }
}
