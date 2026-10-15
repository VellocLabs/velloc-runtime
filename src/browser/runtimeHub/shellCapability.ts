/**
 * `shell` — one window's chrome around a guest: the topic `shell/<panelId>` (snapshot + deltas)
 * published by the guest and read by its panel host. Security: scope `full`; a remote client may not
 * move this window's native views.
 */
import { topic, wireError, type TopicId } from '../runtimeProtocol'
import type { CapabilityRegistry } from './CapabilityRegistry'
import type { TopicBroker } from './TopicBroker'
import type { ConnectionInfo, SnapshotPage, TopicProvider } from './types'

export const SHELL_CAPABILITY = 'shell'

/**
 * The panel a connection belongs to when nexus-init did not say. One window is
 * the shape this had before panels were addressable, and it keeps a host that
 * predates the `panelId` handshake working: guest and panel agree on the same
 * id, so they meet on the same topic.
 */
export const DEFAULT_PANEL_ID = 'panel'

export type ShellLayout = {
  visible: boolean
  rect?: { left: number; top: number; width: number; height: number }
}

export type ShellState = {
  layout: ShellLayout | null
  bootProgress: { stage: string } | null
  buildInfo: { buildTime: string } | null
  /** The guest reached its interactive moment: the boot overlay is done. */
  dismissed: boolean
  /** The session whose runtime build drives this panel's boot progress. */
  bootStageSource?: string
}

export const SHELL_ACTIONS = [
  'publishLayout',
  'publishBootProgress',
  'publishBuildInfo',
  'dismissBootWelcome',
] as const
export type ShellAction = (typeof SHELL_ACTIONS)[number]

/** The event `type` each action publishes — what the panel host switches on. */
export const SHELL_EVENT_OF: Record<ShellAction, string> = {
  publishLayout: 'layout',
  publishBootProgress: 'bootProgress',
  publishBuildInfo: 'buildInfo',
  dismissBootWelcome: 'dismissed',
}

export function panelIdOf(conn: ConnectionInfo): string {
  return conn.panelId ?? DEFAULT_PANEL_ID
}

/** Per-panel state, so a late subscriber gets a snapshot rather than silence. */
export class ShellStateTable {
  private readonly byPanel = new Map<string, ShellState>()

  stateOf(panelId: string): ShellState {
    const existing = this.byPanel.get(panelId)
    if (existing) return existing
    const fresh: ShellState = { layout: null, bootProgress: null, buildInfo: null, dismissed: false }
    this.byPanel.set(panelId, fresh)
    return fresh
  }

  apply(panelId: string, action: ShellAction, payload: Record<string, unknown>): void {
    const state = this.stateOf(panelId)
    switch (action) {
      case 'publishLayout':
        state.layout = payload as ShellLayout
        return
      case 'publishBootProgress':
        state.bootProgress = payload as { stage: string }
        return
      case 'publishBuildInfo':
        state.buildInfo = payload as { buildTime: string }
        return
      case 'dismissBootWelcome':
        state.dismissed = true
        return
    }
  }

  /** Whether the boot overlay has been dismissed for this panel. */
  isDismissed(panelId: string): boolean {
    return this.byPanel.get(panelId)?.dismissed ?? false
  }

  /**
   * Whether `sessionId` may report boot progress for this panel.
   *
   * The FIRST session to report latches the source: a second, slower runtime
   * build re-reporting an earlier stage would walk the overlay backwards. And
   * once the overlay is gone, nobody reports at all.
   */
  claimsBootStage(panelId: string, sessionId: string): boolean {
    const state = this.stateOf(panelId)
    if (state.dismissed) return false
    if (state.bootStageSource === undefined) {
      state.bootStageSource = sessionId
      return true
    }
    return state.bootStageSource === sessionId
  }
}

function isShellAction(value: string): value is ShellAction {
  return (SHELL_ACTIONS as readonly string[]).includes(value)
}

function isPayload(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** `shell/<panelId>`: snapshot of the panel's state, then deltas. */
export function shellTopicProvider(table: ShellStateTable): TopicProvider {
  return {
    matches: (id: TopicId) => id.startsWith('shell/'),
    // One window's chrome: `full`, and only the panel the connection belongs to.
    authorize: (id, conn) =>
      conn.scope.mode === 'full' && id === topic.shell(panelIdOf(conn)),
    async *snapshot(id): AsyncIterable<SnapshotPage> {
      const state = table.stateOf(id.slice('shell/'.length))
      yield { payload: state }
    },
  }
}

export function registerShellCapability(
  registry: CapabilityRegistry,
  broker: TopicBroker,
  table: ShellStateTable,
): void {
  const actions: Record<string, { scope: 'full' }> = {}
  for (const act of SHELL_ACTIONS) actions[act] = { scope: 'full' }

  registry.registerCapability({
    cap: SHELL_CAPABILITY,
    actions,
    handle: async request => {
      const act = request.route.act
      if (!isShellAction(act)) {
        throw wireError('unknown_route', `shell has no action '${act}'`)
      }
      const payload = isPayload(request.payload) ? request.payload : {}
      const panelId = panelIdOf(request.conn)
      table.apply(panelId, act, payload)
      broker.publish(topic.shell(panelId), payload, { type: SHELL_EVENT_OF[act] })
      return undefined
    },
  })
}
