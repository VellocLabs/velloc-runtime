import {
  BoxIcon,
  BrainIcon,
  CpuIcon,
  FileTextIcon,
  GlobeIcon,
  InfoIcon,
  PuzzleIcon,
  RouteIcon,
  SlidersHorizontalIcon,
  UserIcon,
  type LucideIcon,
} from "lucide-react";

import { currentUiChannel, type UpdateChannel } from "../../../branding/updateChannels";
import type { TranslateFn } from "../i18n";
import type { CapabilityQuery } from "../useCan";

/**
 * The settings nav table and its gates, apart from `SettingsScreen` so a
 * caller outside the (lazily loaded) settings surface can ask whether a page
 * is reachable without importing every section: the topbar's connected-devices
 * button opens Remote access, and must not show when that page would not.
 */

export type SettingsSectionId =
  | "general"
  | "models"
  | "sessionModels"
  | "mcp"
  | "instructions"
  | "memory"
  | "features"
  | "plugins"
  | "remoteAccess"
  | "about";

// Settings sections, in nav (= display) order. `needs` is the capability action the
// whole page is built on — without it the entry is NOT RENDERED. Entries with no
// `needs` are readable at `observe`; their write halves are gated in their sections.
export const NAV: Array<{
  id: SettingsSectionId;
  labelKey: Parameters<TranslateFn>[0];
  icon: LucideIcon;
  needs?: { cap: string; act: string };
  /**
   * A SECOND gate beyond the capability: the entry renders only when the
   * published `remote/state` says the host supports remote access (the
   * manifest gate's UI half — an older binary simply has no Remote
   * access entry). Only "remoteAccess" carries one.
   */
  needsRemoteAccessSupported?: boolean;
  /**
   * Channel gate: the entry renders only on the beta channel
   * (`currentUiChannel` — the same resolution a beta-only template uses).
   * Declarative and removable — deleting the flag ships the entry to stable;
   * there is no second place to edit.
   */
  betaOnly?: boolean;
  /**
   * Security: renders only on the desktop's own UI, never on a REMOTE client page
   * whatever its scope — a `full` remote grant holds `remote.pairList` too, and
   * turning remote access off from there cuts off the page doing it.
   */
  desktopOnly?: boolean;
  /**
   * A fallback page: the entry renders only when the named entry does NOT.
   * Session models lives inside the Models page, under the provider list; a
   * connection that cannot list providers (a remote `observe`/`control`
   * grant) has no Models page, and keeps Session models as a page of its own.
   */
  onlyWithout?: SettingsSectionId;
}> = [
  { id: "general", labelKey: "settings.nav.general", icon: UserIcon },
  // Provider credentials and the model catalog: `providers.*` is `full`.
  { id: "models", labelKey: "settings.nav.models", icon: BoxIcon, needs: { cap: "providers", act: "list" } },
  // Normally the second group of the Models page — see `onlyWithout`.
  { id: "sessionModels", labelKey: "settings.nav.sessionModels", icon: RouteIcon, onlyWithout: "models" },
  // Every `mcpSettings` action is `full` — the page has no readable half.
  { id: "mcp", labelKey: "settings.nav.mcp", icon: CpuIcon, needs: { cap: "mcpSettings", act: "list" } },
  // Instruction files are read AND written from disk; `memory.userInstructions` is `full`.
  { id: "instructions", labelKey: "settings.nav.instructions", icon: FileTextIcon, needs: { cap: "memory", act: "userInstructions" } },
  { id: "memory", labelKey: "settings.nav.memory", icon: BrainIcon },
  { id: "features", labelKey: "settings.nav.features", icon: SlidersHorizontalIcon },
  { id: "plugins", labelKey: "settings.nav.plugins", icon: PuzzleIcon },
  // Every `remote.*` action is `full`, AND the page exists only when
  // the host advertises `remoteAccess` (`access.supported` on remote/state).
  // Beta-only while the remote-access surface hardens (v1): deleting
  // `betaOnly` ships it to stable. Desktop-only: never on a remote client.
  { id: "remoteAccess", labelKey: "settings.nav.remoteAccess", icon: GlobeIcon, needs: { cap: "remote", act: "pairList" }, needsRemoteAccessSupported: true, betaOnly: true, desktopOnly: true },
  { id: "about", labelKey: "settings.nav.about", icon: InfoIcon },
];

/**
 * The nav rows this connection may use on this channel. Exported for the unit
 * test. The channel is read per call (`currentUiChannel`), never cached at
 * module load: it is a property of the realm, and a test pins it per case.
 * `remoteClient` is true on a remote client page (the remote boot states it —
 * the shell's `remoteHost`); it drops the `desktopOnly` entries.
 */
export function visibleNav(
  capabilities: CapabilityQuery,
  remoteAccessSupported = false,
  channel: UpdateChannel = currentUiChannel(),
  remoteClient = false,
): typeof NAV {
  const gated = NAV.filter(
    entry =>
      (!entry.needs || capabilities.can(entry.needs.cap, entry.needs.act)) &&
      (!entry.needsRemoteAccessSupported || remoteAccessSupported) &&
      (!entry.betaOnly || channel === 'beta') &&
      (!entry.desktopOnly || !remoteClient),
  );
  return gated.filter(
    entry => !entry.onlyWithout || !gated.some(e => e.id === entry.onlyWithout),
  );
}

/**
 * The page a section id is shown on. A fallback entry hidden because its host
 * page is visible (`onlyWithout`) resolves to that host page, so a deep link
 * to Session models lands on Models — scrolled to it — rather than on the
 * first nav entry. Undefined when the id is not reachable at all.
 */
export function resolveSettingsPage(
  id: SettingsSectionId,
  nav: typeof NAV,
): SettingsSectionId | undefined {
  if (nav.some(entry => entry.id === id)) return id;
  const host = NAV.find(entry => entry.id === id)?.onlyWithout;
  return host && nav.some(entry => entry.id === host) ? host : undefined;
}

/**
 * Whether `id` is a page this connection may open on this channel — the same
 * gates the nav applies, so a shortcut to a page never lands on another one.
 */
export function isSettingsSectionVisible(
  id: SettingsSectionId,
  capabilities: CapabilityQuery,
  remoteAccessSupported = false,
  channel: UpdateChannel = currentUiChannel(),
  remoteClient = false,
): boolean {
  return visibleNav(capabilities, remoteAccessSupported, channel, remoteClient).some(
    entry => entry.id === id,
  );
}
