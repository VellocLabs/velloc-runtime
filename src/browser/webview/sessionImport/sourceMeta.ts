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
