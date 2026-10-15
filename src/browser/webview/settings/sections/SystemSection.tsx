import * as React from "react";

import { Switch } from "@/components/ui/switch";

import type { BrowserBridgeTransport } from "../../../bridge/browserBridgeProtocol";
import { useT } from "../../i18n";
import { useCapabilities } from "../../useCan";
import {
  getSystemPrefs,
  setBackgroundModeEnabled,
  setLauncherEnabled,
} from "../../nexusBridgeActions";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "../SettingsSubpageLayout";

/**
 * System — the General page's system group: the background toggle, then the
 * `languageControl` General hands in. The toggle is the C++ pref
 * `prefs::kBackgroundModeEnabled` via the `systemPrefs` capability; the UI writes
 * both `setBackgroundMode` and the `setLauncher` alias and shows on only when both
 * report on. Security: all three are `full`; without them there is no toggle and no
 * read, and with no language control either the group renders NOTHING.
 */
export function SystemSection({
  transport,
  languageControl,
}: {
  transport: BrowserBridgeTransport;
  /** The merged Language group's control — General's display-language card
   *  (select + restart line). Rendered as the group's SECOND setting, below
   *  the background card. General passes it even while its mount-time
   *  appearance read is pending (the card holds its place, disabled), so it
   *  is omitted only when there is no language half to show: a caller without
   *  one, or a connection that may not use it. */
  languageControl?: React.ReactNode;
}) {
  const t = useT();
  const capabilities = useCapabilities();
  const canToggle =
    capabilities.can("systemPrefs", "get") &&
    capabilities.can("systemPrefs", "setBackgroundMode") &&
    capabilities.can("systemPrefs", "setLauncher");
  const [backgroundMode, setBackgroundMode] = React.useState<boolean | null>(
    null,
  );
  const [unavailable, setUnavailable] = React.useState(false);

  React.useEffect(() => {
    // Not issued when the connection may not make it — it could only be
    // refused, and the refusal would read as "unavailable on this build".
    if (!canToggle) return;
    let cancelled = false;
    void (async () => {
      try {
        const prefs = await getSystemPrefs(transport);
        if (cancelled) return;
        setBackgroundMode(
          prefs.backgroundModeEnabled && prefs.launcherEnabled,
        );
      } catch {
        if (!cancelled) setUnavailable(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [transport, canToggle]);

  // Nothing here this connection may use: no group, not an empty heading.
  if (!canToggle && !languageControl) return null;

  return (
    <SettingsSection title={t("settings.system.title")} testId="settings-system">
      {!canToggle ? null : unavailable ? (
        <p className="text-muted-foreground text-sm">
          {t("settings.system.unavailable")}
        </p>
      ) : (
        // One card — the same shape Appearance uses, so the General page
        // reads as a stack of headed card-groups, not a mix.
        <SettingsCard>
          <SettingsRow
            bare
            label={t("settings.system.keepRunning")}
            description={t("settings.system.keepRunningDescription")}
            control={
              <Switch
                checked={backgroundMode ?? false}
                disabled={backgroundMode === null}
                onCheckedChange={(next) => {
                  setBackgroundMode(next);
                  void (async () => {
                    // Both writes settle before anything is decided: one can
                    // land while the other is refused, so neither "both
                    // failed" nor "both landed" may be assumed.
                    const results = await Promise.allSettled([
                      setBackgroundModeEnabled(transport, next),
                      setLauncherEnabled(transport, next),
                    ]);
                    try {
                      // Re-read: the host is the answer — a partial write, or
                      // a policy-managed host that keeps its own value.
                      const prefs = await getSystemPrefs(transport);
                      setBackgroundMode(
                        prefs.backgroundModeEnabled && prefs.launcherEnabled,
                      );
                    } catch {
                      // No re-read either: infer the shown value (the AND of
                      // the two prefs) from which writes landed. Turning ON
                      // needs both; turning OFF needs either.
                      const landed = results.map((r) => r.status === "fulfilled");
                      setBackgroundMode(
                        next ? landed.every(Boolean) : !landed.some(Boolean),
                      );
                    }
                  })();
                }}
                aria-label={t("settings.system.keepRunning")}
                data-testid="system-background-mode"
              />
            }
          />
        </SettingsCard>
      )}
      {languageControl}
    </SettingsSection>
  );
}
