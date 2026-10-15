/**
 * Bridge namespace: `appInfo` — version strings, the custom webapp URL
 * (`nexus.webapp_url`, applied by `relaunch`), for the About page. C++-served on
 * the guest DIRECT bridge.
 */
export type AppInfoBridgeActionMap = {
  getVersionInfo: {
    payload: Record<string, never>
    result: {
      appVersion: string
      chromiumVersion: string
      /**
       * This machine's network name and operating system (F-24), read at
       * bridge-connect time into `welcome.bootstrap`; an older binary omits both.
       */
      hostName?: string
      /** Human-readable, e.g. `Windows 11` — never a version string alone. */
      osName?: string
    }
  }
  getWebappUrl: {
    payload: Record<string, never>
    result: {
      /** The saved override (empty when none — the built-in agent is used). */
      url: string
      /** The built-in default guest URL (shown as the field's hint/placeholder). */
      defaultUrl?: string
    }
  }
  setWebappUrl: {
    payload: { url: string }
    result: { ok: true }
  }
  /**
   * Restart the client so a saved `setWebappUrl` takes effect — the runtime
   * source is only read at boot. The host replies before it restarts, but the
   * guest is torn down straight after, so the resolved promise is not
   * something to sequence UI on: treat a rejection as the only informative
   * outcome (an older host answers `NOT_IMPLEMENTED`).
   */
  relaunch: {
    payload: Record<string, never>
    result: { ok: true }
  }
}
