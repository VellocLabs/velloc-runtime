/**
 * The row shape a settings form draws its fields in: the words on the left
 * (a label, a hint, a note), the control on the right, the rows in one
 * bordered list. Shared by the Plugins page's options form and the Models
 * page's provider form (F-25, F-27).
 */
import * as React from "react";
import { ChevronDownIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { ModsUserConfigField } from "../../../runtimeProtocol";
import { useT } from "../../i18n";

/** A fixed control column: every control of the form starts and ends at
 *  the same edges, a row's extra button inside it. */
const FIXED_SLOT = "w-[21rem] max-w-full justify-end";

/** The list the rows sit in. */
export function OptionRowList({ children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70 bg-muted/20"
    >
      {children}
    </div>
  );
}

/** One row: the control wraps below the words when the card is narrow. */
export function OptionRow({
  id,
  label,
  required,
  mark,
  hint,
  note,
  testId,
  fixedSlot,
  children,
}: {
  /** The control's id, the label's `for`. */
  id: string;
  label: string;
  required?: boolean;
  /** Beside the label: "(secret)", "Saved ✓". */
  mark?: React.ReactNode;
  hint?: React.ReactNode;
  /** Below the hint: a problem with the value. */
  note?: React.ReactNode;
  testId?: string;
  /** The control sits in the form's fixed column (`FIXED_SLOT`). */
  fixedSlot?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div data-testid={testId ?? `${id}-row`} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-3 py-2.5">
      <div className="flex min-w-[12rem] flex-1 flex-col gap-0.5">
        <label htmlFor={id} className="flex items-center gap-1.5 font-medium text-foreground text-xs">
          <span>{label}</span>
          {required ? <span className="text-destructive">*</span> : null}
          {mark}
        </label>
        {hint ? <span className="text-[11px] text-muted-foreground leading-snug">{hint}</span> : null}
        {note}
      </div>
      <div className={cn("flex shrink-0 items-center gap-2", fixedSlot && FIXED_SLOT)}>{children}</div>
    </div>
  );
}

/** The control of a declared field, by its type: a switch, a picker, a
 *  number, a text; a sensitive text as a password whose stored value is
 *  kept while the field stays blank. */
export function OptionFieldControl({
  id,
  field,
  value,
  kept,
  disabled,
  fill,
  onChange,
}: {
  id: string;
  field: ModsUserConfigField;
  value: string | boolean | undefined;
  /** A sensitive field holds a stored value. */
  kept: boolean;
  disabled?: boolean;
  /** Fill the row's control column rather than size to the value. */
  fill?: boolean;
  onChange: (next: string | boolean) => void;
}) {
  const t = useT();
  if (field.type === "boolean") {
    return <Switch id={id} data-testid={id} checked={value === true} disabled={disabled} onCheckedChange={onChange} />;
  }
  if (field.type === "string" && field.options) {
    // A native picker, drawn as the settings select trigger: as wide as its
    // longest choice, not the row.
    return (
      <div className={cn("relative", fill && "w-full")}>
        <select
          id={id}
          data-testid={id}
          className={cn(
            "h-8 cursor-pointer appearance-none truncate rounded-md border border-input bg-background pr-7 pl-2.5 text-xs outline-none transition-colors hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
            fill ? "w-full" : "min-w-[7rem] max-w-[14rem]",
          )}
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(event) => {
            // Read now: React clears `currentTarget` once the handler
            // returns, before the updater runs.
            const next = event.currentTarget.value;
            onChange(next);
          }}
        >
          {!field.required ? <option value="">{t("settings.plugins.mods.options.unset")}</option> : null}
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <ChevronDownIcon
          className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
      </div>
    );
  }
  return (
    <Input
      id={id}
      data-testid={id}
      type={field.sensitive ? "password" : field.type === "number" ? "number" : "text"}
      {...(field.type === "number" && field.min !== undefined ? { min: field.min } : {})}
      {...(field.type === "number" && field.max !== undefined ? { max: field.max } : {})}
      // A number is a short right-aligned figure; a text gets room for a
      // path or a list.
      className={cn(
        "h-8 text-xs",
        field.type === "number" && "text-right tabular-nums",
        fill ? "w-full" : field.type === "number" ? "w-24" : "w-56",
      )}
      value={typeof value === "string" ? value : ""}
      placeholder={
        kept
          ? t("settings.plugins.mods.options.keptSecret")
          : field.default !== undefined
            ? String(Array.isArray(field.default) ? (field.default as readonly string[]).join(", ") : field.default)
            : undefined
      }
      disabled={disabled}
      autoComplete={field.sensitive ? "off" : undefined}
      onChange={(event) => {
        // Read now: React clears `currentTarget` once the handler returns,
        // before the updater runs.
        const next = event.currentTarget.value;
        onChange(next);
      }}
    />
  );
}
