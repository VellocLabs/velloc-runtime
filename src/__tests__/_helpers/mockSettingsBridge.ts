import type { NexusSettingsBridge } from "../../browser/webview/nexusSettingsBridge";

/**
 * A controllable `NexusSettingsBridge` for settings hook/component tests. Handlers are keyed by
 * `"<capability>.<action>"` (the `createBridgeRoute` route) and may return a value or throw.
 */
export type SettingsBridgeHandlers = Record<
  string,
  (payload: unknown) => unknown | Promise<unknown>
>;

export function makeMockSettingsBridge(
  handlers: SettingsBridgeHandlers,
): NexusSettingsBridge {
  return {
    request: async (
      route: { capability?: string; action?: string },
      payload: unknown,
    ) => {
      const key = `${route?.capability}.${route?.action}`;
      const handler = handlers[key];
      if (!handler) {
        throw new Error(`mock settings bridge: no handler for "${key}"`);
      }
      return handler(payload);
    },
    subscribeEvents: () => () => {},
  } as unknown as NexusSettingsBridge;
}
