import { type FC, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * Monochrome "ink drop ripple" busy indicator (currentColor, transform + opacity only).
 * Keeps animating under reduced-motion; `aria-hidden` is forced.
 */
export const InkRipple: FC<HTMLAttributes<HTMLSpanElement>> = ({
  className,
  ...props
}) => (
  <span className={cn("nexus-ripple", className)} {...props} aria-hidden="true">
    <i />
    <i />
    <i />
  </span>
);
