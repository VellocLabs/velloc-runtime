import {
  coerceFileText,
  FileContentView,
  FilePathHeader,
  headLines,
  MAX_INLINE_FILE_LINES,
} from "@/components/assistant-ui/file-content-view";
import { useRightPanelContent } from "@/components/assistant-ui/right-panel-content-context";
import { ToolDetailTree } from "@/components/assistant-ui/tool-detail-tree";
import { useT } from "@/browser/webview/i18n";

/**
 * Inline view for the `Read` tool: a clickable path header over the line-numbered slice,
 * capped to {@link MAX_INLINE_FILE_LINES}. Mounted only inside the expanded card;
 * `args`/`result` are undefined until the lazy sidecar loads.
 */

/** Lines the card mounts; the rest are counted and left to the Files pane (F-9). */
export const READ_CARD_MOUNTED_LINES = 200;

export type ReadArgs = { file_path?: string };

function readFilePath(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as ReadArgs).file_path;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function ReadToolView({
  args,
  result,
}: {
  args: unknown;
  result: unknown;
}) {
  // Running lazy-detail call: args/result haven't loaded yet — the generic
  // "Tool is still running." row already covers this state. Without this
  // guard the fallback below renders <ToolDetailTree value={undefined}>,
  // which prints the literal string "undefined".
  if (args === undefined && result === undefined) {
    return null;
  }

  const filePath = readFilePath(args);
  const { openFile } = useRightPanelContent();
  const t = useT();
  const content = coerceFileText(result);
  const { head, more } = headLines(content, READ_CARD_MOUNTED_LINES);

  // No path AND no content to show — nothing read-specific to render; fall back
  // to the generic tree so the user still sees whatever came back.
  if (!filePath && content.length === 0) {
    return <ToolDetailTree value={result} />;
  }

  return (
    <div className="aui-read-tool-view flex flex-col gap-1.5 px-4">
      {filePath && (
        <FilePathHeader
          path={filePath}
          onOpen={openFile ? () => openFile({ path: filePath }) : undefined}
          copyText={content}
          copyTooltip={t("filePanel.copyFileContents")}
        />
      )}
      {content.length > 0 ? (
        <>
          <FileContentView content={head} maxLines={MAX_INLINE_FILE_LINES} />
          {more > 0 && (
            <MoreLinesRow
              more={more}
              onOpen={filePath && openFile ? () => openFile({ path: filePath }) : undefined}
            />
          )}
        </>
      ) : (
        <p className="text-muted-foreground text-body">
          {t("filePanel.noContent")}
        </p>
      )}
    </div>
  );
}

function MoreLinesRow({ more, onOpen }: { more: number; onOpen?: () => void }) {
  const t = useT();
  const label = t(more === 1 ? "filePanel.moreLinesOne" : "filePanel.moreLines", {
    n: more.toLocaleString(),
  });
  if (!onOpen) {
    return (
      <p data-slot="read-more-lines" className="text-muted-foreground text-body">
        {label}
      </p>
    );
  }
  return (
    <button
      type="button"
      data-slot="read-more-lines"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      className="self-start text-left text-muted-foreground text-body hover:text-foreground hover:underline"
    >
      {label}
    </button>
  );
}
