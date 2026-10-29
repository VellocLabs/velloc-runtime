/**
 * The runtime's one media viewer (F-9): a single-web window (F-29) reused for every file
 * `fsx.openInWindow` shows. While it is up, the next file loads in it and brings it forward;
 * once the person closes it, the next file opens a new one. Opens run one at a time, so two
 * quick clicks never make two windows.
 */

/** The `webWindow` primitives the viewer drives (`createNativePrimitives(...).webWindow`). */
export type ViewerWebWindow = {
  open(url: string): Promise<number>
  navigate(windowId: number, url: string): Promise<void>
  focus(windowId: number): Promise<void>
  list(): Promise<ReadonlyArray<{ windowId: number }>>
}

/**
 * `show(url)` loads `url` in the viewer. `webWindow()` is read per call (the host transport is
 * replaceable); `null` makes `show` reject.
 */
export function createFileViewerWindow(webWindow: () => ViewerWebWindow | null): (url: string) => Promise<void> {
  let windowId: number | null = null
  let queue: Promise<void> = Promise.resolve()
  const showNow = async (url: string): Promise<void> => {
    const windows = webWindow()
    if (!windows) throw new Error('this host has no single-web windows')
    if (windowId !== null) {
      const current = windowId
      const open = (await windows.list()).some(each => each.windowId === current)
      if (open) {
        await windows.navigate(current, url)
        await windows.focus(current)
        return
      }
    }
    windowId = await windows.open(url)
  }
  return url => {
    const shown = queue.then(() => showNow(url))
    queue = shown.catch(() => {})
    return shown
  }
}
