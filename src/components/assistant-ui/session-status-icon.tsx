import type { FC } from "react";
import {
  BrainIcon,
  CirclePauseIcon,
  MessageCircleQuestionMarkIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionRunStatus } from "@/browser/webview/sessionRunStatus";
import { useT } from "@/browser/webview/i18n";
import type { MessageKey } from "@/browser/webview/i18n/messages/en";

const GLYPHS: Record<SessionRunStatus, { Icon: LucideIcon; label: MessageKey }> = {
  thinking: { Icon: BrainIcon, label: "sessionStatus.thinking" },
  tools: { Icon: WrenchIcon, label: "sessionStatus.runningTools" },
  awaiting: { Icon: MessageCircleQuestionMarkIcon, label: "sessionStatus.awaitingReply" },
  paused: { Icon: CirclePauseIcon, label: "sessionStatus.paused" },
};

/**
 * One session status as an icon (F-17): an animated brain, wrench or question
 * bubble, or a still pause glyph. Size comes from `className` (default 14px);
 * the motion is scaled to stay inside the box at any size. Named for assistive
 * technology unless `decorative`, where the surrounding text already says it.
 */
export const SessionStatusIcon: FC<{
  status: SessionRunStatus;
  className?: string;
  decorative?: boolean;
}> = ({ status, className, decorative }) => {
  const t = useT();
  const { Icon, label } = GLYPHS[status];
  return (
    <Icon
      data-slot="session-status-icon"
      data-status={status}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : t(label)}
      className={cn(
        "nexus-session-status size-3.5 shrink-0",
        status === "awaiting" ? "text-primary" : "text-muted-foreground",
        className,
      )}
    />
  );
};
