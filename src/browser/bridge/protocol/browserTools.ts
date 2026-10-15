/**
 * Bridge namespace: `browserTools` — browser-tool settings (today a single
 * `separateWindow` boolean). C++-served on the guest DIRECT bridge.
 */
export type BrowserToolsValues = {
  separateWindow: boolean
}

export type BrowserToolsBridgeActionMap = {
  snapshot: {
    payload: Record<string, never>
    result: { values: BrowserToolsValues }
  }
  setField: {
    payload: { patch: { separateWindow?: boolean | null } }
    result: { ok: true; values: BrowserToolsValues }
  }
}
