import * as React from "react";

import { cn } from "@/lib/utils";

/** Shared width for settings selects so pages don't each pick their own
 *  magic number — Appearance and Language both use this. */
export const SETTINGS_SELECT_WIDTH = "w-56";

/**
 * THE settings type scale — the one place a settings page's headings, helper
 * text and group labels get their font. Pages use
 * the components below; the raw classes are exported only for the odd
 * element that cannot be one of them (a heading that is also a button).
 */
export const settingsText = {
  /** Page title — one per page, rendered by `SettingsSubpageLayout`. */
  pageTitle: "font-semibold text-[22px] text-foreground leading-tight tracking-tight",
  /** Section title — `SettingsSection`'s `<h2>`. */
  sectionTitle: "font-semibold text-[15px] text-foreground leading-snug tracking-tight",
  /** Small caps label for a sub-group inside a section. */
  groupLabel:
    "font-medium text-[11px] text-muted-foreground uppercase leading-none tracking-[0.08em]",
  /** Helper prose under a title, and a row's description. */
  description: "text-[13px] text-muted-foreground leading-relaxed",
  /** A row's label. */
  rowLabel: "font-medium text-foreground text-sm",
} as const;

/**
 * The frame of every settings page: one page header (`<h1>` + optional description)
 * and the body. Section spacing is owned here and by `SettingsSection`; pages must
 * not draw their own `border-t` between groups.
 */
export function SettingsSubpageLayout({
  title,
  description,
  adornment,
  actions,
  children,
  className,
  testId,
}: {
  title?: string;
  description?: React.ReactNode;
  /** Inline after the title, e.g. a status badge. */
  adornment?: React.ReactNode;
  /** Right-aligned header controls, e.g. an "Add" button. */
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Optional stable `data-testid` for the scroll container (e.g. for E2E). */
  testId?: string;
}) {
  return (
    <div className="h-full overflow-y-auto" data-testid={testId}>
      {/* Left-aligned, NOT centered in the remaining space. Centering put the
          content a third of the way across a 2K window, which reads as a web
          form rather than a desktop Settings pane; a fixed gap after the nav
          keeps every width — 1440, 2K, 4K — looking the same. */}
      <div
        className={cn(
          "w-full max-w-[880px] pt-10 pr-6 pb-16 pl-10 lg:pl-12",
          className,
        )}
      >
        {title ? (
          <header
            data-settings-page-header=""
            className="mb-8 border-border/60 border-b pb-5"
          >
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <h1 className={settingsText.pageTitle}>{title}</h1>
                {adornment}
              </div>
              {actions ? (
                <div className="flex shrink-0 items-center gap-2">{actions}</div>
              ) : null}
            </div>
            {description ? (
              <div className={cn("mt-2 max-w-prose", settingsText.description)}>
                {description}
              </div>
            ) : null}
          </header>
        ) : null}
        <div className="flex flex-col gap-4">{children}</div>
      </div>
    </div>
  );
}

/**
 * One headed group inside a settings page — the ONLY way a page names a group.
 * Use `testId` rather than a wrapping `<div data-testid=…>`: a wrapper makes the
 * section a first child and collapses its top margin.
 */
export function SettingsSection({
  title,
  description,
  actions,
  children,
  className,
  testId,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned controls on the title line. */
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  /** Stable `data-testid` for the `<section>` — see the note above on why a
   *  wrapper div is not an option. */
  testId?: string;
}) {
  return (
    <section
      data-settings-section=""
      className={cn("mt-6 first:mt-0", className)}
      {...(testId ? { "data-testid": testId } : {})}
    >
      <header className="mb-3">
        <div className="flex min-h-7 items-center justify-between gap-4">
          <h2 className={settingsText.sectionTitle}>{title}</h2>
          {actions ? (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          ) : null}
        </div>
        {description ? (
          <div className={cn("mt-0.5", settingsText.description)}>
            {description}
          </div>
        ) : null}
      </header>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

/** A small-caps label naming a sub-group inside a `SettingsSection`. */
export function SettingsGroupLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h3 className={cn("mt-2 mb-0.5 first:mt-0", settingsText.groupLabel, className)}>
      {children}
    </h3>
  );
}

/** The one banner style for a page's explanatory note (`info`) or caution
 *  (`warning`). */
export function SettingsNotice({
  children,
  tone = "info",
  className,
  testId,
}: {
  children: React.ReactNode;
  tone?: "info" | "warning";
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border px-3.5 py-2.5 text-[13px] text-foreground/80 leading-relaxed",
        tone === "warning"
          ? "border-warning/30 bg-warning/10"
          : "border-info/30 bg-info/5",
        className,
      )}
      {...(testId ? { "data-testid": testId } : {})}
    >
      {children}
    </div>
  );
}

/**
 * One bordered card holding several `SettingsRow`s separated by dividers; pass
 * `bare` on the rows inside so they do not draw a second border.
 */
export function SettingsCard({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-settings-card=""
      className={cn(
        "divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-card",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * One labelled settings row: title + description left, control right. `stacked`
 * puts the control on the title's line and the description on its own full-width
 * line below — for rows with a long description.
 */
export function SettingsRow({
  label,
  description,
  control,
  children,
  stacked = false,
  bare = false,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  control?: React.ReactNode;
  children?: React.ReactNode;
  stacked?: boolean;
  /** Drop this row's own border — it lives inside a `SettingsCard`, which
   *  draws one border for the whole group and dividers between rows. */
  bare?: boolean;
}) {
  const box = bare
    ? "px-4 py-3.5"
    : "rounded-xl border border-border/70 bg-card px-4 py-3.5";
  if (stacked) {
    return (
      <div className={cn("flex flex-col gap-1.5", box)}>
        <div className="flex items-center justify-between gap-4">
          <div className={cn("flex items-center gap-2", settingsText.rowLabel)}>
            {label}
          </div>
          {control ? <div className="shrink-0">{control}</div> : null}
        </div>
        {description ? (
          <div className={cn("whitespace-pre-line", settingsText.description)}>
            {description}
          </div>
        ) : null}
        {children}
      </div>
    );
  }
  return (
    // items-center: the control (Select/Switch) is usually taller than the
    // label column, so items-start pinned it to the row's top edge.
    <div className={cn("flex items-center justify-between gap-4", box)}>
      <div className="min-w-0 flex-1">
        <div className={cn("flex items-center gap-2", settingsText.rowLabel)}>
          {label}
        </div>
        {description ? (
          <div className={cn("mt-0.5", settingsText.description)}>
            {description}
          </div>
        ) : null}
        {children}
      </div>
      {control ? <div className="shrink-0">{control}</div> : null}
    </div>
  );
}
