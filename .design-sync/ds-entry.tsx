// Synthetic bundle entry for design-sync (committed; pinned via cfg.entry).
// chromium-runtime is a private Vite app with no compiled component dist, so
// the converter bundles from source: this barrel re-exports every
// src/components/ui primitive + its compound parts, and esbuild assigns them
// all to window.NexusUI.*. The design agent needs the sub-parts (DialogContent,
// CardHeader, …) to compose; only the 11 primaries get authored preview cards
// (see componentSrcMap in design-sync.config.json).
export * from "../src/components/ui/accordion";
export * from "../src/components/ui/badge";
export * from "../src/components/ui/button";
export * from "../src/components/ui/card";
export * from "../src/components/ui/collapsible";
export * from "../src/components/ui/dialog";
export * from "../src/components/ui/input";
export * from "../src/components/ui/popover";
export * from "../src/components/ui/select";
export * from "../src/components/ui/switch";
export * from "../src/components/ui/tooltip";
