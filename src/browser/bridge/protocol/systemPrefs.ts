/**
 * Bridge namespace: `systemPrefs` — browser-global prefs in C++ local_state (NOT
 * settings.json). `launcherEnabled` / `setLauncher` alias `backgroundModeEnabled`;
 * the UI writes both routes so an older host still honours the one toggle.
 */
export type SystemPrefsBridgeActionMap = {
  get: {
    payload: Record<string, never>
    result: {
      backgroundModeEnabled: boolean
      launcherEnabled: boolean
    }
  }
  setBackgroundMode: {
    payload: { enabled: boolean }
    result: { ok: true }
  }
  setLauncher: {
    payload: { enabled: boolean }
    result: { ok: true }
  }
}
