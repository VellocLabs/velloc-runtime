import { memo, useState, type CSSProperties, type ReactNode,
  type Ref,
} from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { StepGlyph } from "./StatusIcon";
import type { PlanTodoStatus } from "../types";

export type PlanListItemProps = {
  /**
   * The row element, for callers that need to bring it into view — a
   * search jump asks the row to reveal ITSELF rather than hunting for it.
   */
  rowRef?: Ref<HTMLLIElement>;
  /** Transcript line this row renders, and the search-flash marker. */
  "data-line-ordinal"?: string;
  "data-search-hit"?: string;
  status: PlanTodoStatus;
  /**
   * Drives the `in_progress` status-disc spinner (default true). Pass
   * `false` to freeze it — used for restored/stopped plans whose
   * `in_progress` item should not look like it's still being worked on.
   */
  animated?: boolean;
  /**
   * Rendered next to the status icon. Plain text or any inline element;
   * styling reacts to `status` (muted/struck-through for cancelled, etc).
   */
  label: ReactNode;
  /**
   * Draws a vertical connector line between this row and the next. Pass
   * `false` for the last row in a list.
   */
  showConnector?: boolean;
  /**
   * Optional collapsible body. When omitted, the row renders as a bare
   * (non-collapsible) line.
   */
  children?: ReactNode;
  /**
   * Inline action rendered on the trigger header, between the label and the
   * chevron (e.g. a background launch's "Open in Background Tasks" button).
   * Must stop click propagation so it doesn't toggle the collapsible. Only
   * shown on the collapsible (has-children) variant.
   */
  trailingAction?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  className?: string;
  style?: CSSProperties;
};

function labelClassesForStatus(status: PlanTodoStatus): string {
  if (status === "pending") return "text-muted-foreground";
  if (status === "in_progress") return "text-foreground";
  if (status === "completed") return "text-muted-foreground";
  if (status === "cancelled") return "text-muted-foreground line-through";
  // `failed` deliberately uses muted-foreground (not text-destructive)
  // so the row doesn't read as alarming; the gray X disc carries the
  // "didn't succeed" signal. Distinguishes from cancelled by the
  // absence of the strikethrough.
  if (status === "failed") return "text-muted-foreground";
  return "";
}

const Connector = () => (
  <div
    className="bg-border absolute top-6 left-5 w-px"
    style={{ height: "calc(100% + 0.25rem)" }}
    aria-hidden="true"
  />
);

export const PlanListItem = memo(function PlanListItem({
  rowRef,
  "data-line-ordinal": lineOrdinal,
  "data-search-hit": searchHit,
  status,
  animated = true,
  label,
  showConnector,
  children,
  trailingAction,
  open: controlledOpen,
  onOpenChange,
  defaultOpen = false,
  className,
  style,
}: PlanListItemProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const handleOpenChange = (next: boolean) => {
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  const labelElement = (
    <span
      className={cn(
        "text-sm leading-6 font-medium break-words",
        labelClassesForStatus(status),
      )}
    >
      {label}
    </span>
  );

  if (!children) {
    return (
      <li
        ref={rowRef}
        data-line-ordinal={lineOrdinal}
        data-search-hit={searchHit}
        className={cn(
          "relative -mx-2 flex cursor-default items-start gap-3 rounded-md px-2 py-1.5",
          className,
        )}
        style={style}
      >
        {showConnector && <Connector />}
        <div className="relative z-10">
          <StepGlyph status={status} animated={animated} />
        </div>
        <div className="min-w-0 flex-1">{labelElement}</div>
        {trailingAction}
      </li>
    );
  }

  return (
    <li
      ref={rowRef}
      data-line-ordinal={lineOrdinal}
      data-search-hit={searchHit}
      className={cn(
        "relative -mx-2 min-w-0 cursor-default rounded-md",
        className,
      )}
      style={style}
    >
      {showConnector && <Connector />}
      <Collapsible asChild open={isOpen} onOpenChange={handleOpenChange}>
        <div className="data-[state=open]:bg-primary/5 min-w-0 rounded-md motion-safe:transition-all motion-safe:duration-200">
          <CollapsibleTrigger
            data-slot="plan-list-item-trigger"
            className="group/plan-item flex w-full cursor-default items-start gap-3 px-2 py-1.5 text-left"
          >
            <div className="relative z-10">
              <StepGlyph status={status} animated={animated} />
            </div>
            <span className="min-w-0 flex-1">{labelElement}</span>
            {trailingAction}
            <ChevronRight
              className={cn(
                "text-muted-foreground/50 group-hover/plan-item:text-muted-foreground",
                "mt-0.5 size-4 shrink-0",
                // Standard expand/collapse pattern: closed → ChevronRight
                // points right ▶ (no rotation), open → rotated 90° so it
                // points down ▼. The upstream registry shipped this as
                // `rotate-90` (closed) + `[transform:rotateY(180deg)]`
                // (open), which gave a counter-intuitive "down → left"
                // animation; we match the rest of the codebase (and
                // user expectation) here.
                "group-data-[state=open]/plan-item:rotate-90",
                "motion-safe:transition-transform motion-safe:duration-300",
                "motion-safe:ease-[cubic-bezier(0.34,1.56,0.64,1)]",
              )}
            />
          </CollapsibleTrigger>
          <CollapsibleContent
            className="group/plan-item-content"
            data-slot="plan-item-content"
          >
            <div
              className={cn(
                "min-w-0",
                "motion-safe:group-data-[state=closed]/plan-item-content:animate-out",
                "motion-safe:group-data-[state=closed]/plan-item-content:fade-out",
                "motion-safe:group-data-[state=closed]/plan-item-content:slide-out-to-top-1",
                "motion-safe:group-data-[state=closed]/plan-item-content:duration-150",
                "motion-safe:group-data-[state=open]/plan-item-content:animate-in",
                "motion-safe:group-data-[state=open]/plan-item-content:fade-in",
                "motion-safe:group-data-[state=open]/plan-item-content:slide-in-from-top-1",
                "motion-safe:group-data-[state=open]/plan-item-content:delay-75",
                "motion-safe:group-data-[state=open]/plan-item-content:duration-150",
                "motion-safe:group-data-[state=open]/plan-item-content:fill-mode-both",
              )}
            >
              <div className="min-w-0 pr-2 pb-1.5 pl-11">{children}</div>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </li>
  );
});
