import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderIcon } from "lucide-react";
import type { ToolCallMessagePartStatus } from "@assistant-ui/react";
import { useToolCallDetailContext } from "@/components/assistant-ui/tool-call-detail-context";
import { shouldLazyLoadToolDetail } from "../../utils/toolCallDetails";
import type { BrowserToolCallDetailRecord } from "../../utils/toolCallDetails";
import { modToolUseValue, useModToolUseRewrite } from "@/components/assistant-ui/mod-ui-context";
import { cn } from "@/lib/utils";
import { ToolDetailTree } from "@/components/assistant-ui/tool-detail-tree";
import {
  EDIT_TOOL_ID,
  READ_TOOL_ID,
} from "@/prompting/fileToolNames";
import {
  EditToolDiff,
  isEditArgs,
} from "@/components/assistant-ui/edit-tool-diff";
import { ReadToolView } from "@/components/assistant-ui/read-tool-view";
import { StaticMarkdown } from "@/components/assistant-ui/static-markdown";
import { MAIL_TOOL_ID } from "@/utils/toolLabels";
import { SPAWN_TOOL_ID, extractBackgroundTaskId, isBackgroundAgentRequest, isPendingBackgroundAgentResult } from "./tool-fallback";
import { useT } from "@/browser/webview/i18n";

const DETAIL_RETRY_DELAY_MS = 2000;
const DETAIL_MAX_RETRIES = 2;

/**
 * Lazy-load state for a single browser tool call. Never fetches automatically: the
 * caller invokes `loadDetail()` when the row is opened.
 */
function useLazyToolCallDetail(
  toolCallId: string,
  enabled: boolean,
  open: boolean,
  status: ToolCallMessagePartStatus | undefined,
): {
  detail: BrowserToolCallDetailRecord | null | undefined;
  detailLoading: boolean;
  detailError: string | null;
} {
  const t = useT();
  const toolCallDetailContext = useToolCallDetailContext();
  const [detail, setDetail] = useState<
    BrowserToolCallDetailRecord | null | undefined
  >(() =>
    enabled
      ? toolCallDetailContext?.getCachedToolCallDetail(toolCallId)
      : undefined,
  );
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const loadingRef = useRef(false);
  const retryCountRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    setDetail(toolCallDetailContext?.getCachedToolCallDetail(toolCallId));
  }, [enabled, toolCallDetailContext, toolCallId]);

  const loadDetail = useCallback(async () => {
    if (!enabled || loadingRef.current) return;
    const cached = toolCallDetailContext?.getCachedToolCallDetail(toolCallId);
    if (cached !== undefined) {
      setDetail(cached);
      return;
    }
    loadingRef.current = true;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const loaded =
        await toolCallDetailContext?.loadToolCallDetail(toolCallId);
      setDetail(loaded ?? null);
    } catch (error) {
      setDetailError(
        error instanceof Error
          ? error.message
          : t("toolDetail.loadFailed"),
      );
    } finally {
      loadingRef.current = false;
      setDetailLoading(false);
    }
  }, [enabled, toolCallDetailContext, toolCallId]);

  useEffect(() => {
    if (
      !open ||
      !enabled ||
      status?.type === "running" ||
      detail !== undefined
    ) {
      return;
    }
    void loadDetail();
  }, [detail, enabled, loadDetail, open, status?.type]);

  useEffect(() => {
    if (
      detail !== null ||
      !open ||
      !enabled ||
      status?.type === "running" ||
      retryCountRef.current >= DETAIL_MAX_RETRIES
    ) {
      return;
    }
    const timer = setTimeout(() => {
      retryCountRef.current++;
      toolCallDetailContext?.clearCachedDetail(toolCallId);
      setDetail(undefined);
    }, DETAIL_RETRY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [detail, open, enabled, status?.type, toolCallId, toolCallDetailContext]);

  return { detail, detailLoading, detailError };
}

export type ToolCallDetailBodyProps = {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: unknown;
  status: ToolCallMessagePartStatus | undefined;
  /** Whether the row hosting this body is currently expanded. */
  open: boolean;
  className?: string;
};

/**
 * Body of a tool-call row (args, error, result) without the surrounding collapsible,
 * lazily loading detail for browser tools whose payloads are not in the message part.
 */
export function ToolCallDetailBody({
  toolCallId,
  toolName,
  args,
  result,
  status,
  open,
  className,
}: ToolCallDetailBodyProps) {
  const t = useT();
  const isBackgroundAgent =
    toolName === SPAWN_TOOL_ID && isBackgroundAgentRequest(args);
  const lazyDetail = shouldLazyLoadToolDetail(toolName);
  const { detail, detailLoading, detailError } = useLazyToolCallDetail(
    toolCallId,
    lazyDetail,
    open,
    status,
  );
  const [showOrigin, setShowOrigin] = useState(false);

  const isCancelled =
    status?.type === "incomplete" && status.reason === "cancelled";
  const isError = status?.type === "incomplete" && !isCancelled;

  // A mod's `ToolUse` rewrite (F-25) stands in for the transcript's
  // value and for the sidecar's alike: the hook saw the stored row.
  const modRewrite = useModToolUseRewrite();
  const displayArgs = modToolUseValue(modRewrite, "input", lazyDetail ? detail?.args : args);
  const displayResult = modToolUseValue(modRewrite, "output", lazyDetail ? detail?.result : result);
  const displayOrigin = lazyDetail ? detail?.origin : undefined;
  const hasOrigin = displayOrigin !== undefined;
  const resultToShow = showOrigin && hasOrigin ? displayOrigin : displayResult;
  // A background Agent launch's task / result / model live in the Background
  // Tasks drawer — the inline body must stay empty. This mirrors the guard in
  // tool-fallback.tsx's AgentToolDetail: suppress when the ack has landed
  // (result carries a task id) OR while the launch is still in flight
  // (running / pending-ack placeholder).
  const backgroundTaskId =
    isBackgroundAgent
      ? extractBackgroundTaskId(
          typeof displayResult === "string" ? displayResult : "",
        )
      : null;
  const hideBackgroundAgentDetails =
    isBackgroundAgent &&
    (backgroundTaskId !== null ||
      status?.type === "running" ||
      isPendingBackgroundAgentResult(displayResult));

  const errorText = (() => {
    if (!isError || !status || status.type !== "incomplete") return null;
    const err = status.error;
    if (!err) return null;
    return typeof err === "string" ? err : JSON.stringify(err);
  })();

  return (
    <div
      data-slot="tool-call-detail-body"
      className={cn("flex flex-col gap-2 text-body", className)}
    >
      {lazyDetail && !hideBackgroundAgentDetails && status?.type === "running" ? (
        <div className="text-muted-foreground">
          {t("toolDetail.stillRunning")}
        </div>
      ) : null}
      {lazyDetail && !hideBackgroundAgentDetails && detailLoading ? (
        <div className="text-muted-foreground flex items-center gap-2">
          <LoaderIcon className="size-3 animate-spin" />
          <span>{t("toolDetail.loading")}</span>
        </div>
      ) : null}
      {lazyDetail && !hideBackgroundAgentDetails && detailError ? (
        <div className="text-destructive">{detailError}</div>
      ) : null}

      {errorText ? (
        <div>
          <p className="text-muted-foreground font-semibold">
            {isCancelled
              ? t("toolDetail.cancelledReason")
              : t("toolDetail.errorLabel")}
          </p>
          <p className="text-muted-foreground">{errorText}</p>
        </div>
      ) : null}

      {/* Read gets the dedicated inline file view (path header → Files panel +
          line-numbered content) on the Plan surface too, not the raw JSON
          tree. It folds args + result into one view, so it replaces BOTH the
          Args and Result sections below. SendMessage is the same shape of
          exception: the row already names the recipient, so its expand shows
          the message TEXT and nothing else — not the {to, message, team} args
          tree, and not the one-line delivery ack. Both surfaces have to agree;
          the card in tool-fallback.tsx renders the identical pair. */}
      {!hideBackgroundAgentDetails ? (
        toolName === READ_TOOL_ID ? (
          displayArgs !== undefined || displayResult !== undefined ? (
            <div className={cn(isCancelled && "opacity-60")}>
              <ReadToolView args={displayArgs} result={displayResult} />
            </div>
          ) : null
        ) : toolName === MAIL_TOOL_ID ? (
          typeof (displayArgs as { message?: string } | undefined)?.message ===
          "string" ? (
            <div
              className={cn(isCancelled && "opacity-60")}
              data-testid="send-message-body"
            >
              <StaticMarkdown
                content={
                  (displayArgs as { message: string }).message
                }
              />
            </div>
          ) : null
        ) : (
          <>
            {displayArgs !== undefined ? (
              <div className={cn(isCancelled && "opacity-60")}>
                <p className="mb-1 font-semibold">
                  {t("toolDetail.argsLabel")}
                </p>
                {toolName === EDIT_TOOL_ID && isEditArgs(displayArgs) ? (
                  // Forward the host editDiff (file-relative line numbers + real counts).
                  <EditToolDiff args={displayArgs} editDiff={detail?.editDiff} />
                ) : (
                  <ToolDetailTree value={displayArgs} />
                )}
              </div>
            ) : null}

            {!isCancelled && (displayResult !== undefined || detailLoading) ? (
              <div className="border-t border-dashed pt-2">
                <div className="flex items-center justify-between">
                  <p className="font-semibold">
                    {showOrigin && hasOrigin
                      ? t("toolDetail.resultFullLabel")
                      : hasOrigin
                        ? t("toolDetail.resultCompactLabel")
                        : t("toolDetail.resultLabel")}
                  </p>
                  {hasOrigin && (
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground text-caption underline transition-colors"
                      onClick={() => setShowOrigin(prev => !prev)}
                    >
                      {showOrigin
                        ? t("toolDetail.showCompact")
                        : t("toolDetail.showFullOriginal")}
                    </button>
                  )}
                </div>
                {detailLoading ? (
                  <div className="text-muted-foreground flex items-center gap-2 py-2">
                    <LoaderIcon className="size-3 animate-spin" />
                    <span>{t("toolDetail.loadingFull")}</span>
                  </div>
                ) : (
                  <ToolDetailTree value={resultToShow} />
                )}
              </div>
            ) : null}
          </>
        )
      ) : null}

      {lazyDetail &&
      !detailLoading &&
      !detailError &&
      detail === null &&
      status?.type !== "running" ? (
        <div className="text-muted-foreground">
          {t("toolDetail.noStoredDetails")}
        </div>
      ) : null}
    </div>
  );
}
