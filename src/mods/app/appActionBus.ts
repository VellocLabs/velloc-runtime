/**
 * The realm's way from a session's surface to an app's background module
 * (F-40): the module runtime seats one dispatch while it runs; a session's
 * surface host offers it each action the manifest names as local. Without
 * a seated dispatch, or a module for the app, no action is handled.
 * The same way carries what each client shows of an app (`app.show`,
 * `app.layout`, `app.hide`).
 */

import type { AppPressIntent, AppPressTrigger } from '../../browser/runtimeProtocol/modApps'
import type { AppViewLayout } from './appViews'

/** Offers an action to the app's module; resolves true when the module handled it. */
export type AppActionDispatch = (appId: string, action: string, context: unknown, sessionId: string) => Promise<boolean>

let seated: AppActionDispatch | undefined

/** Raises the app's `app.show` again where it is on screen; resolves once its hook settled. */
export type AppShowAgainDispatch = (appId: string) => Promise<void>

let seatedShowAgain: AppShowAgainDispatch | undefined

export function setAppShowAgainDispatch(dispatch: AppShowAgainDispatch | undefined): void {
  seatedShowAgain = dispatch
}

export function dispatchAppShowAgain(appId: string): Promise<void> {
  return seatedShowAgain ? seatedShowAgain(appId) : Promise.resolve()
}

/** Loads the app's running script again from its files; resolves once the old one stopped. */
export type AppRestartScriptDispatch = (appId: string) => Promise<void>

let seatedRestartScript: AppRestartScriptDispatch | undefined

export function setAppRestartScriptDispatch(dispatch: AppRestartScriptDispatch | undefined): void {
  seatedRestartScript = dispatch
}

export function dispatchAppRestartScript(appId: string): Promise<void> {
  return seatedRestartScript ? seatedRestartScript(appId) : dispatchAppShowAgain(appId)
}

export function setAppActionDispatch(dispatch: AppActionDispatch | undefined): void {
  seated = dispatch
}

export function dispatchAppAction(appId: string, action: string, context: unknown, sessionId: string): Promise<boolean> {
  return seated ? seated(appId, action, context, sessionId) : Promise.resolve(false)
}

/**
 * How an action offered to the app's module ended: `handled` with what the
 * hook answered as `result`, `declined` when the hook answered falsy or
 * failed, `unavailable` with no running module or hook, `timeout` past the
 * action budget.
 */
export type AppActionOutcome =
  | { status: 'handled'; result?: unknown }
  | { status: 'declined' | 'unavailable' | 'timeout' }

/** Offers an action to the app's module and says how it ended (the `AppAction` tool). */
export type AppActionOutcomeDispatch = (appId: string, action: string, context: unknown, sessionId: string) => Promise<AppActionOutcome>

let seatedOutcome: AppActionOutcomeDispatch | undefined

export function setAppActionOutcomeDispatch(dispatch: AppActionOutcomeDispatch | undefined): void {
  seatedOutcome = dispatch
}

export function dispatchAppActionOutcome(appId: string, action: string, context: unknown, sessionId: string): Promise<AppActionOutcome> {
  return seatedOutcome ? seatedOutcome(appId, action, context, sessionId) : Promise.resolve({ status: 'unavailable' })
}

/** Offers a press on an app's topbar icon to the app's module; resolves with its intent, or null for none. */
export type AppPressDispatch = (appId: string, trigger: AppPressTrigger, item: string | undefined, client: string) => Promise<AppPressIntent | null>

let seatedPress: AppPressDispatch | undefined

export function setAppPressDispatch(dispatch: AppPressDispatch | undefined): void {
  seatedPress = dispatch
}

export function dispatchAppPress(appId: string, trigger: AppPressTrigger, item: string | undefined, client: string): Promise<AppPressIntent | null> {
  return seatedPress ? seatedPress(appId, trigger, item, client) : Promise.resolve(null)
}

/** Where the module runtime takes what each client shows of an app (`AppBackgroundRuntime.view`). */
export type AppViewDispatch = {
  view(appId: string, sessionId: string, client: string, layout: AppViewLayout | null): void
  clientGone(client: string): void
  sessionGone(appId: string, sessionId: string): void
}

let seatedViews: AppViewDispatch | undefined

export function setAppViewDispatch(dispatch: AppViewDispatch | undefined): void {
  seatedViews = dispatch
}

export function dispatchAppView(appId: string, sessionId: string, client: string, layout: AppViewLayout | null): void {
  seatedViews?.view(appId, sessionId, client, layout)
}

export function dispatchAppSessionGone(appId: string, sessionId: string): void {
  seatedViews?.sessionGone(appId, sessionId)
}

/** A client's connection closed: the apps it showed are no longer on its screen. */
export function appViewsClientGone(client: string): void {
  seatedViews?.clientGone(client)
}
