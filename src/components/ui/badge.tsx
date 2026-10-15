import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * Badge, ported from the assistant-ui registry (`badge`) into `components/ui`
 * (CVA + `radix-ui` Slot + `cn`, matching `button.tsx`).
 */
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 font-medium text-xs transition-colors [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        outline: "border-border text-foreground",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground",
        muted: "border-transparent bg-muted text-muted-foreground",
        ghost: "border-transparent text-muted-foreground",
        info: "border-transparent bg-info/15 text-info",
        warning:
          "border-transparent bg-warning/15 text-warning",
        success:
          "border-transparent bg-success/15 text-success",
        destructive:
          "border-transparent bg-destructive/15 text-destructive",
      },
      size: {
        sm: "h-5 px-1.5 text-[0.6875rem]",
        default: "h-6",
        lg: "h-7 px-2.5 text-sm",
      },
    },
    defaultVariants: {
      variant: "outline",
      size: "default",
    },
  },
);

function Badge({
  className,
  variant = "outline",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      data-size={size}
      className={cn(badgeVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
