import type { ComponentType, FC } from "react";
import {
  CirclePauseIcon,
  Icon as IconFromNodes,
  MessageCircleQuestionMarkIcon,
  WrenchIcon,
  type IconNode,
  type LucideProps,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionRunStatus } from "@/browser/webview/sessionRunStatus";
import { useT } from "@/browser/webview/i18n";
import type { MessageKey } from "@/browser/webview/i18n/messages/en";

// Lucide's brain, each stroke with `pathLength="1"` so the draw loop can
// dash it in unit lengths whatever its real length.
const BRAIN_DRAW_NODES: IconNode = [
  "M12 18V5",
  "M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4",
  "M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5",
  "M17.997 5.125a4 4 0 0 1 2.526 5.77",
  "M18 18a4 4 0 0 0 2-7.464",
  "M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517",
  "M6 18a4 4 0 0 1-2-7.464",
  "M6.003 5.125a4 4 0 0 0-2.526 5.77",
].map((d, i) => ["path", { d, pathLength: "1", key: `brain-${i}` }]);

const BrainDrawIcon: FC<LucideProps> = (props) => (
  <IconFromNodes iconNode={BRAIN_DRAW_NODES} {...props} />
);

const GLYPHS: Record<SessionRunStatus, { Icon: ComponentType<LucideProps>; label: MessageKey }> = {
  thinking: { Icon: BrainDrawIcon, label: "sessionStatus.thinking" },
  tools: { Icon: WrenchIcon, label: "sessionStatus.runningTools" },
  awaiting: { Icon: MessageCircleQuestionMarkIcon, label: "sessionStatus.awaitingReply" },
  paused: { Icon: CirclePauseIcon, label: "sessionStatus.paused" },
};

/**
 * One session status as an icon (F-17): a brain drawing itself, a wrench or question
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
