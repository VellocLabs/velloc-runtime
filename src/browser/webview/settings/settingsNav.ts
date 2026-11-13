import {
  BoxIcon,
  BrainIcon,
  CpuIcon,
  FileTextIcon,
  InfoIcon,
  NetworkIcon,
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
 * button opens Remote access, and must not show when that section would not.
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
  | "network"
  | "remoteAccess"
  | "about";

/** The gates a nav entry or an embedded part may carry. */
export type SettingsGate = {
  /** The capability action the whole entry is built on — without it the entry is NOT RENDERED. */
  needs?: { cap: string; act: string };
  /**
   * Renders only when the published `remote/state` says the host supports
   * remote access (the manifest gate's UI half — an older binary simply has
   * no Remote access).
   */
  needsRemoteAccessSupported?: boolean;
  /**
   * Channel gate: renders only on the beta channel (`currentUiChannel` — the
   * same resolution a beta-only template uses). Declarative and removable —
   * deleting the flag ships it to stable; there is no second place to edit.
   */
  betaOnly?: boolean;
  /**
   * Security: renders only on the desktop's own UI, never on a REMOTE client page
   * whatever its scope — a `full` remote grant holds `remote.pairList` too, and
   * turning remote access off from there cuts off the page doing it.
   */
  desktopOnly?: boolean;
};

/** A section of one settings page that has its own gate (F-18). */
export type SettingsPartId = "proxy" | "remoteAccess";

/**
 * The Network page's sections, in display order, each gated on its own. The
 * page's nav entry renders when ANY of them does.
 */
export const NETWORK_PARTS: Array<{ id: SettingsPartId; gate: SettingsGate }> = [
  // The host machine's proxy: both `network.proxy*` actions are `full`, and
  // it is the desktop's own — a remote client has its own network.
  { id: "proxy", gate: { needs: { cap: "network", act: "proxyGet" }, desktopOnly: true } },
  // Every `remote.*` action is `full`, AND the section exists only when the
  // host advertises `remoteAccess` (`access.supported` on remote/state).
  // Beta-only while the remote-access surface hardens: deleting `betaOnly`
  // ships it to stable.
  {
    id: "remoteAccess",
    gate: {
      needs: { cap: "remote", act: "pairList" },
      needsRemoteAccessSupported: true,
      betaOnly: true,
      desktopOnly: true,
    },
  },
];

// Settings sections, in nav (= display) order. Entries with no gate are
// readable at `observe`; their write halves are gated in their sections.
export const NAV: Array<
  SettingsGate & {
    id: SettingsSectionId;
    labelKey: Parameters<TranslateFn>[0];
    icon: LucideIcon;
    /**
     * A page made of separately gated sections: the entry renders when any
     * part's gate passes, on top of the entry's own gates.
     */
    parts?: Array<{ id: SettingsPartId; gate: SettingsGate }>;
    /**
     * A fallback page: the entry renders only when the named entry does NOT.
     * Session models lives inside the Models page, under the provider list; a
     * connection that cannot list providers (a remote `observe`/`control`
     * grant) has no Models page, and keeps Session models as a page of its own.
     */
    onlyWithout?: SettingsSectionId;
  }
> = [
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
  // Proxy and Remote access, one section each — see `NETWORK_PARTS`.
  { id: "network", labelKey: "settings.nav.network", icon: NetworkIcon, desktopOnly: true, parts: NETWORK_PARTS },
  { id: "about", labelKey: "settings.nav.about", icon: InfoIcon },
];

/**
 * Section ids that name a part of another page rather than a page: a deep
 * link to one opens the host page, scrolled to that part.
 */
const EMBEDDED: Partial<Record<SettingsSectionId, { page: SettingsSectionId; part: SettingsPartId }>> = {
  remoteAccess: { page: "network", part: "remoteAccess" },
};

function passes(
  gate: SettingsGate,
  capabilities: CapabilityQuery,
  remoteAccessSupported: boolean,
  channel: UpdateChannel,
  remoteClient: boolean,
): boolean {
  return (
    (!gate.needs || capabilities.can(gate.needs.cap, gate.needs.act)) &&
    (!gate.needsRemoteAccessSupported || remoteAccessSupported) &&
    (!gate.betaOnly || channel === "beta") &&
    (!gate.desktopOnly || !remoteClient)
  );
}

/**
 * The Network page's parts this connection may see on this channel, in
 * display order. Same arguments as `visibleNav`.
 */
export function visibleNetworkParts(
  capabilities: CapabilityQuery,
  remoteAccessSupported = false,
  channel: UpdateChannel = currentUiChannel(),
  remoteClient = false,
): SettingsPartId[] {
  return NETWORK_PARTS.filter(part =>
    passes(part.gate, capabilities, remoteAccessSupported, channel, remoteClient),
  ).map(part => part.id);
}

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
      passes(entry, capabilities, remoteAccessSupported, channel, remoteClient) &&
      (!entry.parts ||
        entry.parts.some(part =>
          passes(part.gate, capabilities, remoteAccessSupported, channel, remoteClient),
        )),
  );
  return gated.filter(
    entry => !entry.onlyWithout || !gated.some(e => e.id === entry.onlyWithout),
  );
}

/**
 * The page a section id is shown on. A fallback entry hidden because its host
 * page is visible (`onlyWithout`) resolves to that host page, so a deep link
 * to Session models lands on Models — scrolled to it — rather than on the
 * first nav entry; an embedded part (`remoteAccess`) resolves to the page
 * holding it. Undefined when the id is not reachable at all.
 */
export function resolveSettingsPage(
  id: SettingsSectionId,
  nav: typeof NAV,
): SettingsSectionId | undefined {
  if (nav.some(entry => entry.id === id)) return id;
  const embedded = EMBEDDED[id]?.page;
  if (embedded) return nav.some(entry => entry.id === embedded) ? embedded : undefined;
  const host = NAV.find(entry => entry.id === id)?.onlyWithout;
  return host && nav.some(entry => entry.id === host) ? host : undefined;
}

/**
 * Whether `id` is a page — or an embedded part — this connection may open on
 * this channel: the same gates the nav applies, so a shortcut never lands on a
 * page without what it points at.
 */
export function isSettingsSectionVisible(
  id: SettingsSectionId,
  capabilities: CapabilityQuery,
  remoteAccessSupported = false,
  channel: UpdateChannel = currentUiChannel(),
  remoteClient = false,
): boolean {
  const embedded = EMBEDDED[id];
  if (embedded) {
    return visibleNetworkParts(capabilities, remoteAccessSupported, channel, remoteClient).includes(
      embedded.part,
    );
  }
  return visibleNav(capabilities, remoteAccessSupported, channel, remoteClient).some(
    entry => entry.id === id,
  );
}
