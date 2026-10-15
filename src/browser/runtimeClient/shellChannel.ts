/**
 * The guest's side of the `shell` capability: native tab-contents layout, boot
 * progress, build info and overlay dismissal, told to the hosting page.
 * Fire-and-forget: failures are reported and dropped.
 */
import type { RouteKey } from '../runtimeProtocol'
import type { RuntimeConnection } from './RuntimeConnection'

/** The geometry the panel host positions `<main-contents-view>` to. Same shape
 *  as the legacy `ui.mainContentsLayout` payload — this is the wire the outer
 *  page already understands, moved onto the connection. */
export type ShellLayoutPayload = {
  visible: boolean
  rect?: { left: number; top: number; width: number; height: number }
}

export interface ShellChannel {
  /** Where `<main-contents-view>` goes, or that it should be hidden. */
  publishLayout(layout: ShellLayoutPayload): void
  publishBootProgress(stage: string): void
  publishBuildInfo(buildTime: string): void
  /** The interactive moment: the host may reveal the guest. */
  dismissBootWelcome(): void
}

export type ShellChannelOptions = {
  connection: () => Promise<RuntimeConnection>
  /**
   * Where the boot chrome goes: progress, build info and the reveal. Defaults
   * to `connection`. A `?rtScope=` desktop guest passes its unscoped desktop
   * connection here. The splash belongs to the desktop window, and a remote
   * client has none, so exempting it hides nothing a remote would send. The
   * layout stays on `connection`: where the native tab goes is the UI's call,
   * and a scoped run should see what a remote sees there.
   */
  bootConnection?: () => Promise<RuntimeConnection>
  onError?: (error: unknown) => void
}

export function createShellChannel(options: ShellChannelOptions): ShellChannel {
  const report = options.onError ?? (error => console.warn('[shell] publish failed:', error))
  const bootConnection = options.bootConnection ?? options.connection
  const send = (
    connection: () => Promise<RuntimeConnection>,
    route: RouteKey,
    payload: Record<string, unknown>,
  ): void => {
    void connection()
      .then(conn => conn.request(route, payload))
      .catch(report)
  }
  return {
    publishLayout: layout =>
      send(options.connection, 'shell.publishLayout', layout as Record<string, unknown>),
    publishBootProgress: stage => send(bootConnection, 'shell.publishBootProgress', { stage }),
    publishBuildInfo: buildTime => send(bootConnection, 'shell.publishBuildInfo', { buildTime }),
    dismissBootWelcome: () => send(bootConnection, 'shell.dismissBootWelcome', {}),
  }
}
