import * as React from "react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { CircleIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * RadioGroup — radix-ui RadioGroup in the repo's `components/ui` convention,
 * modeled on the assistant-ui registry `radio-group`. Composable primitives
 * plus a convenience `<RadioOption>` (item + label in one clickable row).
 * First consumer: the Settings → Session models mode rows.
 */

function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn("grid gap-2", className)}
      {...props}
    />
  );
}

function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        "aspect-square size-4 shrink-0 rounded-full border border-input text-primary shadow-xs outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary",
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="relative flex items-center justify-center"
      >
        <CircleIcon className="size-2 fill-primary text-primary" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}

/** One labeled radio row — item + text label sharing a click target. */
function RadioOption({
  value,
  label,
  disabled,
  testId,
  className,
}: {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
  testId?: string;
  className?: string;
}) {
  const id = React.useId();
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-center gap-2 text-sm",
        disabled && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      <RadioGroupItem
        id={id}
        value={value}
        disabled={disabled}
        {...(testId ? { "data-testid": testId } : {})}
      />
      <span>{label}</span>
    </label>
  );
}

export { RadioGroup, RadioGroupItem, RadioOption };
