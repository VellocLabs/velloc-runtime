import { ChevronsRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Compact ">>" jump from a body-less tool card to its detail panel. A `role="button"`
 * SPAN, never a `<button>`: it always sits inside a trigger `<button>`, and nested
 * buttons crash the guest renderer. Stops click propagation so the card does not toggle.
 */
export function PanelJumpChevron({
  onOpen,
  label,
  dataTestId,
  className,
}: {
  /** Runs the jump (open the panel / drawer). */
  onOpen: () => void;
  /** Accessible name + tooltip — the ">>" glyph carries no text of its own. */
  label: string;
  dataTestId: string;
  className?: string;
}) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={label}
      title={label}
      data-testid={dataTestId}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        onOpen();
      }}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center rounded-md border px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      <ChevronsRightIcon className="size-3.5 shrink-0" />
    </span>
  );
}
