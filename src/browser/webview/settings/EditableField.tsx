import * as React from "react";
import { ExternalLinkIcon, PencilIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { useUnsavedEditsGate } from "@/glic/unsavedEditsGate";

import { useT } from "../i18n";

/**
 * Read-only-until-Edit text/number/url field with a Clear (reset-to-default) button
 * when `showClear` (defaults to value ≠ resetValue). Edit commits on blur / Enter
 * and cancels on Escape.
 */
export function EditableField({
  value,
  resetValue = "",
  placeholder,
  type = "text",
  min,
  max,
  monospace,
  ariaLabel,
  showClear,
  href,
  actionVariant = "ghost",
  className,
  onCommit,
  onReset,
}: {
  value: string;
  resetValue?: string;
  placeholder?: string;
  type?: "text" | "number" | "url";
  min?: number;
  max?: number;
  monospace?: boolean;
  ariaLabel: string;
  /** Override the default (value ≠ resetValue) visibility of the Clear button. */
  showClear?: boolean;
  /**
   * Render the displayed value as an external link to this URL (with a trailing
   * external-link glyph) instead of plain text. Opt-in: only the About page's
   * runtime-source row wants it, and only because the value there IS a URL the
   * user may want to open. The guest's capture-phase link interceptor
   * (`MultiSessionShell`) turns the click into a real browser tab.
   */
  href?: string;
  /**
   * Chrome for the Edit/Clear buttons. Ghost (the default) is the settings-wide
   * norm; `outline` gives them a visible frame for cards that stand alone.
   */
  actionVariant?: "ghost" | "outline";
  /**
   * Extra classes for the display-state wrapper (e.g. a wider `gap-*` when the
   * field sits in a roomier control row). Merged over the default `gap-1`.
   */
  className?: string;
  onCommit: (next: string) => void;
  /** If provided, the Clear button calls this instead of committing resetValue
   *  (e.g. number fields that clear a sparse override → back to the default). */
  onReset?: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);

  React.useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  // An uncommitted edit lives only in this page — hold the background
  // updater's reload while there is one (glic/unsavedEditsGate.ts).
  useUnsavedEditsGate(editing && draft.trim() !== value);

  const commit = () => {
    setEditing(false);
    let next = draft.trim();
    if (type === "number" && next !== "") {
      let n = Number(next);
      if (!Number.isFinite(n)) {
        next = value;
      } else {
        if (min !== undefined) n = Math.max(min, n);
        if (max !== undefined) n = Math.min(max, n);
        next = String(n);
      }
    }
    if (next !== value) onCommit(next);
  };

  if (editing) {
    return (
      <Input
        autoFocus
        type={type === "url" ? "url" : type}
        inputMode={type === "number" ? "numeric" : undefined}
        min={min}
        max={max}
        className={cn(
          "h-8",
          type === "number" ? "w-24" : "w-64",
          monospace && "font-mono",
        )}
        value={draft}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
      />
    );
  }

  const clearVisible = showClear ?? value !== resetValue;
  const valueClass = cn(
    "truncate text-sm",
    value ? "text-foreground" : "text-muted-foreground",
    monospace && "font-mono",
    type !== "number" && "max-w-64",
  );
  return (
    <div className={cn("flex items-center gap-1", className)}>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          title={href}
          className={cn(valueClass, "flex items-center gap-1 hover:underline")}
        >
          <span className="truncate">{value || placeholder || "—"}</span>
          <ExternalLinkIcon className="size-3 shrink-0" />
        </a>
      ) : (
        <span className={valueClass}>{value || placeholder || "—"}</span>
      )}
      <Button
        variant={actionVariant}
        size="icon-sm"
        aria-label={t("settings.editField", { label: ariaLabel })}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
      >
        <PencilIcon className="size-3.5" />
      </Button>
      {clearVisible ? (
        <Button
          variant={actionVariant}
          size="icon-sm"
          aria-label={t("settings.resetToDefault")}
          title={t("settings.resetToDefault")}
          onClick={() => (onReset ? onReset() : onCommit(resetValue))}
        >
          <XIcon className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
