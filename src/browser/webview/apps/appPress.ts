/**
 * A press on an app's topbar icon (F-40): offered to the app's background
 * module (`mods.appPress`), whose intent this page then carries out — open
 * the app, sign a server in or out, draw a menu, or nothing. With no intent
 * the press does what it does without a module.
 * Security: the page acts on the closed set of intents alone, and starts a
 * sign-in or sign-out only when its own grant allows that action.
 */
import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import type { RouteKey } from '../../runtimeProtocol'
import { readAppPressIntent, type AppPressIntent, type AppPressMenuItem, type AppPressTrigger } from '../../runtimeProtocol/modApps'
import type { TranslateFn } from '../i18n/translate'
import { normalizeMcpServerUrl } from '../../../mcp/oauth/oauthKeys'
import { askAppSignIn, askMcpAuth, holdMcpAuthStatus, serverStateIn } from '../mcpAuthView'

export type AppPressPort = {
  /** The module's intent for the press, or null for none; never rejects. */
  ask(appId: string, trigger: AppPressTrigger, item?: string): Promise<AppPressIntent | null>
  /** Starts the sign-in of the server at `url`; `onSignedIn` runs once if it finishes signed in. */
  signIn(url: string, onSignedIn?: () => void): void
  signOut(url: string): void
}

/** What a press acts on: the app it is for, as the topbar knows it. */
export type AppPressTarget = {
  open(): void
  /** The sign-ins a press starts when the module has no say. */
  defaultSignIn(): void
  showMenu(items: AppPressMenuItem[]): void
  /** False once a later press replaced this one: its answer is dropped. */
  isCurrent(): boolean
}

const unanswered = (target: AppPressTarget, trigger: AppPressTrigger): void => {
  if (trigger !== 'primary') return
  target.open()
  target.defaultSignIn()
}

/** Runs one press. Without a port the press is carried out before this returns. */
export function runAppPress(port: AppPressPort | undefined, appId: string, target: AppPressTarget, trigger: AppPressTrigger, item?: string): void {
  if (!port) {
    unanswered(target, trigger)
    return
  }
  void port.ask(appId, trigger, item).then(intent => {
    if (!target.isCurrent()) return
    switch (intent?.kind) {
      case undefined:
        return unanswered(target, trigger)
      case 'open':
        return target.open()
      case 'signIn':
        return port.signIn(intent.url, intent.thenOpen ? () => target.open() : undefined)
      case 'signOut':
        return port.signOut(intent.url)
      case 'menu':
        return target.showMenu(intent.items)
      case 'handled':
        return undefined
    }
  })
}

/** What the port reads at each press: the connection, the page's language and its grant. */
export type AppPressContext = {
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined
  t: TranslateFn
  canSignIn: boolean
  canSignOut: boolean
}

type PressConnection = Pick<RuntimeConnection, 'request' | 'subscribe'>

/** How long a press waits on the runtime's answer before it goes on as one with none: the hook's budget and room for the wire. */
export const APP_PRESS_ANSWER_TIMEOUT_MS = 2_000

/**
 * The port over the page's runtime connection. An intent the page's grant
 * does not allow reads as none. A sign-in's `onSignedIn` waits on
 * `mcpAuth/status`: it runs when the server reads signed in, and is dropped
 * when the sign-in ends otherwise, is refused, or another press is asked.
 */
export function createAppPressPort(context: { readonly current: AppPressContext }): AppPressPort {
  let dropPending: (() => void) | null = null
  const asking = new Set<string>()
  const connect = async (): Promise<PressConnection> => {
    const { runtimeConnection } = context.current
    if (!runtimeConnection) throw new Error('no runtime connection')
    return runtimeConnection()
  }
  return {
    async ask(appId, trigger, item) {
      dropPending?.()
      try {
        const conn = await connect()
        const answer = await conn.request('mods.appPress' as RouteKey, { appId, trigger, ...(item !== undefined ? { item } : {}) }, { timeoutMs: APP_PRESS_ANSWER_TIMEOUT_MS })
        const intent = readAppPressIntent(answer)
        if (intent?.kind === 'signIn' && !context.current.canSignIn) return null
        if (intent?.kind === 'signOut' && !context.current.canSignOut) return null
        return intent
      } catch {
        return null
      }
    },
    signIn(url, onSignedIn) {
      dropPending?.()
      let release: (() => void) | null = null
      let live = onSignedIn !== undefined
      const drop = () => {
        live = false
        release?.()
        release = null
        if (dropPending === drop) dropPending = null
      }
      if (onSignedIn) {
        dropPending = drop
        let started = false
        void connect().then(
          conn => {
            if (!live) return
            release = holdMcpAuthStatus(conn, state => {
              if (!live) return
              const phase = serverStateIn(state, url)?.phase
              if (phase === 'signing-in') {
                started = true
              } else if (phase === 'signed-in') {
                drop()
                onSignedIn()
              } else if (started) {
                drop()
              }
            })
            if (!live) drop()
          },
          () => drop(),
        )
      }
      const asked = askAppSignIn(asking, context.current, url)
      if (!asked && !normalizeMcpServerUrl(url)) drop()
      void asked?.catch(err => {
        drop()
        console.warn('[mcp] app sign-in failed:', err instanceof Error ? err.message : err)
      })
    },
    signOut(url) {
      void askMcpAuth(context.current.runtimeConnection, 'signOut', { url }).catch(err => {
        console.warn('[mcp] app sign-out failed:', err instanceof Error ? err.message : err)
      })
    },
  }
}
