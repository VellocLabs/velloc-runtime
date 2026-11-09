/**
 * The realm's way from a session's surface to an app's background module
 * (F-40): the module runtime seats one dispatch while it runs; a session's
 * surface host offers it each action the manifest names as local. Without
 * a seated dispatch, or a module for the app, no action is handled.
 * The same way carries what each client shows of an app (`app.show`,
 * `app.layout`, `app.hide`).
 */

import type { AppViewLayout } from './appViews'

/** Offers an action to the app's module; resolves true when the module handled it. */
export type AppActionDispatch = (appId: string, action: string, context: unknown, sessionId: string) => Promise<boolean>

let seated: AppActionDispatch | undefined

export function setAppActionDispatch(dispatch: AppActionDispatch | undefined): void {
  seated = dispatch
}

export function dispatchAppAction(appId: string, action: string, context: unknown, sessionId: string): Promise<boolean> {
  return seated ? seated(appId, action, context, sessionId) : Promise.resolve(false)
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
