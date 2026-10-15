import * as React from "react";

import { createBridgeRoute } from "../../bridge/protocol/core";
import type {
  ImportSessionListRow,
  ImportSource,
} from "../../bridge/protocol/sessionImport";
import {
  IMPORT_PAGE_SIZE,
  type ImportConvertResult,
} from "../../../sessionImport/protocol";
import { ImportWorkerClient } from "../../../sessionImport/workerClient";
import { randomUuid } from "../../../utils/randomUuid";
import type { NexusSettingsBridge } from "../nexusSettingsBridge";

export type ImportListState =
  | { status: "idle" }
  | { status: "loading"; page: number }
  | {
      status: "ready";
      rootPath: string;
      total: number;
      page: number;
      pageSize: number;
      rows: ImportSessionListRow[];
    }
  | { status: "error"; message: string };

export type ImportRowState =
  | { status: "importing" }
  | { status: "imported"; sessionId: string }
  | { status: "error"; message: string };

/**
 * The window-owned import Worker client, ONE per page: Chromium exposes `Worker` in
 * window and dedicated-worker scopes only. Exposed on
 * `globalThis.__NEXUS_IMPORT_WORKER_E2E__` for e2e.
 */
let importWorkerClient: ImportWorkerClient | null = null;
export function getImportWorkerClient(): ImportWorkerClient {
  if (!importWorkerClient) {
    importWorkerClient = new ImportWorkerClient();
    (globalThis as unknown as { __NEXUS_IMPORT_WORKER_E2E__?: unknown })
      .__NEXUS_IMPORT_WORKER_E2E__ = importWorkerClient;
  }
  return importWorkerClient;
}

/**
 * Dialog state for one import source: `readSession` → Worker `convert` →
 * `writeSession`. A row's "imported" state comes from the SERVER, overlaid locally
 * only while an import is in flight or just finished.
 */
export function useSessionImport(
  bridge: NexusSettingsBridge | null,
  source: ImportSource | null,
  open: boolean,
) {
  const [list, setList] = React.useState<ImportListState>({ status: "idle" });
  const [rowStates, setRowStates] = React.useState<
    Record<string, ImportRowState>
  >({});
  const requestSeq = React.useRef(0);

  const load = React.useCallback(
    async (page: number) => {
      if (!bridge || !source) return;
      const seq = ++requestSeq.current;
      setList({ status: "loading", page });
      try {
        const result = await bridge.request(
          createBridgeRoute("sessionImport", "listSessions"),
          { source, page, pageSize: IMPORT_PAGE_SIZE },
        );
        if (seq !== requestSeq.current) return;
        setList({
          status: "ready",
          rootPath: result.rootPath,
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
          rows: result.rows,
        });
        // A fresh page is disk truth: drop local overlays for rows it lists.
        setRowStates((prev) => {
          const next = { ...prev };
          for (const row of result.rows) {
            if (next[row.path]?.status !== "importing") delete next[row.path];
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
    },
    [bridge, source],
  );

  // Load page 0 whenever the dialog opens (or its source changes).
  React.useEffect(() => {
    if (!open || !source) return;
    void load(0);
  }, [open, source, load]);

  const importRow = React.useCallback(
    async (path: string) => {
      if (!bridge || !source) return;
      setRowStates((prev) => ({ ...prev, [path]: { status: "importing" } }));
      try {
        const read = await bridge.request(
          createBridgeRoute("sessionImport", "readSession"),
          { source, path },
        );
        let sessionId = read.sessionId;
        if (!read.skipped) {
          // Hand the bytes to the isolated Worker; a crash or hang there is
          // an error envelope for THIS row, nothing else. The buffers are
          // cloned (not transferred) so the client can re-run the convert
          // inline if the Worker crashes — see ImportWorkerClient.recoverInline.
          const toBuffer = (bytes: Uint8Array) =>
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer;
          const buffer = toBuffer(read.bytes);
          const subagents = (read.subagents ?? []).map((entry) => ({
            agentId: entry.agentId,
            path: entry.path,
            bytes: toBuffer(entry.bytes),
            ...(entry.meta ? { meta: entry.meta } : {}),
          }));
          const converted = await getImportWorkerClient().request({
            id: `convert-${randomUuid()}`,
            kind: "convert",
            source,
            path,
            bytes: buffer,
            now: Date.now(),
            subagents,
          });
          if (!converted.ok) {
            throw new Error(`${converted.error.code}: ${converted.error.message}`);
          }
          const written = await bridge.request(
            createBridgeRoute("sessionImport", "writeSession"),
            { source, result: converted.result as ImportConvertResult },
          );
          sessionId = written.sessionId;
        }
        setRowStates((prev) => ({
          ...prev,
          [path]: { status: "imported", sessionId },
        }));
      } catch (error) {
        setRowStates((prev) => ({
          ...prev,
          [path]: {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    },
    [bridge, source],
  );

  const currentPage =
    list.status === "ready" || list.status === "loading" ? list.page : 0;

  return {
    list,
    rowStates,
    currentPage,
    goToPage: (page: number) => void load(page),
    refresh: () => void load(currentPage),
    importRow,
  };
}
