/**
 * The `pageScript` capability (F-29) — a script channel to one page: a
 * single-web window this connection opened, or a tab in this Nexus window.
 * The channel's scripts run in a private world of the page's main frame;
 * `exposeToPage` also gives the page's own scripts the messaging object.
 * A channel belongs to the connection that attached it: its events reach
 * that connection only, and another connection's channelId is
 * `channel_not_found`. An older host does not advertise it.
 */

/** Exactly one of the two. */
export type BridgePageScriptTarget =
  | { webWindowId: number; tabId?: never }
  | { tabId: number; webWindowId?: never }

export type BridgePageScriptWorld = 'isolated' | 'main'

/** A script's completion: its JSON value (absent for undefined), or the
 *  thrown error's text. */
export type BridgePageScriptExecuteResult = {
  value?: unknown
  exception?: string
}

/** A message a channel script sent with `vellocHost.send`. `data` is the
 *  JSON text; `world` says which world's object sent it. */
export type BridgePageScriptOnMessagePayload = {
  channelId: number
  data: string
  origin: string
  frameUrl: string
  world: BridgePageScriptWorld
}

export type BridgePageScriptOnDetachedPayload = {
  channelId: number
  reason: 'target_gone'
}

type ChannelAction<P extends object, R> = {
  payload: { channelId: number } & P
  result: R
}

export type PageScriptBridgeActionMap = {
  attach: {
    payload: BridgePageScriptTarget & { exposeToPage?: boolean }
    result: { channelId: number }
  }
  detach: { payload: { channelId: number }; result: { ok: boolean } }
  executeScript: ChannelAction<
    { code: string; world?: BridgePageScriptWorld },
    BridgePageScriptExecuteResult
  >
  /** `data` is JSON text of at most 1 MB (`payload_too_large`). */
  postMessage: ChannelAction<{ data: string }, { ok: boolean }>
  addInitScript: ChannelAction<{ source: string }, { scriptId: string }>
  /** `ok` is false for an id the channel did not issue. */
  removeInitScript: ChannelAction<{ scriptId: string }, { ok: boolean }>
  /** Host-pushed EVENTS (never requested). */
  onMessage: { payload: BridgePageScriptOnMessagePayload; result: never }
  onDetached: { payload: BridgePageScriptOnDetachedPayload; result: never }
}
