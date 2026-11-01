import { useEffect, useRef, useState, type FC, type ReactNode } from "react";
import { ArrowRightIcon } from "lucide-react";

import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { requestTeammateJump } from "@/browser/webview/teammateJumpRequests";
import { useT } from "@/browser/webview/i18n";
import { useSessionStatus, type SessionStatusEntry } from "@/browser/webview/sessionStatusStore";
import {
  activityAge,
  childSessionStatus,
  childStateLabel,
  folderName,
} from "@/browser/webview/childSessionStatus";
import { ChildStateDot } from "@/components/assistant-ui/child-session-card";
import { useThreadForeground } from "@/components/assistant-ui/thread-foreground";

const OPEN_DELAY_MS = 250;
const CLOSE_DELAY_MS = 150;
const PLACEHOLDER_TITLE = "New Thread";

function titleOf(entry: SessionStatusEntry | undefined, fallback: string): string {
  const title = entry?.title?.trim();
  return title && title !== PLACEHOLDER_TITLE ? title : fallback;
}

function textOf(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  return "";
}

/**
 * A session named in a transcript (`[title](#session/<id>)`): an inline chip
 * with the session's title and state dot. Hovering shows its state, kind,
 * parent and last activity with an Open action; clicking opens the session.
 * The popover closes while its thread is hidden.
 */
export const SessionLinkChip: FC<{ sessionId: string; children?: ReactNode }> = ({
  sessionId,
  children,
}) => {
  const t = useT();
  const foreground = useThreadForeground();
  const entry = useSessionStatus(sessionId);
  const parent = useSessionStatus(entry?.parentSessionId);
  const status = childSessionStatus(entry);
  const linkText = textOf(children).trim() || sessionId;
  const title = titleOf(entry, linkText);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const later = (next: boolean, ms: number) => {
    clearTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      setOpen(next);
    }, ms);
  };
  useEffect(() => clearTimer, []);
  useEffect(() => {
    if (!foreground) {
      clearTimer();
      setOpen(false);
    }
  }, [foreground]);

  const known = entry !== undefined;
  const openSession = () => {
    clearTimer();
    setOpen(false);
    if (known) requestTeammateJump({ sessionId });
  };
  const openLabel = t("childSession.openAria", { title });
  const kind = entry?.lineageKind ? t(`childSession.lineage.${entry.lineageKind}`) : null;
  const folder = folderName(entry?.projectRoot);

  return (
    <Popover
      open={open && foreground}
      onOpenChange={(next) => {
        if (!next) setOpen(false);
      }}
    >
      <PopoverAnchor asChild>
        <button
          type="button"
          data-testid="session-link-chip"
          data-session-id={sessionId}
          data-status={status.state}
          aria-label={known ? openLabel : title}
          onClick={openSession}
          onPointerEnter={() => later(true, OPEN_DELAY_MS)}
          onPointerLeave={() => later(false, CLOSE_DELAY_MS)}
          onFocus={() => later(true, 0)}
          onBlur={() => later(false, CLOSE_DELAY_MS)}
          className={cn(
            "inline-flex max-w-[24rem] items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0 align-baseline text-[0.9em] leading-snug no-underline transition-colors hover:bg-accent",
            !known && "cursor-default",
          )}
        >
          <ChildStateDot state={status.state} />
          <span className="truncate">{title}</span>
        </button>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        className="w-64 p-3 text-xs"
        data-testid="session-link-popover"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={clearTimer}
        onPointerLeave={() => later(false, CLOSE_DELAY_MS)}
      >
        <div className="truncate text-sm font-medium" data-testid="session-link-popover-title">
          {title}
        </div>
        <div className="mt-1.5 flex items-center gap-1.5" data-testid="session-link-popover-state">
          <ChildStateDot state={status.state} />
          <span>{childStateLabel(status.state, t)}</span>
          {kind && <span className="text-muted-foreground">· {kind}</span>}
        </div>
        {parent && (
          <div className="mt-1 truncate text-muted-foreground" data-testid="session-link-popover-parent">
            {t("childSession.chip.parent", { title: titleOf(parent, parent.sessionId) })}
          </div>
        )}
        {folder && (
          <div className="mt-1 truncate text-muted-foreground" data-testid="session-link-popover-folder">
            {folder}
          </div>
        )}
        {entry?.updatedAt ? (
          <div className="mt-1 text-muted-foreground" data-testid="session-link-popover-activity">
            {t("childSession.chip.lastActivity", { when: activityAge(entry.updatedAt, Date.now(), t) })}
          </div>
        ) : null}
        {known && (
          <button
            type="button"
            data-testid="session-link-popover-open"
            onClick={openSession}
            aria-label={openLabel}
            className="mt-2 flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent"
          >
            {t("childSession.open")}
            <ArrowRightIcon className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
};
