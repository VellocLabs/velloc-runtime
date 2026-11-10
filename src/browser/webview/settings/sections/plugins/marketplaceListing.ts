import type { PluginAvailableUiEntry } from "../../../../bridge/protocol/plugins";

export const PAGE_SIZE = 20;
export const FILTER_THRESHOLD = 10;
export const FILTER_MIN_LENGTH = 2;
const LISTING_CACHE_KEY = "nexus.plugins.marketplaceListings.v1";

export type FetchState = "idle" | "fetching" | "fetched" | "error";

/** Read the cached marketplace listings (keyed by marketplace name). Validates
 *  the parsed shape — the `catch` only guards malformed JSON, but VALID JSON of
 *  the wrong shape (e.g. a non-array value) would survive the cast and crash a
 *  downstream `.map`, so keep only object-keyed array entries. */
export function loadCachedListings(): Record<string, PluginAvailableUiEntry[]> {
  try {
    const raw = localStorage.getItem(LISTING_CACHE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, PluginAvailableUiEntry[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) out[key] = value as PluginAvailableUiEntry[];
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist all marketplace listings to localStorage. */
export function saveCachedListings(
  listings: Record<string, PluginAvailableUiEntry[]>,
): void {
  try {
    localStorage.setItem(LISTING_CACHE_KEY, JSON.stringify(listings));
  } catch {
    /* quota / disabled storage — non-fatal */
  }
}

/**
 * Search match priority (lower = more relevant): the query at the START of the
 * name beats a substring in the name, which beats a match in the description.
 * `3` = no match (filtered out).
 */
export function matchRank(plugin: PluginAvailableUiEntry, q: string): number {
  const name = plugin.name.toLowerCase();
  if (name.startsWith(q)) return 0;
  if (name.includes(q)) return 1;
  if ((plugin.description ?? "").toLowerCase().includes(q)) return 2;
  return 3;
}
