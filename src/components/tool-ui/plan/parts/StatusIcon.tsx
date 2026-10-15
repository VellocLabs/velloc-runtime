import { memo } from "react";
import { Check, CircleIcon, Loader2, Pause, X } from "lucide-react";
import type { PlanTodoStatus } from "../types";

/**
 * Status disc for Plan rows and the streaming tool-call list, adapted from the upstream
 * tool-ui Plan. `animated={false}` renders a static pause glyph instead of a frozen
 * spinner, for a restored/stopped turn with an `in_progress` item.
 */
export const StepGlyph = memo(function StepGlyph({
  status,
  animated = true,
}: {
  status: PlanTodoStatus;
  animated?: boolean;
}) {
  if (status === "pending") {
    return (
      <CircleIcon
        className="text-muted-foreground size-6 shrink-0 motion-safe:transition-all motion-safe:duration-200"
        aria-hidden="true"
        strokeWidth={1.5}
      />
    );
  }

  if (status === "in_progress") {
    // Paused (restored/stopped turn): a neutral disc with a pause glyph so it
    // reads as deliberately halted, not as a spinner that froze mid-frame.
    if (!animated) {
      return (
        <span
          className="border-border bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full border shadow-sm motion-safe:transition-all motion-safe:duration-300"
          aria-hidden="true"
        >
          <Pause className="size-3.5" strokeWidth={2.5} fill="currentColor" />
        </span>
      );
    }
    return (
      <span
        className="border-border bg-card flex size-6 shrink-0 items-center justify-center rounded-full border shadow-[0_0_0_4px_color-mix(in_oklch,var(--primary)_10%,transparent)] motion-safe:transition-all motion-safe:duration-300"
        aria-hidden="true"
      >
        <Loader2 className="text-primary size-5 motion-safe:animate-spin" />
      </span>
    );
  }

  if (status === "completed") {
    return (
      <span
        className="border-primary bg-primary flex size-6 shrink-0 items-center justify-center rounded-full border shadow-sm motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-75 motion-safe:duration-300 motion-safe:ease-out"
        aria-hidden="true"
      >
        <Check
          className="text-primary-foreground size-4 motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-75 motion-safe:delay-75 motion-safe:duration-200 motion-safe:fill-mode-both"
          strokeWidth={3}
        />
      </span>
    );
  }

  if (status === "cancelled" || status === "failed") {
    // Cancelled and failed share the same neutral gray disc + white X.
    // We intentionally do NOT use the destructive palette here — both
    // states should read as "didn't succeed" without screaming for
    // attention. The label treatment downstream distinguishes them:
    // cancelled gets strikethrough, failed gets plain muted text.
    return (
      <span
        className="border-muted-foreground bg-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full border shadow-sm motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-75 motion-safe:duration-300 motion-safe:ease-out"
        aria-hidden="true"
      >
        <X
          className="text-background size-4 motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-75 motion-safe:delay-75 motion-safe:duration-200 motion-safe:fill-mode-both"
          strokeWidth={3}
        />
      </span>
    );
  }

  return null;
});
