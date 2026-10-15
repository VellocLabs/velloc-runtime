import * as React from "react";
import { CheckIcon } from "lucide-react";

import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import type {
  BrowserColorScheme,
} from "../../../bridge/protocol/appearance";
import {
  readGuestAccent,
  readGuestPalette,
  writeGuestAccent,
  writeGuestPalette,
} from "../../../boot/guestPalette";
import {
  readGuestColorScheme,
  writeGuestColorScheme,
} from "../../../boot/guestColorScheme";
import {
  GUEST_TEXT_SIZES,
  parseGuestTextSize,
  readGuestTextSize,
  writeGuestTextSize,
  type GuestTextSize,
} from "../../../boot/guestTextSize";
import { useT, type TranslateFn } from "../../i18n";
import { useShowReasoning, writeShowReasoning } from "../../showReasoning";
import {
  SWATCH_CHECK_ON_PREVIEW,
  SWATCH_CHECK_ON_SEED,
  THEME_SWATCHES,
  matchThemeSwatch,
  type ThemeSwatch,
} from "../appearanceOptions";
import { SETTINGS_SELECT_WIDTH,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "../SettingsSubpageLayout";

/**
 * Appearance — colour mode, accent colour, text size and reasoning display. PER
 * CLIENT: every control writes this client's OWN localStorage only (no bridge
 * write, no host pref). A Chrome-colour palette is resolved through
 * `appearance.resolveTheme` (boot/perClientTheme.ts).
 */

// The three mode positions, in Chrome's own order. Labels resolve through
// the catalog at render, like the work-role list on the General page.
const SCHEME_OPTIONS: ReadonlyArray<{
  value: BrowserColorScheme;
  labelKey: Parameters<TranslateFn>[0];
}> = [
  { value: "system", labelKey: "settings.appearance.modeSystem" },
  { value: "light", labelKey: "settings.appearance.modeLight" },
  { value: "dark", labelKey: "settings.appearance.modeDark" },
];

// The five type-scale steps (boot/guestTextSize.ts), smallest first.
const TEXT_SIZE_LABEL_KEYS: Record<GuestTextSize, Parameters<TranslateFn>[0]> = {
  1: "settings.appearance.textSize1",
  2: "settings.appearance.textSize2",
  3: "settings.appearance.textSize3",
  4: "settings.appearance.textSize4",
  5: "settings.appearance.textSize5",
};

/** The Text size row — its own component for symmetry with the other two. */
function TextSizeRow() {
  const t = useT();
  const [textSize, setTextSize] = React.useState<GuestTextSize>(() =>
    readGuestTextSize(),
  );
  const options = React.useMemo(
    () =>
      GUEST_TEXT_SIZES.map((s) => ({
        value: String(s),
        label: t(TEXT_SIZE_LABEL_KEYS[s]),
      })),
    [t],
  );
  const choose = React.useCallback((next: string) => {
    const size = parseGuestTextSize(next);
    if (size === null) return;
    setTextSize(size);
    writeGuestTextSize(size);
  }, []);
  return (
    <SettingsRow
      bare
      label={t("settings.appearance.textSize")}
      description={t("settings.appearance.textSizeDescription")}
      control={
        <Select
          value={String(textSize)}
          options={options}
          onValueChange={choose}
          className={SETTINGS_SELECT_WIDTH}
          testId="appearance-text-size"
        />
      }
    />
  );
}

/** The Show reasoning row — whether the conversation renders the model's
 *  reasoning (showReasoning.ts). A view preference only: the model thinks,
 *  and is billed, the same either way. */
function ShowReasoningRow() {
  const t = useT();
  const show = useShowReasoning();
  return (
    <SettingsRow
      bare
      label={t("settings.appearance.showReasoning")}
      description={t("settings.appearance.showReasoningDescription")}
      control={
        <Switch
          data-testid="appearance-show-reasoning"
          checked={show}
          onCheckedChange={(next) => writeShowReasoning(next)}
          aria-label={t("settings.appearance.showReasoning")}
        />
      }
    />
  );
}

/** One colour swatch. The seed is painted directly — it is the colour the user
 *  is choosing, not a theme token, so it must not follow the theme. */
function Swatch({
  swatch,
  selected,
  label,
  onSelect,
}: {
  swatch: ThemeSwatch;
  selected: boolean;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={label}
      data-testid={`appearance-swatch-${swatch.id}`}
      data-selected={selected ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        "relative flex size-9 items-center justify-center overflow-hidden rounded-full border transition-shadow",
        "outline-none hover:opacity-90",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        swatch.seed ? "" : "border-border",
        selected
          ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
          : "",
      )}
      style={
        swatch.seed
          ? { backgroundColor: swatch.seed, borderColor: swatch.seed }
          : { backgroundColor: swatch.preview }
      }
    >
      {selected ? (
        <CheckIcon
          className="size-4"
          style={{ color: swatch.seed ? SWATCH_CHECK_ON_SEED : SWATCH_CHECK_ON_PREVIEW }}
          aria-hidden="true"
        />
      ) : null}
    </button>
  );
}

export function AppearanceSection() {
  const t = useT();
  // Read locally at render — there is no bridge round-trip to wait for.
  const [scheme, setScheme] = React.useState<BrowserColorScheme>(() =>
    readGuestColorScheme(),
  );
  const [swatchId, setSwatchId] = React.useState<string | null>(() => {
    const palette = readGuestPalette();
    const accent = readGuestAccent();
    return matchThemeSwatch(accent.seed, palette);
  });

  const schemeOptions = React.useMemo(
    () => SCHEME_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) })),
    [t],
  );

  const chooseScheme = React.useCallback((next: string) => {
    const value = next as BrowserColorScheme;
    setScheme(value);
    writeGuestColorScheme(value);
  }, []);

  const chooseSwatch = React.useCallback((swatch: ThemeSwatch) => {
    setSwatchId(swatch.id);
    writeGuestPalette(swatch.palette);
    writeGuestAccent(
      swatch.seed !== undefined || swatch.variant !== undefined
        ? {
            ...(swatch.seed !== undefined ? { seed: swatch.seed } : {}),
            ...(swatch.variant !== undefined ? { variant: swatch.variant } : {}),
          }
        : {},
    );
  }, []);

  return (
    <SettingsSection
      title={t("settings.appearance.title")}
      testId="settings-appearance"
    >
      <SettingsCard>
        <SettingsRow
          bare
          label={t("settings.appearance.mode")}
          description={t("settings.appearance.modeDescription")}
          control={
            <Select
              value={scheme}
              options={schemeOptions}
              onValueChange={chooseScheme}
              className={SETTINGS_SELECT_WIDTH}
              testId="appearance-mode"
            />
          }
        />

        <SettingsRow
          bare
          label={t("settings.appearance.color")}
          description={t("settings.appearance.colorDescription")}
          control={
            <div
              role="radiogroup"
              aria-label={t("settings.appearance.color")}
              data-testid="appearance-swatches"
              className="flex flex-wrap justify-end gap-2"
            >
              {THEME_SWATCHES.map((swatch) => (
                <Swatch
                  key={swatch.id}
                  swatch={swatch}
                  selected={swatch.id === swatchId}
                  label={t(swatch.labelKey)}
                  onSelect={() => chooseSwatch(swatch)}
                />
              ))}
            </div>
          }
        />

        <TextSizeRow />

        <ShowReasoningRow />
      </SettingsCard>
    </SettingsSection>
  );
}
