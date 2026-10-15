import type { BrowserColorVariant } from "../../bridge/browserBridgeProtocol";
import type { TranslateFn } from "../i18n";
import type { GuestPalette } from "../../boot/guestPalette";

/**
 * The option sets behind Settings · Appearance and the language row. Security: these
 * are MIRRORS — the host validates every value (`nexus_appearance_bridge_adapter.cc`)
 * because the guest is untrusted web content; widening a set means editing the C++
 * array in the same change.
 */

// ── UI language ────────────────────────────────────────────────────────────

/**
 * The locales shipped on BOTH surfaces (browser chrome and guest catalogs). `tag` is
 * the host pref's locale code (`zh-CN`); `resolveLocale()` maps it to the guest
 * catalog. `endonym` is each language's own name and deliberately not a catalog entry.
 */
export const UI_LOCALE_OPTIONS: ReadonlyArray<{
  tag: string;
  endonym: string;
}> = [
  { tag: "en", endonym: "English" },
  { tag: "zh-CN", endonym: "简体中文" },
  { tag: "es", endonym: "Español" },
  { tag: "fr", endonym: "Français" },
  { tag: "de", endonym: "Deutsch" },
  { tag: "ja", endonym: "日本語" },
  { tag: "ko", endonym: "한국어" },
];

/**
 * Match a pref value to one of the offered tags. The pref can hold anything
 * Chrome has ever written — a regional tag (`en-GB`), a bare language where we
 * offer a regional one (`zh`), or empty on a fresh profile. Falls back to `en`,
 * which is what the browser itself falls back to.
 */
export function matchUiLocale(raw: string | undefined | null): string {
  const value = (raw ?? "").toLowerCase();
  if (!value) return "en";
  const exact = UI_LOCALE_OPTIONS.find((o) => o.tag.toLowerCase() === value);
  if (exact) return exact.tag;
  const base = value.split("-")[0];
  const byBase = UI_LOCALE_OPTIONS.find(
    (o) => o.tag.toLowerCase().split("-")[0] === base,
  );
  return byBase ? byBase.tag : "en";
}

// ── Accent colour ──────────────────────────────────────────────────────────

/**
 * A fixed palette rather than a free colour picker: the host resolves the seed
 * through Chrome's colour pipeline, so only curated swatches have known contrast.
 * `seed` is `#rrggbb`; `labelKey` is the swatch's accessible name. The first swatch
 * ("Default") is Velloc's own palette, not a Chrome colour.
 */
export type ThemeSwatch = {
  id: string;
  palette: GuestPalette;
  /** Absent on the seedless swatches, which CLEAR the user colour. */
  seed?: string;
  /** What a seedless swatch's circle paints (a seeded one paints its seed). */
  preview?: string;
  variant?: BrowserColorVariant;
  labelKey: Parameters<TranslateFn>[0];
};

/** The selected-check colour: white on every (mid-to-dark) seed, near-black
 *  on the light seedless previews. Painted on the swatch, so theme-independent. */
export const SWATCH_CHECK_ON_SEED = "#ffffff";
export const SWATCH_CHECK_ON_PREVIEW = "#171717";

export const THEME_SWATCHES: ReadonlyArray<ThemeSwatch> = [
  // Velloc's built-in black/white palette; also clears the Chrome colour.
  { id: "default", palette: "classic", preview: "#fafafa", labelKey: "settings.appearance.swatch.default" },
  // No seed → SetUserColor(nullopt) on the host: Chrome's stock palette.
  { id: "chrome", palette: "chrome", preview: "#d3e3fd", labelKey: "settings.appearance.swatch.chrome" },
  { id: "grey", palette: "chrome", seed: "#8e918f", variant: "neutral", labelKey: "settings.appearance.swatch.grey" },
  { id: "blue", palette: "chrome", seed: "#0b57d0", variant: "tonalSpot", labelKey: "settings.appearance.swatch.blue" },
  { id: "aqua", palette: "chrome", seed: "#00639b", variant: "tonalSpot", labelKey: "settings.appearance.swatch.aqua" },
  { id: "green", palette: "chrome", seed: "#146c2e", variant: "tonalSpot", labelKey: "settings.appearance.swatch.green" },
  { id: "citron", palette: "chrome", seed: "#6d5e00", variant: "tonalSpot", labelKey: "settings.appearance.swatch.citron" },
  { id: "orange", palette: "chrome", seed: "#a03d00", variant: "tonalSpot", labelKey: "settings.appearance.swatch.orange" },
  { id: "rose", palette: "chrome", seed: "#a8005d", variant: "tonalSpot", labelKey: "settings.appearance.swatch.rose" },
  { id: "violet", palette: "chrome", seed: "#6b4eae", variant: "tonalSpot", labelKey: "settings.appearance.swatch.violet" },
];

/**
 * Which swatch a host snapshot corresponds to. The classic guest palette is
 * the "Default" swatch whatever colour the host holds. An unrecognised colour — set
 * from Chrome's own picker, or left by an older build — matches nothing, so no
 * swatch shows as selected. That is honest: the user's colour genuinely is not
 * one of these, and lighting up the nearest one would misreport it.
 */
export function matchThemeSwatch(
  color: string | undefined,
  palette: GuestPalette = "chrome",
): string | null {
  if (palette === "classic") return "default";
  if (!color) return "chrome";
  const value = color.toLowerCase();
  const hit = THEME_SWATCHES.find((s) => s.seed?.toLowerCase() === value);
  return hit ? hit.id : null;
}
