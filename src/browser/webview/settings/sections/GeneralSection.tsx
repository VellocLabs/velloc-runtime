import * as React from "react";
import { PowerIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AppearanceSection } from "./AppearanceSection";
import { SystemSection } from "./SystemSection";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useUnsavedEditsGate } from "@/glic/unsavedEditsGate";
import { cn } from "@/lib/utils";

import type { BrowserBridgeTransport } from "../../../bridge/browserBridgeProtocol";
import type { AppearanceSnapshot } from "../../../bridge/protocol/appearance";
import {
  resolveLocale,
  useLocale,
  useT,
  type TranslateFn,
} from "../../i18n";
import {
  getAppearance,
  relaunchApp,
  setUiLocale,
} from "../../nexusBridgeActions";
import { useSettingsBridge } from "../../nexusSettingsBridge";
import { useCapabilities } from "../../useCan";
import { UI_LOCALE_OPTIONS, matchUiLocale } from "../appearanceOptions";
import { profileSnapshot, profileSetField } from "../clients";
import type { ProfileFieldPatch } from "../clients";
import { SETTINGS_SELECT_WIDTH,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSubpageLayout,
} from "../SettingsSubpageLayout";

/**
 * General — Profile, Appearance, then System (background toggle, then language),
 * last because a language change waits for a restart. Profile persists via the
 * worker `profile` bridge; Appearance and System are C++ prefs via `transport`
 * (`setUiLocale` switches browser chrome and app on the next launch).
 * Contract: every System control is `full` and renders only when `useCapabilities()`
 * allows it; a read that could only be refused is never issued.
 */

type ProfileValues = {
  fullName: string;
  callName: string;
  workRole: string;
};

type GeneralProfilePatch = Pick<
  ProfileFieldPatch,
  "fullName" | "callName" | "workRole"
>;

// "Role" — a fixed role list (no empty option;
// radix Select forbids a value="" item, so the unset state shows the
// placeholder instead). Labels are resolved through the catalog at render.
const WORK_ROLE_OPTIONS: Array<{
  value: string;
  labelKey: Parameters<TranslateFn>[0];
}> = [
  { value: "engineering", labelKey: "settings.general.role.engineering" },
  { value: "product", labelKey: "settings.general.role.product" },
  { value: "design", labelKey: "settings.general.role.design" },
  { value: "data-science", labelKey: "settings.general.role.dataScience" },
  { value: "research", labelKey: "settings.general.role.research" },
  { value: "marketing", labelKey: "settings.general.role.marketing" },
  { value: "sales", labelKey: "settings.general.role.sales" },
  { value: "operations", labelKey: "settings.general.role.operations" },
  { value: "education", labelKey: "settings.general.role.education" },
  { value: "legal", labelKey: "settings.general.role.legal" },
  { value: "finance", labelKey: "settings.general.role.finance" },
  { value: "other", labelKey: "settings.general.role.other" },
];

/** A vertically-stacked labelled field (label above a full-width control)
 *  — the General page is a form, unlike the side-by-side `SettingsRow`. */
function Field({
  label,
  htmlFor,
  description,
  children,
}: {
  label: string;
  htmlFor?: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="font-medium text-foreground text-sm">
        {label}
      </label>
      {description ? (
        <p className="-mt-0.5 text-muted-foreground text-xs">{description}</p>
      ) : null}
      {children}
    </div>
  );
}

/** Controlled text input that commits (trimmed) on blur — avoids a bridge
 *  write per keystroke. Resyncs its draft when the saved value changes. */
function TextField({
  id,
  label,
  description,
  value,
  placeholder,
  testId,
  onCommit,
}: {
  id: string;
  label: string;
  description?: string;
  value: string;
  placeholder?: string;
  testId?: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  // Uncommitted typing lives only in this page (glic/unsavedEditsGate.ts).
  useUnsavedEditsGate(draft.trim() !== value);
  return (
    <Field label={label} htmlFor={id} description={description}>
      <Input
        id={id}
        className="h-9"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          const next = e.currentTarget.value.trim();
          if (next !== value) onCommit(next);
        }}
        {...(testId ? { "data-testid": testId } : {})}
      />
    </Field>
  );
}

export function GeneralSection({
  transport,
}: {
  transport: BrowserBridgeTransport;
}) {
  const t = useT();
  const bridge = useSettingsBridge();
  const capabilities = useCapabilities();
  const [values, setValues] = React.useState<ProfileValues | null>(null);
  const roleOptions = React.useMemo(
    () =>
      WORK_ROLE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) })),
    [t],
  );

  // Language lives on the host `appearance` bridge, not the settings bridge —
  // it is a browser pref, not a settings.json field. The pref is the
  // PROSPECTIVE locale; `activeLocale` is the catalog this app actually booted
  // with. A restart is pending exactly when they disagree — derived, not
  // remembered, so the notice survives leaving the page and coming back (a
  // remembered flag would lose it) and clears itself when the value is put
  // back, the same self-correcting shape the About page's notice has.
  const activeLocale = useLocale();
  // The language row needs BOTH halves of the host pref: without the read it
  // has no value to show, and without the write it is a control that errors.
  // A connection missing either gets no row — not the "older binary" note
  // below, which would tell a remote user their Velloc is out of date.
  const canUseLanguage =
    capabilities.can("appearance", "getAppearance") &&
    capabilities.can("appearance", "setUiLocale");
  const canRelaunch = capabilities.can("appInfo", "relaunch");
  // One mount-time read seeds BOTH appearance-derived groups on this page:
  // the Appearance section takes the whole snapshot as a prop, the Language
  // row below reads its `locale`. Two separate reads would double the bridge
  // round-trips and could disagree. `undefined` is the pending state — the
  // read has not resolved yet; `null` is the rejected one (an older binary
  // without the `appearance` capability).
  const [appearance, setAppearance] = React.useState<
    AppearanceSnapshot | null | undefined
  >(undefined);
  const [restarting, setRestarting] = React.useState(false);
  const [restartFailed, setRestartFailed] = React.useState(false);

  React.useEffect(() => {
    // Not issued at all when the connection may not make it: the answer could
    // only be `forbidden_scope`.
    if (!canUseLanguage) return;
    let cancelled = false;
    void (async () => {
      try {
        const snap = await getAppearance(transport);
        if (cancelled) return;
        setAppearance(snap);
      } catch {
        // Older binary without the `appearance` capability: offer no control
        // whose writes the same missing route would also reject.
        if (!cancelled) setAppearance(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [transport, canUseLanguage]);

  // Derived, not stored: the prospective locale the host pref now holds.
  // Null while the read is pending OR rejected — the Select shows its
  // loading placeholder and stays disabled either way. An EMPTY pref (a fresh
  // profile: Chromium writes `intl.app_locale` only once the user picks one)
  // means "the OS UI language" — the same locale this app's catalog booted
  // from — not English: mapping it to `en` showed English and a permanent
  // restart notice to every non-English user who never touched the row.
  const locale = appearance
    ? matchUiLocale(appearance.locale || activeLocale)
    : null;
  const setLocalePref = React.useCallback((next: string) => {
    setAppearance((prev) => (prev ? { ...prev, locale: next } : prev));
  }, []);

  const localeOptions = React.useMemo(
    () => UI_LOCALE_OPTIONS.map((o) => ({ value: o.tag, label: o.endonym })),
    [],
  );

  const chooseLocale = React.useCallback(
    (next: string) => {
      const previous = locale;
      setLocalePref(next);
      setRestartFailed(false);
      void setUiLocale(transport, next).catch(() => {
        if (previous !== null) setLocalePref(previous);
      });
    },
    [locale, setLocalePref, transport],
  );

  const restart = React.useCallback(() => {
    setRestarting(true);
    setRestartFailed(false);
    // On success nothing comes back — the host is gone. A rejection therefore
    // only ever means the route did not run, so explain it and re-enable.
    void relaunchApp(transport).catch(() => {
      setRestarting(false);
      setRestartFailed(true);
    });
  }, [transport]);

  // Compared through `resolveLocale` because the pref speaks Chrome's codes
  // (`zh-CN`) and the catalog speaks its own (`zh`) — a raw string compare
  // would show a permanent restart notice for every Chinese user.
  const restartPending =
    locale !== null && resolveLocale(locale) !== activeLocale;

  React.useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void (async () => {
      try {
        const snap = await profileSnapshot(bridge);
        if (!cancelled) setValues(snap.values);
      } catch {
        // Leave `values` null → the loading text stays; the bridge is the
        // only persistence path, so there's nothing to fall back to.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const commit = React.useCallback(
    async (patch: GeneralProfilePatch) => {
      if (!bridge) return;
      // Optimistic local update (null → '' so controlled inputs stay bound).
      setValues((prev) => {
        if (!prev) return prev;
        const next = { ...prev };
        for (const [k, v] of Object.entries(patch)) {
          (next as Record<string, unknown>)[k] = v ?? "";
        }
        return next;
      });
      try {
        const result = await profileSetField(bridge, patch);
        setValues(result.values);
      } catch {
        // Re-read the authoritative disk state on a failed write.
        const snap = await profileSnapshot(bridge).catch(() => null);
        if (snap) setValues(snap.values);
      }
    },
    [bridge],
  );

  if (!bridge) {
    return (
      <SettingsSubpageLayout title={t("settings.general.title")}>
        <p className="text-muted-foreground text-sm">
          {t("settings.bridgeUnavailable")}
        </p>
      </SettingsSubpageLayout>
    );
  }

  if (!values) {
    return (
      <SettingsSubpageLayout title={t("settings.general.title")}>
        <p className="text-muted-foreground text-sm">{t("settings.loading")}</p>
      </SettingsSubpageLayout>
    );
  }

  return (
    <SettingsSubpageLayout title={t("settings.general.title")}>
      <div data-testid="settings-general" className="flex flex-col gap-4">
        <SettingsSection title={t("settings.general.profile")}>
          {/* The profile fields sit in a card like every other settings group.
              Bare on the page they read as a different design system from the
              cards in the Appearance and System groups below them. */}
          <SettingsCard className="flex flex-col gap-3 p-4">
            <TextField
              id="profile-full-name"
              label={t("settings.general.fullName")}
              value={values.fullName}
              placeholder={t("settings.general.fullNamePlaceholder")}
              testId="profile-full-name"
              onCommit={(next) => void commit({ fullName: next || null })}
            />

            <TextField
              id="profile-call-name"
              label={t("settings.general.callName")}
              description={t("settings.general.callNameDescription")}
              value={values.callName}
              placeholder={t("settings.general.callNamePlaceholder")}
              testId="profile-call-name"
              onCommit={(next) => void commit({ callName: next || null })}
            />

            <Field
              label={t("settings.general.workRole")}
              htmlFor="profile-work-role"
            >
              <Select
                value={values.workRole}
                placeholder={t("settings.general.rolePlaceholder")}
                options={roleOptions}
                onValueChange={(next) => void commit({ workRole: next })}
                className="w-full"
                testId="profile-work-role"
              />
            </Field>
          </SettingsCard>
        </SettingsSection>

        {/* Appearance reads/writes this client's own localStorage now — no
            transport, no mount-time snapshot, no host capability to gate on.
            It renders unconditionally. */}
        <AppearanceSection />

        {/* System comes LAST: its language row needs a restart. The language control
            is handed in even while the read is in flight (select disabled); only a
            rejected read (`null`) swaps in the unavailable note, and a connection
            that may not use it gets none (undefined). */}
        <SystemSection
          transport={transport}
          languageControl={
            !canUseLanguage ? undefined : appearance === null ? (
              <p className="text-muted-foreground text-sm">
                {t("settings.general.languageUnavailable")}
              </p>
            ) : (
              <SettingsCard>
                <SettingsRow
                  bare
                  label={t("settings.general.uiLanguage")}
                  control={
                    <Select
                      value={locale ?? ""}
                      options={localeOptions}
                      placeholder={t("settings.loading")}
                      disabled={locale === null}
                      onValueChange={chooseLocale}
                      className={SETTINGS_SELECT_WIDTH}
                      testId="settings-ui-language"
                    />
                  }
                />
                {restartPending ? (
                  <div
                    data-testid="settings-language-restart-tip"
                    className={cn(
                      "flex items-center gap-3 px-4 py-3 text-sm",
                      restartFailed ? "text-warning" : "text-muted-foreground",
                    )}
                  >
                    {/* A quiet line at the foot of the same card, not a
                        standalone amber banner: needing a restart is a normal
                        consequence of the choice above, and warning colours read
                        as "something has gone wrong". A genuine FAILURE to
                        restart still does. */}
                    <span className="min-w-0 flex-1">
                      {restartFailed
                        ? t("settings.general.languageRestartFailed")
                        : t("settings.general.languageRestartTip")}
                    </span>
                    {/* Relaunching is its own `full` route: a connection
                        that may set the locale but not restart the host keeps
                        the notice and loses only the button. */}
                    {canRelaunch ? (
                      <Button
                        data-testid="settings-language-restart-now"
                        variant="outline"
                        size="sm"
                        disabled={restarting}
                        onClick={restart}
                      >
                        <PowerIcon className="size-3.5" />
                        {restarting
                          ? t("settings.general.languageRestarting")
                          : t("settings.general.languageRestartNow")}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </SettingsCard>
            )
          }
        />
      </div>
    </SettingsSubpageLayout>
  );
}
