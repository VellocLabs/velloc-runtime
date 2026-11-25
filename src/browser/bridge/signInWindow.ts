/**
 * A sign-in window whose redirect the host captures (F-29): a single-web
 * window opened on a sign-in page, resolved with the first navigation to a
 * loopback redirect URL. Shared by MCP sign-in (F-10) and a provider mod's
 * `provider.login` (F-27). Security: the caller gets the captured URL and
 * nothing else of the window, whichever session it runs in.
 */
import type { BrowserHostManifest } from './protocol/manifest'
import type { NativePrimitives } from './nativePrimitives'

/** What a host must list to open one. */
export const SIGN_IN_WINDOW_PRIMITIVE = 'webWindow.captureRedirect'
export const SIGN_IN_WINDOW_CAPABILITY = 'webWindow'
const ISOLATED_SESSION_PRIMITIVE = 'webWindow.isolatedSession'
export const STORAGE_PARTITION_PRIMITIVE = 'webWindow.storagePartition'

const SIGN_IN_WINDOW = { width: 520, height: 720 }
/** The longest window title the host accepts, in UTF-16 units. */
const MAX_WINDOW_TITLE = 120

/** The captured redirect of a sign-in window, and the window's last word. */
export type SignInCapture = {
  /** The full redirect URL, query included. */
  url: string
  /** Shows the outcome in the window: success closes it shortly after,
   *  failure leaves it open with `reason` (shown as given). Never throws. */
  finish(outcome: { ok: true } | { ok: false; reason?: string }): void
  /** Closes the window without a result (the sign-in was cancelled). */
  close(): void
}

export class SignInWindowClosedError extends Error {
  constructor() {
    super('The sign-in window was closed before sign-in finished.')
    this.name = 'SignInWindowClosedError'
  }
}

/**
 * `title` as the host takes it: whitespace runs collapsed, ends trimmed, cut
 * to the host's limit with an ellipsis. Null when nothing is left, so a blank
 * title never fails the sign-in.
 */
export function signInWindowTitle(title: string | undefined): string | null {
  const collapsed = title?.replace(/\s+/g, ' ').trim() ?? ''
  if (!collapsed) return null
  if (collapsed.length <= MAX_WINDOW_TITLE) return collapsed
  let cut = collapsed.slice(0, MAX_WINDOW_TITLE - 1)
  // Never leave half a surrogate pair before the ellipsis.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
  return `${cut.trimEnd()}…`
}

/** Whether a host of this manifest can open a sign-in window. */
export function hostOpensSignInWindows(
  manifest: Pick<BrowserHostManifest, 'capabilities' | 'primitives'> | undefined,
): boolean {
  return (
    manifest?.primitives?.includes(SIGN_IN_WINDOW_PRIMITIVE) === true
    && manifest.capabilities?.includes(SIGN_IN_WINDOW_CAPABILITY) === true
  )
}

export type SignInWindowRequest = {
  url: string
  /** The loopback URL whose navigation is the result. */
  redirectUri: string
  /** Aborted before the capture: the window closes and the promise rejects with the signal's reason. */
  signal: AbortSignal
  title?: string
  /** A session of the window's own (cookies and site data), discarded when it
   *  closes. Absent: the person's profile, where a site they are signed in to
   *  stays signed in. */
  isolated?: boolean
  /** A named session kept between windows. Not with `isolated`. */
  partition?: string
  /** The error of a window closed before the capture. Default `SignInWindowClosedError`. */
  closed?: () => Error
  /** Called once when the window is gone, however it ended, or at once when
   *  it never opened. */
  onGone?: () => void
}

/**
 * Opens the window and resolves with the capture; rejects when the window
 * closes first, `signal` aborts, or the host refuses to open it.
 */
export function openSignInWindow(
  webWindow: NativePrimitives['webWindow'],
  manifest: Pick<BrowserHostManifest, 'primitives'> | undefined,
  request: SignInWindowRequest,
): Promise<SignInCapture> {
  const { url, redirectUri, signal } = request
  // Security: an isolated window is never opened in the person's profile
  // instead; a host that cannot isolate refuses.
  if (request.isolated && manifest?.primitives?.includes(ISOLATED_SESSION_PRIMITIVE) !== true) {
    const error = new Error('this Velloc cannot open a sign-in window in a session of its own')
    error.name = 'NotSupportedError'
    return Promise.reject(error)
  }
  if (request.partition !== undefined && manifest?.primitives?.includes(STORAGE_PARTITION_PRIMITIVE) !== true) {
    const error = new Error('this Velloc cannot open a sign-in window in a kept session')
    error.name = 'NotSupportedError'
    return Promise.reject(error)
  }
  const closed = request.closed ?? (() => new SignInWindowClosedError())
  let gone = false
  let offGone: (() => void) | undefined
  const goneOnce = (): void => {
    if (gone) return
    gone = true
    offGone?.()
    request.onGone?.()
  }
  const listed = (name: string): boolean => manifest?.primitives?.includes(name) === true
  // An older host has no fixed titles; it shows the page's own.
  const fixedTitle = listed('webWindow.title') ? signInWindowTitle(request.title) : null
  // An older host closes the window on the capture; it has no result pages.
  const awaitResult = listed('webWindow.signInResult')
  const captured = (windowId: number, capturedUrl: string): SignInCapture => {
    let done = false
    const once = (run: () => Promise<void>): void => {
      if (done || !awaitResult) return
      done = true
      void run().catch(() => {})
    }
    return {
      url: capturedUrl,
      finish: outcome =>
        once(() =>
          webWindow.showSignInResult(windowId, outcome.ok, !outcome.ok && outcome.reason ? outcome.reason : undefined),
        ),
      close: () => once(() => webWindow.close(windowId)),
    }
  }
  return new Promise<SignInCapture>((resolve, reject) => {
    let windowId: number | null = null
    let settled = false
    const offs: Array<() => void> = []
    const finish = (outcome: () => void): void => {
      if (settled) return
      settled = true
      for (const off of offs) off()
      signal.removeEventListener('abort', onAbort)
      outcome()
    }
    const onAbort = (): void => {
      if (windowId !== null) void webWindow.close(windowId).catch(() => {})
      finish(() => reject(signal.reason ?? closed()))
    }
    // Listeners first: a redirect can be captured before `open` answers.
    const early: Array<{ windowId: number; url?: string }> = []
    offs.push(
      webWindow.onRedirectCaptured(event => {
        if (windowId === null) early.push({ windowId: event.windowId, url: event.url })
        else if (event.windowId === windowId) finish(() => resolve(captured(event.windowId, event.url)))
      }),
      webWindow.onClosed(event => {
        if (windowId === null) early.push({ windowId: event.windowId })
        else if (event.windowId === windowId) finish(() => reject(closed()))
      }),
    )
    if (signal.aborted) {
      onAbort()
      goneOnce()
      return
    }
    signal.addEventListener('abort', onAbort)
    const closedBeforeOpen: number[] = []
    let openedId: number | null = null
    if (request.onGone) {
      offGone = webWindow.onClosed(event => {
        if (openedId === null) closedBeforeOpen.push(event.windowId)
        else if (event.windowId === openedId) goneOnce()
      })
    }
    webWindow
      .open(url, {
        captureRedirect: redirectUri,
        ...SIGN_IN_WINDOW,
        ...(fixedTitle !== null ? { title: fixedTitle } : {}),
        ...(awaitResult ? { awaitSignInResult: true } : {}),
        ...(request.isolated ? { isolatedSession: true } : {}),
        ...(request.partition !== undefined ? { storagePartition: request.partition } : {}),
      })
      .then(id => {
        windowId = id
        openedId = id
        if (closedBeforeOpen.includes(id)) goneOnce()
        if (settled) {
          void webWindow.close(id).catch(() => {})
          return
        }
        for (const event of early) {
          if (event.windowId !== id) continue
          if (event.url !== undefined) finish(() => resolve(captured(id, event.url!)))
          else finish(() => reject(closed()))
        }
      })
      .catch(error => {
        if (openedId === null) goneOnce()
        finish(() => reject(error))
      })
  })
}
