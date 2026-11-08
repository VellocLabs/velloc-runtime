/**
 * The realm's way from a session's surface to an app's background module
 * (F-40): the module runtime seats one dispatch while it runs; a session's
 * surface host offers it each action the manifest names as local. Without
 * a seated dispatch, or a module for the app, no action is handled.
 */

/** Offers an action to the app's module; resolves true when the module handled it. */
export type AppActionDispatch = (appId: string, action: string, context: unknown, sessionId: string) => Promise<boolean>

let seated: AppActionDispatch | undefined

export function setAppActionDispatch(dispatch: AppActionDispatch | undefined): void {
  seated = dispatch
}

export function dispatchAppAction(appId: string, action: string, context: unknown, sessionId: string): Promise<boolean> {
  return seated ? seated(appId, action, context, sessionId) : Promise.resolve(false)
}
