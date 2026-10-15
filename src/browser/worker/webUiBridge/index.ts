/**
 * The settings capabilities' handlers — barrel.
 *
 * See `registry.ts` for the design rationale (explicit allow-list, per-
 * capability handlers). The hub's `legacyWebUiCapabilities.ts` wraps these as
 * protocol capabilities; the WebUI port they were written for is gone (phase
 * 6), and so is the envelope dispatcher that fronted it.
 */

export {
  registerWebUiBridgeHandler,
  getWebUiBridgeHandler,
  getRegisteredWebUiBridgeCapabilities,
  __resetWebUiBridgeRegistryForTests,
  type WebUiBridgeContext,
  type WebUiBridgeHandler,
} from './registry'
