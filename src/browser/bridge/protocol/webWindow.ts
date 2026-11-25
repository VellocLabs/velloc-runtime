/**
 * The `webWindow` capability (F-29) — single-web windows: one tab, a
 * read-only address, back / forward / reload and the OS caption buttons. A
 * window belongs to the connection that opened it: its events reach that
 * connection only, another connection's windowId is `window_not_found`, and
 * the window closes when its connection goes away. Only http, https and file
 * URLs are accepted (`url_not_allowed`). An older host does not advertise it.
 */

export type BridgeWebWindowState = 'normal' | 'maximized' | 'minimized'

/** Geometry in DIPs; an absent field keeps its value. Sizes have a floor of
 *  200 x 150 (`invalid_args`). */
export type BridgeWebWindowBounds = {
  left?: number
  top?: number
  width?: number
  height?: number
}

export type BridgeWebWindowInfo = {
  windowId: number
  url: string
  title: string
  state: BridgeWebWindowState
}

/** A main-frame commit in the window's tab. */
export type BridgeWebWindowOnNavigatedPayload = {
  windowId: number
  url: string
  isSameDocument: boolean
  isErrorPage: boolean
}

export type BridgeWebWindowOnTitleChangedPayload = {
  windowId: number
  title: string
}

/** The window's first main-frame navigation to its `captureRedirect` URL,
 *  with the query; the navigation was cancelled and the window closes next. */
export type BridgeWebWindowOnRedirectCapturedPayload = {
  windowId: number
  url: string
}

/** `api`: closed by `close`; `user`: by the person or the page. */
export type BridgeWebWindowOnClosedPayload = {
  windowId: number
  reason: 'api' | 'user'
}

type WindowAction<R = { ok: boolean }> = {
  payload: { windowId: number }
  result: R
}

export type WebWindowBridgeActionMap = {
  open: {
    payload: {
      url: string
      state?: BridgeWebWindowState
      focus?: boolean
      /** A loopback http URL (localhost / 127.0.0.1 / [::1], explicit port):
       *  a navigation to it (same scheme, host, port and path) is cancelled
       *  before any request and reported as `onRedirectCaptured`. Manifest
       *  primitive `webWindow.captureRedirect`. */
      captureRedirect?: string
      /** A fixed window title the page cannot change. Manifest primitive
       *  `webWindow.title`. */
      title?: string
      /** With `captureRedirect`: after the capture the window stays open on
       *  the host's "Finishing sign-in" page until `showSignInResult`.
       *  Manifest primitive `webWindow.signInResult`. */
      awaitSignInResult?: boolean
      /** The window gets a session of its own: no cookie or site data of the
       *  person's profile, and everything it stored is discarded once it and
       *  the popups its pages opened are closed. The profile's saved
       *  passwords, autofill and extensions still apply. Absent: the person's
       *  profile. Manifest primitive `webWindow.isolatedSession`. */
      isolatedSession?: boolean
      /** The window runs in the named storage partition of the profile: a
       *  session of its own (cookies, site data) that is kept on disk and is
       *  there again the next time the name is used. 8 to 32 lower-case
       *  letters. Not with `isolatedSession`. Manifest primitive
       *  `webWindow.storagePartition`. */
      storagePartition?: string
    } & BridgeWebWindowBounds
    result: { windowId: number }
  }
  /** The outcome of an `awaitSignInResult` window's captured sign-in: `ok`
   *  shows the host's success page and closes the window 1.5 s later; not
   *  `ok` shows its failure page with `message` and leaves the window open.
   *  Once per capture. Manifest primitive `webWindow.signInResult`. */
  showSignInResult: {
    payload: { windowId: number; ok: boolean; message?: string }
    result: { ok: boolean }
  }
  /** Deletes everything stored in a named storage partition. Refused
   *  (`invalid_args`) while a window or popup is open in it, or an earlier
   *  delete of it has not answered. Manifest primitive
   *  `webWindow.storagePartition`. */
  deleteStoragePartition: {
    payload: { name: string }
    result: { ok: boolean }
  }
  close: WindowAction
  list: {
    payload: Record<string, never>
    result: { windows: BridgeWebWindowInfo[] }
  }
  focus: WindowAction
  setBounds: {
    payload: { windowId: number } & BridgeWebWindowBounds
    result: { ok: boolean }
  }
  setState: {
    payload: { windowId: number; state: BridgeWebWindowState }
    result: { ok: boolean }
  }
  navigate: {
    payload: { windowId: number; url: string }
    result: { ok: boolean }
  }
  /** `ok` is false when there is no history entry to move to. */
  back: WindowAction
  forward: WindowAction
  reload: WindowAction
  /** Host-pushed EVENTS (never requested). */
  onNavigated: { payload: BridgeWebWindowOnNavigatedPayload; result: never }
  onTitleChanged: { payload: BridgeWebWindowOnTitleChangedPayload; result: never }
  onClosed: { payload: BridgeWebWindowOnClosedPayload; result: never }
  onRedirectCaptured: { payload: BridgeWebWindowOnRedirectCapturedPayload; result: never }
}
