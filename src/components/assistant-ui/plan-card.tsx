import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from "react";
import { Check, ChevronDownIcon } from "lucide-react";
import { useScrollPositionLock } from "./use-scroll-position-lock";
import { rememberBounded } from "./boundedUiMemory";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible";
import { Card, CardContent, CardHeader } from "../ui/card";
import { cn } from "../../lib/utils";
import { ToolGroupContextProvider } from "./tool-group-context";

/**
 * Shared collapsible card shell for `TodoSection` and `ToolPlanStream`. `slotPrefix`
 * keeps each caller's `data-slot` / `aui-*` names, which external selectors pin.
 */

const ANIMATION_DURATION = 200;

// Per-card open state, keyed by the card's stable persistKey, surviving the
// live→persisted remount (in memory only). A card mounts collapsed unless toggled or
// force-opened by a search reveal.
const planCardOpenState = new Map<string, boolean>();

/**
 * A card's open state: what the person last left it at for `persistKey`,
 * else `defaultOpen`; opened when `forceOpen` turns on. A caller that needs
 * the state itself (a `ToolGroup` site raises it as `isExpanded`) holds it
 * here and hands it to `PlanCard` as `open` / `onOpenChange`.
 */
export function usePlanCardOpen({
  persistKey,
  defaultOpen = false,
  forceOpen = false,
}: {
  persistKey: string | undefined;
  defaultOpen?: boolean;
  forceOpen?: boolean;
}): [boolean, (next: boolean) => void] {
  const [open, setOpen] = useState<boolean>(() => {
    if (persistKey !== undefined) {
      const stored = planCardOpenState.get(persistKey);
      if (stored !== undefined) return stored;
    }
    return defaultOpen;
  });
  // A search asked for something inside this card. The body knows which
  // parts it put here, so it says so and the card opens — no hunting for
  // a trigger to click from outside, and no dependence on how the card
  // happened to be left. Applied as an effect, not controlled state, so
  // the user can close it again straight afterwards.
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  // Keep the map in sync so a later remount restores the current open state,
  // and a late-arriving persistKey (the first tool id streams in after mount,
  // in the tool-stream case) captures the heuristic default.
  useEffect(() => {
    if (persistKey === undefined) return;
    rememberBounded(planCardOpenState, persistKey, open);
  }, [persistKey, open]);
  return [open, setOpen];
}

export type PlanCardProps = {
  /**
   * The transcript lines this card covers, set by whoever built it from
   * the parts it wraps. Declared on the root so it is readable while the
   * card is COLLAPSED — which is exactly when a search jump needs to know
   * whether the line it is looking for is inside.
   */
  "data-line-from"?: string;
  "data-line-to"?: string;
  /**
   * `data-slot` / `aui-*` prefix. Existing e2e + scroll-lock selectors pin
   * `todo-section-*` and `tool-plan-stream-*`, so each caller passes its own prefix.
   */
  slotPrefix: "todo-section" | "tool-plan-stream";
  /** Stable persist key; `undefined` until the first tool id streams in. */
  persistKey: string | undefined;
  /**
   * Open state used when nothing is stored for `persistKey` yet. Defaults to
   * `false`: every multi-tool card mounts collapsed, running or settled.
   * Production callers do not pass it; tests use it to mount the body.
   */
  defaultOpen?: boolean;
  /** Opened because a search asked for something inside it. */
  forceOpen?: boolean;
  /**
   * The open state, when the caller holds it (`usePlanCardOpen`); the card
   * then reports a toggle through `onOpenChange` and keeps none of its own.
   */
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
  /**
   * Header row alignment — `start` for the two-line todo header (verb +
   * current-update text), `center` for the single-line tool-stream header.
   */
  align?: "start" | "center";
  /** Leading status disc (todo). Omitted for the tool-stream card. */
  leadingIcon?: ReactNode;
  /**
   * Header content between the leading icon and the chevron. Carries its own
   * `flex-1` / `grow` so it fills the row.
   */
  header: ReactNode;
  /** Right-aligned header adornment before the chevron (concurrent badge). */
  headerAdornment?: ReactNode;
  /** Green completion check shown outside the trigger when true. */
  showCompletionCheck?: boolean;
  /** Extra classes on the inner `Card` (e.g. the cancelled variant). */
  cardClassName?: string;
  /** Rendered inside the muted body panel above the rows (e.g. progress bar). */
  beforeBody?: ReactNode;
  /** Body rows — rendered inside the shared `<ul>`. */
  children: ReactNode;
};

const PlanCardImpl: FC<PlanCardProps> = ({
  slotPrefix,
  "data-line-from": lineFrom,
  "data-line-to": lineTo,
  persistKey,
  defaultOpen = false,
  forceOpen = false,
  open: heldOpen,
  onOpenChange,
  align = "center",
  leadingIcon,
  header,
  headerAdornment,
  showCompletionCheck = false,
  cardClassName,
  beforeBody,
  children,
}) => {
  const collapsibleRef = useRef<HTMLDivElement>(null);
  // A held state is the caller's alone: the card's own then remembers
  // nothing, so the two never write the same key.
  const isHeld = heldOpen !== undefined;
  const [ownOpen, setOwnOpen] = usePlanCardOpen({
    persistKey: isHeld ? undefined : persistKey,
    defaultOpen,
    forceOpen: isHeld ? false : forceOpen,
  });
  const open = isHeld ? heldOpen : ownOpen;
  const setOpen = isHeld ? onOpenChange : setOwnOpen;

  const lockScroll = useScrollPositionLock(collapsibleRef, ANIMATION_DURATION);
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) lockScroll();
      setOpen?.(next);
    },
    [lockScroll, setOpen],
  );

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot={`${slotPrefix}-root`}
      data-line-from={lineFrom}
      data-line-to={lineTo}
      open={open}
      onOpenChange={handleOpenChange}
      className={cn(`aui-${slotPrefix}-root group/${slotPrefix}-root w-full`)}
      style={
        {
          "--animation-duration": `${ANIMATION_DURATION}ms`,
        } as React.CSSProperties
      }
    >
      <Card
        data-slot={`${slotPrefix}-card`}
        className={cn("isolate w-full gap-3 py-4", cardClassName)}
      >
        <CardHeader
          className={cn(
            "flex flex-row justify-between gap-3 px-4",
            align === "start" ? "items-start" : "items-center",
          )}
        >
          <CollapsibleTrigger
            data-slot={`${slotPrefix}-trigger`}
            className={cn(
              `aui-${slotPrefix}-trigger group/trigger flex min-w-0 flex-1 gap-2`,
              "text-left text-body transition-colors",
              align === "start" ? "items-start" : "items-center",
            )}
          >
            {leadingIcon}
            {header}
            {headerAdornment}
            <ChevronDownIcon
              data-slot={`${slotPrefix}-trigger-chevron`}
              className={cn(
                `aui-${slotPrefix}-trigger-chevron size-4 shrink-0 text-muted-foreground`,
                "transition-transform duration-(--animation-duration) ease-out",
                "group-data-[state=closed]/trigger:-rotate-90",
                "group-data-[state=open]/trigger:rotate-0",
                align === "start" && "mt-1",
              )}
            />
          </CollapsibleTrigger>
          {showCompletionCheck && (
            <Check
              className={cn(
                "size-5 shrink-0 text-success",
                align === "start" && "mt-0.5",
              )}
            />
          )}
        </CardHeader>
        <CollapsibleContent
          data-slot={`${slotPrefix}-content`}
          className={cn(
            `aui-${slotPrefix}-content relative overflow-hidden text-body outline-none`,
            "group/collapsible-content ease-out",
            "data-[state=closed]:animate-collapsible-up",
            "data-[state=open]:animate-collapsible-down",
            "data-[state=closed]:fill-mode-forwards",
            "data-[state=closed]:pointer-events-none",
            "data-[state=open]:duration-(--animation-duration)",
            "data-[state=closed]:duration-(--animation-duration)",
          )}
        >
          <CardContent className="px-4">
            <div className="bg-muted/70 min-w-0 rounded-lg px-6 py-4">
              {beforeBody}
              <ToolGroupContextProvider>
                <ul className="min-w-0 space-y-1">{children}</ul>
              </ToolGroupContextProvider>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
};

export const PlanCard = memo(PlanCardImpl);
PlanCard.displayName = "PlanCard";
