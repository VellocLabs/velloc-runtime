/**
 * The desktop guest's runtime connections. Unscoped, one connection does shell and UI work. Under
 * `?rtScope=` the UI job gets its own connection under that ceiling, and the shell job keeps an
 * unscoped desktop connection. Both open on first use.
 */
import type { RuntimeConnection } from '../runtimeClient'

type Connection = Pick<RuntimeConnection, 'request' | 'close' | 'welcome'>

export type RuntimeScopeCeiling = 'manager' | 'control' | 'observe'

export type RuntimeConnectionsOptions<C extends Connection> = {
  /** Open one connection to this page's runtime, under `ceiling` when given. */
  connect(ceiling: RuntimeScopeCeiling | undefined): Promise<C>
  /** `?rtScope=`, or undefined for the desktop's own `full`. */
  scopeCeiling: RuntimeScopeCeiling | undefined
  /** `runtime.publishHostEnvironment` over the connection it is given. */
  publishHostEnvironment(connection: C): Promise<unknown>
  /** `?rtDevRelay=` + token: dialed once the desktop connection is ready. */
  devRelay: { controlUrl: string; token: string } | null
  trace(message: string, details?: Record<string, unknown>): void
}

export type RuntimeConnections<C extends Connection> = {
  /** The UI's connection: scoped under `?rtScope=`, else the desktop one. */
  runtime(): Promise<C>
  /** The shell's unscoped connection. The same promise when unscoped. */
  desktop(): Promise<C>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function createRuntimeConnections<C extends Connection>(
  options: RuntimeConnectionsOptions<C>,
): RuntimeConnections<C> {
  let desktopAttempt: { connection: Promise<C>; published: Promise<unknown> } | null = null
  let runtimeAttempt: Promise<C> | null = null

  const openDesktop = () => {
    if (desktopAttempt) return desktopAttempt
    const connection = options.connect(undefined)
    // Sent before any `session.open` queued behind the handshake. Unscoped it
    // is not awaited: the UI rides this same connection, so the queue orders it.
    const published = connection.then(options.publishHostEnvironment)
    published.catch(error => options.trace('host environment publish failed', { message: messageOf(error) }))
    const attempt = { connection, published }
    desktopAttempt = attempt
    const { devRelay } = options
    if (devRelay) {
      connection
        .then(conn => conn.request('remote.connectRelay', { controlUrl: devRelay.controlUrl, token: devRelay.token }))
        .catch(error => options.trace('remote.connectRelay failed', { message: messageOf(error) }))
    }
    // A failed connection is forgotten, so the next caller connects afresh
    // instead of inheriting the rejection.
    connection.catch(() => {
      if (desktopAttempt === attempt) desktopAttempt = null
    })
    return attempt
  }

  const desktop = () => openDesktop().connection

  const runtime = () => {
    if (runtimeAttempt) return runtimeAttempt
    const { scopeCeiling } = options
    let attempt: Promise<C>
    if (scopeCeiling === undefined) {
      attempt = desktop()
    } else {
      // The scoped connection is handed out only once the runtime has a host
      // environment to build sessions from: a remote client may not publish it.
      const shell = openDesktop()
      attempt = shell.published.then(() => options.connect(scopeCeiling))
      attempt.catch(() => {
        // A shell that never published is started again with the next attempt.
        shell.published.catch(() => {
          if (desktopAttempt === shell) {
            desktopAttempt = null
            shell.connection.then(conn => conn.close(), () => undefined)
          }
        })
      })
    }
    runtimeAttempt = attempt
    attempt.then(
      conn =>
        options.trace('runtime connection ready', {
          connectionId: conn.welcome?.connectionId,
          capabilities: conn.welcome?.server.capabilities.length,
        }),
      error => {
        options.trace('runtime connection failed', { message: messageOf(error) })
        if (runtimeAttempt === attempt) runtimeAttempt = null
      },
    )
    return attempt
  }

  return { runtime, desktop }
}
