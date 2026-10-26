import * as React from "react";
import { Select as SelectPrimitive } from "radix-ui";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Select: radix-ui Select in the `components/ui` convention, modeled on the
 * assistant-ui registry `select`. Composable sub-components plus a `<Select options>`
 * wrapper; no runtime dependency.
 */

export const selectTriggerVariants = cva(
  "flex w-fit items-center justify-between gap-2 rounded-md text-sm whitespace-nowrap outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground [&>span]:truncate [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        outline: "border bg-background hover:bg-accent/40",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        muted: "bg-secondary text-secondary-foreground",
      },
      size: {
        sm: "h-8 px-2.5",
        default: "h-9 px-3",
        lg: "h-10 px-3.5",
      },
    },
    defaultVariants: { variant: "outline", size: "default" },
  },
);

const SelectRoot = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;
const SelectLabel = SelectPrimitive.Label;
const SelectSeparator = SelectPrimitive.Separator;

function SelectTrigger({
  className,
  variant,
  size,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> &
  VariantProps<typeof selectTriggerVariants>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(selectTriggerVariants({ variant, size }), className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="opacity-60" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        className={cn(
          "fade-in-0 zoom-in-95 data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 relative z-50 max-h-(--radix-select-content-available-height) min-w-[8rem] origin-(--radix-select-content-transform-origin) overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-in data-[state=closed]:animate-out",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport
          className={cn(
            position === "popper" &&
              "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]",
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex w-full cursor-default select-none items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
}

export type PickerChoice = {
  value: string;
  label: React.ReactNode;
  /** Shown in the closed trigger instead of `label` when the option is selected. */
  triggerLabel?: React.ReactNode;
  disabled?: boolean;
};

/** Convenience wrapper: a complete controlled select from an options list. */
function Select({
  value,
  onValueChange,
  options,
  placeholder,
  className,
  disabled,
  variant,
  size,
  align,
  testId,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: PickerChoice[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  /** Popover alignment relative to the trigger. Defaults to radix's `"start"`
   *  (the popover's LEFT edge meets the trigger's left edge, growing rightward).
   *  Use `"end"` for a right-positioned trigger so the popover's RIGHT edge
   *  meets the trigger's right edge instead of overflowing to the right. */
  align?: "start" | "center" | "end";
  /** When set, the trigger gets `data-testid={testId}` and each item gets
   *  `data-testid={`${testId}-option-${value}`}` so e2e can open the dropdown
   *  and pick an option (radix Select portals the listbox). */
  testId?: string;
} & VariantProps<typeof selectTriggerVariants>) {
  const triggerLabel = options.find((opt) => opt.value === value)?.triggerLabel;
  return (
    <SelectRoot value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger
        variant={variant}
        size={size}
        className={className}
        {...(testId ? { "data-testid": testId } : {})}
      >
        <SelectValue placeholder={placeholder}>{triggerLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent align={align}>
        {options.map((opt) => (
          <SelectItem
            key={opt.value}
            value={opt.value}
            disabled={opt.disabled}
            {...(testId
              ? { "data-testid": `${testId}-option-${opt.value}` }
              : {})}
          >
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}

export {
  Select,
  SelectRoot,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectSeparator,
};
