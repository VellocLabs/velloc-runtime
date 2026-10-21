import type { BrowserLlmCatalog } from "../../bridge/protocol/nexus_llm";
import type { ImportSource } from "../../bridge/protocol/sessionImport";
import {
  TERMINAL_AGENT_DISPLAY_NAME,
  TERMINAL_AGENT_SOURCE_ID,
} from "../../../sessionImport/sources/claude-code/sourceIdentity";

/**
 * Per-source presentation. `label` is the product's proper name — config
 * data passed to the catalog as `{source}`, never a catalog value itself
 * (G-1: third-party product names are data, not text).
 * `providerIconId` names the host-catalog provider whose brand mark the
 * topbar button reuses.
 */
export type ImportSourceMeta = {
  label: string;
  providerIconId: string;
};

export const IMPORT_SOURCE_META: Record<ImportSource, ImportSourceMeta> = {
  [TERMINAL_AGENT_SOURCE_ID]: {
    label: TERMINAL_AGENT_DISPLAY_NAME,
    providerIconId: "anthropic",
  },
  codex: { label: "Codex", providerIconId: "openai" },
};

/** The brand SVG for a source, from the host catalog, or undefined when the
 *  catalog does not carry that provider (dev mock) — callers fall back to a
 *  generic icon. */
export function importSourceIconSvg(
  catalog: BrowserLlmCatalog | null | undefined,
  source: ImportSource,
): string | undefined {
  const providerId = IMPORT_SOURCE_META[source].providerIconId;
  const svg = catalog?.providers.find((p) => p.id === providerId)?.iconSvg;
  return svg && svg.length > 0 ? svg : undefined;
}

export type TopbarImportEntry = {
  source: ImportSource;
  label: string;
  iconSvg?: string;
};

/** The topbar import buttons for the detected sources. Empty until the host
 *  catalog has providers: before then no brand mark is known, and a button
 *  would draw the generic fallback icon only to swap it a moment later. */
export function topbarImportEntries(
  catalog: BrowserLlmCatalog | null | undefined,
  sources: ReadonlyArray<{ source: ImportSource }>,
): TopbarImportEntry[] {
  if (!catalog || catalog.providers.length === 0) return [];
  return sources.map((entry) => ({
    source: entry.source,
    label: IMPORT_SOURCE_META[entry.source].label,
    iconSvg: importSourceIconSvg(catalog, entry.source),
  }));
}
