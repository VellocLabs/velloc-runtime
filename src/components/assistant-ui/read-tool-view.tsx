import {
  coerceFileText,
  FileContentView,
  FilePathHeader,
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
        <FileContentView content={content} maxLines={MAX_INLINE_FILE_LINES} />
      ) : (
        <p className="text-muted-foreground text-body">
          {t("filePanel.noContent")}
        </p>
      )}
    </div>
  );
}
