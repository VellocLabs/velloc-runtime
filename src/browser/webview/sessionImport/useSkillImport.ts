import * as React from "react";

import { createBridgeRoute } from "../../bridge/protocol/core";
import type { ImportableSkillRow } from "../../bridge/protocol/skills";
import type { ImportSource } from "../../bridge/protocol/sessionImport";
import type { NexusSettingsBridge } from "../nexusSettingsBridge";

export type SkillListState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; rootPath: string; skills: ImportableSkillRow[] }
  | { status: "error"; message: string };

export type SkillRowState =
  | { status: "importing" }
  | { status: "imported" }
  | { status: "error"; message: string };

/**
 * Dialog state for one import source's Skills tab, via the worker-served `skills`
 * capability (`importLocal` copies one skill dir into `~/.velloc/skills/`). A row's
 * "imported" state comes from the SERVER, overlaid locally only while an import is
 * in flight or just finished.
 */
export function useSkillImport(
  bridge: NexusSettingsBridge | null,
  source: ImportSource | null,
  open: boolean,
) {
  const [list, setList] = React.useState<SkillListState>({ status: "idle" });
  const [rowStates, setRowStates] = React.useState<
    Record<string, SkillRowState>
  >({});
  const requestSeq = React.useRef(0);

  const load = React.useCallback(async () => {
    if (!bridge || !source) return;
    const seq = ++requestSeq.current;
    setList({ status: "loading" });
    try {
      const result = await bridge.request(
        createBridgeRoute("skills", "listImportable"),
        { source },
      );
      if (seq !== requestSeq.current) return;
      setList({
        status: "ready",
        rootPath: result.rootPath,
        skills: result.skills,
      });
      // A fresh list is disk truth: drop local overlays for rows it lists,
      // except a row still mid-import.
      setRowStates((prev) => {
        const next = { ...prev };
        for (const row of result.skills) {
          if (next[row.dir]?.status !== "importing") delete next[row.dir];
        }
        return next;
      });
    } catch (error) {
      if (seq !== requestSeq.current) return;
      setList({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [bridge, source]);

  // Load whenever the tab's dialog opens (or its source changes).
  React.useEffect(() => {
    if (!open || !source) return;
    void load();
  }, [open, source, load]);

  const importRow = React.useCallback(
    async (dir: string) => {
      if (!bridge || !source) return;
      setRowStates((prev) => ({ ...prev, [dir]: { status: "importing" } }));
      try {
        await bridge.request(createBridgeRoute("skills", "importLocal"), {
          source,
          dir,
        });
        setRowStates((prev) => ({ ...prev, [dir]: { status: "imported" } }));
      } catch (error) {
        setRowStates((prev) => ({
          ...prev,
          [dir]: {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    },
    [bridge, source],
  );

  return {
    list,
    rowStates,
    refresh: () => void load(),
    importRow,
  };
}
