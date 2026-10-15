import * as React from "react";

import { createBridgeRoute } from "../../bridge/protocol/core";
import type {
  ImportableGlobalMemoryRow,
  ImportableMemoryProjectRow,
} from "../../bridge/protocol/memory";
import type { ImportSource } from "../../bridge/protocol/sessionImport";
import type { NexusSettingsBridge } from "../nexusSettingsBridge";

export type MemoryListState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; rootPath: string; projects: ImportableMemoryProjectRow[] }
  | { status: "error"; message: string };

/** Transient per-row overlay. There is no `imported` state: once an import
 *  settles the overlay is dropped and the row's server `status` (disk truth,
 *  refreshed silently) drives the button. */
export type MemoryRowState =
  | { status: "importing" }
  | { status: "error"; message: string };

/**
 * Dialog state for one import source's Memory tab, via the worker-served `memory`
 * capability (topic files overwritten, `MEMORY.md` merged). Row status comes from the
 * SERVER, overlaid locally only while an import is in flight or just finished.
 */
export function useMemoryImport(
  bridge: NexusSettingsBridge | null,
  source: ImportSource | null,
  open: boolean,
) {
  const [list, setList] = React.useState<MemoryListState>({ status: "idle" });
  const [rowStates, setRowStates] = React.useState<
    Record<string, MemoryRowState>
  >({});
  // The source's GLOBAL memory (Codex only), shown as one row above the
  // per-project list. `null` = the source has none (Claude Code always).
  const [global, setGlobal] = React.useState<ImportableGlobalMemoryRow | null>(
    null,
  );
  const [globalState, setGlobalState] = React.useState<
    MemoryRowState | undefined
  >(undefined);
  const requestSeq = React.useRef(0);

  const load = React.useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!bridge || !source) return;
      const seq = ++requestSeq.current;
      // A silent reload (after an import) keeps the current list on screen
      // instead of flashing the loading placeholder over the whole tab.
      if (!opts?.silent) setList({ status: "loading" });
      try {
        // Projects is the primary list; the global-memory row is best-effort —
        // its request failing (or a source without global memory) must not break
        // the project list, so it degrades to `null`.
        const [result, globalResult] = await Promise.all([
          bridge.request(
            createBridgeRoute("memory", "listImportableProjects"),
            { source },
          ),
          bridge
            .request(createBridgeRoute("memory", "listImportableGlobalMemory"), {
              source,
            })
            .catch(() => ({ global: null }) as { global: null }),
        ]);
        if (seq !== requestSeq.current) return;
        setList({
          status: "ready",
          rootPath: result.rootPath,
          projects: result.projects,
        });
        setGlobal(globalResult.global);
        // A fresh list is disk truth: drop local overlays for rows it lists,
        // except a row still mid-import.
        setRowStates((prev) => {
          const next = { ...prev };
          for (const row of result.projects) {
            if (next[row.slug]?.status !== "importing") delete next[row.slug];
          }
          return next;
        });
        setGlobalState((prev) =>
          prev?.status === "importing" ? prev : undefined,
        );
      } catch (error) {
        if (seq !== requestSeq.current) return;
        if (opts?.silent) return; // keep the list; the import itself succeeded
        setList({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [bridge, source],
  );

  // Load whenever the tab's dialog opens (or its source changes).
  React.useEffect(() => {
    if (!open || !source) return;
    void load();
  }, [open, source, load]);

  const importRow = React.useCallback(
    async (slug: string) => {
      if (!bridge || !source) return;
      setRowStates((prev) => ({ ...prev, [slug]: { status: "importing" } }));
      try {
        await bridge.request(createBridgeRoute("memory", "importProject"), {
          source,
          slug,
        });
        // Reflect DISK TRUTH rather than an optimistic "imported" overlay: an
        // add-only import may still leave the row `update` (files the user
        // hasn't synced), and a partial import must not read as done. The
        // silent reload drops the row's overlay and recomputes status from the
        // Velloc memory store.
        setRowStates((prev) => {
          const next = { ...prev };
          delete next[slug];
          return next;
        });
        await load({ silent: true });
      } catch (error) {
        setRowStates((prev) => ({
          ...prev,
          [slug]: {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    },
    [bridge, source, load],
  );

  const importGlobal = React.useCallback(async () => {
    if (!bridge || !source) return;
    setGlobalState({ status: "importing" });
    try {
      await bridge.request(
        createBridgeRoute("memory", "importGlobalMemory"),
        { source },
      );
      // Reflect DISK TRUTH: the silent reload recomputes the row's status
      // (`imported` when the block now matches the source) and drops the overlay.
      setGlobalState(undefined);
      await load({ silent: true });
    } catch (error) {
      setGlobalState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [bridge, source, load]);

  return {
    list,
    rowStates,
    global,
    globalState,
    refresh: () => void load(),
    importRow,
    importGlobal,
  };
}
