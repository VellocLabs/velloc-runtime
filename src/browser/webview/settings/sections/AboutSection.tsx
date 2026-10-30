import * as React from "react";
import {
  BoxIcon,
  CircleCheckIcon,
  ExternalLinkIcon,
  GlobeIcon,
  MonitorIcon,
  PowerIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { getBuildTime, formatBuildTime } from "@/branding/buildInfo";
import { THIRD_PARTY_NOTICES_FILE } from "@/branding/thirdPartyNotices";
import {
  channelForUrl,
  channelServesThisVersion,
  prefValueForChannel,
  RECOMMENDED_CHANNEL,
  UPDATE_CHANNELS,
  type UpdateChannel,
} from "@/branding/updateChannels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

import type { BrowserBridgeTransport } from "../../../bridge/browserBridgeProtocol";
import { NEXUS_INTERFACE_VERSION } from "../../../bridge/browserBridgeProtocol";
import { useLocale, useT } from "../../i18n";
import { useCapabilities } from "../../useCan";
import {
  getVersionInfo,
  getWebappUrl,
  relaunchApp,
  setWebappUrl as setWebappUrlBridge,
} from "../../nexusBridgeActions";
import { EditableField } from "../EditableField";
import { SettingsSubpageLayout } from "../SettingsSubpageLayout";

const WEBAPP_URL_PLACEHOLDER = "https://your-openclaw-app.example.com";

/** Per-channel copy. Literal keys, so `t()` still type-checks them. */
const CHANNEL_TEXT = {
  stable: {
    label: "settings.about.channelStable",
    description: "settings.about.channelStableDesc",
  },
  beta: {
    label: "settings.about.channelBeta",
    description: "settings.about.channelBetaDesc",
  },
} as const;

/**
 * What we know about a channel's ability to serve THIS binary's `/v<N>/`.
 * `unknown` is the pre-probe state; `checking` drives the spinner; the other
 * two drive the Active / Not-available chips. The channel the panel is running
 * on is `available` by construction — it is serving this page.
 */
type ChannelAvailability = "unknown" | "checking" | "available" | "unavailable";

function isValidWebappUrl(url: string): boolean {
  if (url.trim() === "") return true; // blank = bundled default
  try {
    const u = new URL(url.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The guest's own current URL (origin + path) — the EFFECTIVE default when no
 * override is set (the agent loaded from it). Used as a fallback hint until the
 * native `appInfo.getWebappUrl` route returns the authoritative `defaultUrl`.
 */
function guestCurrentUrl(): string {
  try {
    const u = new URL(window.location.href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.origin + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return "";
  }
}

/**
 * Force-reload the guest to the newest deployed bundle now: a one-shot query param
 * makes the browser and edge caches miss `index.html` (a plain reload adopts it only
 * on the next boot). `replace` adds no history entry; `guestCurrentUrl` strips the query.
 */
function forceReloadNewest(): void {
  try {
    const u = new URL(window.location.href);
    u.searchParams.set("_r", Date.now().toString());
    window.location.replace(u.toString());
  } catch {
    window.location.reload();
  }
}

/**
 * One row of the channel picker: a whole clickable card (radio, name, description,
 * state chip), using `RadioOption`'s `useId` + `htmlFor` pattern.
 */
function ChannelOption({
  value,
  label,
  description,
  tag,
  status,
  availability,
  selected,
  disabled,
  testId,
}: {
  value: string;
  label: string;
  description: string;
  /** "Recommended"-style tag beside the name. */
  tag?: React.ReactNode;
  /** Right-hand state chip: Active / Not available / nothing. */
  status?: React.ReactNode;
  /** Mirrored onto `data-availability` — the probe state, observable to tests
   *  and e2e without reading colors out of a badge. */
  availability: ChannelAvailability;
  selected: boolean;
  disabled: boolean;
  testId: string;
}) {
  const id = React.useId();
  return (
    <label
      htmlFor={id}
      data-testid={`${testId}-card`}
      data-availability={availability}
      className={cn(
        "flex items-center gap-3 rounded-xl border border-border/70 bg-card p-4 transition-colors",
        selected
          ? "border-success/50 bg-success/5"
          : "hover:bg-accent/40",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
      )}
    >
      <RadioGroupItem
        id={id}
        value={value}
        disabled={disabled}
        data-testid={testId}
        // The dot tracks the RADIO SELECTION, not the "Active" chip: until a restart
        // they disagree, which is the pending-restart signal.
        className={cn(
          selected &&
            "border-success data-[state=checked]:border-success [&_svg]:fill-success [&_svg]:text-success",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{label}</span>
          {tag}
        </div>
        <p className="mt-1 text-muted-foreground text-sm">{description}</p>
      </div>
      {status ? <div className="shrink-0">{status}</div> : null}
    </label>
  );
}

/**
 * About — the "<product> Runtime" page: Runtime (source URL, applied after a restart
 * via "Restart now"), Update channel (official origins only; an unusable channel is
 * probed on mount and shown disabled with a reason), and Version. The product name
 * comes from the `{product}` token; no string here may hard-code a brand name.
 */
export function AboutSection({
  transport,
}: {
  transport: BrowserBridgeTransport;
}) {
  const t = useT();
  const locale = useLocale();
  // The runtime source is the desktop's own config. Reading it is `manager`
  // (`appInfo.getWebappUrl`); writing it — the URL field and the channel
  // picker — is `full` (`setWebappUrl`), and so is the relaunch that applies
  // it. The version rows are `observe`. A control the connection may not use is
  // not rendered, and a read it may not make is not issued: a refused URL read
  // used to fail the Promise.all it shares with the version, blanking both
  // version rows and saying the build was too old.
  const capabilities = useCapabilities();
  const canReadUrl = capabilities.can("appInfo", "getWebappUrl");
  const canWriteUrl = capabilities.can("appInfo", "setWebappUrl");
  const canRelaunch = capabilities.can("appInfo", "relaunch");
  const [version, setVersion] = React.useState<{
    appVersion: string;
    chromiumVersion: string;
  } | null>(null);
  const [webappUrl, setWebappUrlState] = React.useState<string>("");
  const [savedUrl, setSavedUrl] = React.useState<string>("");
  // The built-in default guest URL (from the appInfo route) — shown as the
  // Agent URL field's hint/placeholder when no override is set.
  const [defaultUrl, setDefaultUrl] = React.useState<string>("");
  const [unavailable, setUnavailable] = React.useState(false);
  // The URL as it was when this page mounted, i.e. what the running guest was
  // actually loaded from. The restart tip keys off a difference from THIS, not
  // off the field being dirty — see `showRestartTip`.
  const [initialUrl, setInitialUrl] = React.useState<string>("");
  // Which card owns the pending-restart notice. A channel switch and a
  // hand-edited URL both write the same pref, so `showRestartTip` alone cannot
  // say where the change came from — and a notice rendered on the Runtime card
  // after a click in the channel card reads as belonging to something the user
  // did not touch. Whichever control wrote the pref last claims the notice.
  const [restartTipFromChannel, setRestartTipFromChannel] =
    React.useState(false);
  // The restart the pending-change notice offers. `restarting` latches on a
  // successful call and is never cleared — the host tears this page down
  // moments later, so re-enabling the button would only ever offer a second
  // restart during the teardown window.
  const [restarting, setRestarting] = React.useState(false);
  const [restartFailed, setRestartFailed] = React.useState(false);
  const [channelBusy, setChannelBusy] = React.useState(false);
  const [channelError, setChannelError] = React.useState<string | null>(null);
  const [availability, setAvailability] = React.useState<
    Record<UpdateChannel, ChannelAvailability>
  >({ stable: "unknown", beta: "unknown" });

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!canReadUrl) {
          // Only the version: the URL read could only come back refused.
          const v = await getVersionInfo(transport);
          if (!cancelled) setVersion(v);
          return;
        }
        const [v, u] = await Promise.all([
          getVersionInfo(transport),
          getWebappUrl(transport),
        ]);
        if (cancelled) return;
        setVersion(v);
        setWebappUrlState(u.url);
        setSavedUrl(u.url);
        setInitialUrl(u.url);
        setDefaultUrl(u.defaultUrl ?? "");
      } catch {
        if (!cancelled) setUnavailable(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [transport, canReadUrl]);

  const commitUrl = (next: string) => {
    const url = next.trim();
    setWebappUrlState(url);
    if (!isValidWebappUrl(url)) return; // keep dirty; show no restart tip
    void setWebappUrlBridge(transport, url)
      .then(() => {
        // A hand-edited URL belongs to the Runtime card, so the tip moves back
        // there even if a channel switch put it in the channel card first.
        setRestartTipFromChannel(false);
        setSavedUrl(url);
      })
      .catch(() => {
        /* keep the edited value; surfaced as still-dirty */
      });
  };

  // Which official channel the guest is CURRENTLY on: the override if set,
  // otherwise the host's built-in default. `null` for a self-hosted mirror or
  // the localhost dev server a Debug build defaults to — the card hides rather
  // than mislabel a URL somebody set by hand.
  const effectiveUrl = savedUrl.trim() || defaultUrl;
  const channel = channelForUrl(effectiveUrl);
  // The channel the guest actually BOOTED from — resolved from `initialUrl`
  // the same way `effectiveUrl` resolves `savedUrl` above (an empty override
  // falls back to the built-in default), just anchored to the mount-time
  // value instead of the live one. `channel` flips to a new pick the instant
  // `switchChannel`/`commitUrl` writes the pref, before any restart has
  // happened; `activeChannel` only moves once the page remounts on the new
  // source. "Connected"/"Active" indicators must track this one, not the
  // selection — see `connected` and the channel card's status badge below.
  const initialEffectiveUrl = initialUrl.trim() || defaultUrl;
  const activeChannel = channelForUrl(initialEffectiveUrl);

  /**
   * HEAD every channel except `current` for this binary's `/v<N>/`. The current
   * one needs no probe: the panel is running off it, so it demonstrably serves
   * this version. Fails closed, like the switch-time guard it shares.
   */
  const probeChannels = React.useCallback(
    async (current: UpdateChannel, alive: () => boolean) => {
      const others = UPDATE_CHANNELS.filter(c => c !== current);
      setAvailability(prev => {
        const next = { ...prev, [current]: "available" as ChannelAvailability };
        for (const c of others) next[c] = "checking";
        return next;
      });
      await Promise.all(
        others.map(async c => {
          const ok = await channelServesThisVersion(c, NEXUS_INTERFACE_VERSION);
          if (!alive()) return;
          setAvailability(prev => ({
            ...prev,
            [c]: ok ? "available" : "unavailable",
          }));
        }),
      );
    },
    [],
  );

  React.useEffect(() => {
    if (unavailable || channel === null || !canWriteUrl) return;
    let cancelled = false;
    void probeChannels(channel, () => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [channel, unavailable, canWriteUrl, probeChannels]);

  const switchChannel = (next: UpdateChannel) => {
    if (next === channel || channelBusy) return;
    setChannelError(null);
    setChannelBusy(true);
    void (async () => {
      // Probe again before writing the pref even though mount already did: that
      // answer can be minutes old, and being wrong here costs the panel, not a
      // round-trip. See channelServesThisVersion.
      const ok = await channelServesThisVersion(next, NEXUS_INTERFACE_VERSION);
      if (!ok) {
        // Not an error — the channel simply has nothing for this binary. Say so
        // through the same explainer the mount probe drives.
        setAvailability(prev => ({ ...prev, [next]: "unavailable" }));
        setChannelBusy(false);
        return;
      }
      try {
        const value = prefValueForChannel(next);
        await setWebappUrlBridge(transport, value);
        setRestartTipFromChannel(true);
        setSavedUrl(value);
        setWebappUrlState(value);
      } catch {
        setChannelError(t("settings.about.channelSwitchFailed"));
      } finally {
        setChannelBusy(false);
      }
    })();
  };

  const restart = () => {
    if (restarting) return;
    setRestartFailed(false);
    setRestarting(true);
    void relaunchApp(transport).catch(() => {
      // On success nothing lands here — the host restarts and this page goes
      // with it. A rejection therefore means the route did not run at all,
      // which on a binary older than the route is `NOT_IMPLEMENTED`. Hand the
      // user the manual way out rather than leaving a button that did nothing.
      setRestarting(false);
      setRestartFailed(true);
    });
  };

  const year = new Date().getFullYear();
  // Shown once a change has been SAVED and is waiting on a restart — not while
  // the field is merely dirty. Comparing against the mount-time value (rather
  // than a one-shot flag) makes it self-correcting: edit away and back, and the
  // tip goes, because there is genuinely nothing left to apply. The old
  // `dirty && valid` form could only ever flash, since a successful commit
  // updates `savedUrl` and clears `dirty` in the same breath.
  const showRestartTip = savedUrl.trim() !== initialUrl.trim();
  // The notice renders exactly once, at the bottom of the card whose control
  // caused it. The channel card only exists for the official origins, so a
  // stale `restartTipFromChannel` (channel card gone) falls back to Runtime
  // rather than swallowing the notice.
  const channelCardVisible = !unavailable && channel !== null && canWriteUrl;
  const restartTipInChannelCard =
    showRestartTip && restartTipFromChannel && channelCardVisible;
  const restartTipInRuntimeCard = showRestartTip && !restartTipInChannelCard;
  // The notice carries the restart itself, not just the instruction to perform
  // one. Chrome's own settings pages do this (the Relaunch button beside
  // "changes take effect after a restart"), and without it the only way to
  // apply a channel switch from inside the panel was to quit the client by
  // hand — the one action the panel is least able to explain.
  const restartTip = (
    <div
      data-testid="about-restart-tip"
      className="flex items-center gap-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-warning text-xs"
    >
      <span className="min-w-0 flex-1">
        {restartFailed
          ? t("settings.about.restartFailed")
          : t("settings.about.restartTip")}
      </span>
      {canRelaunch ? (
        <Button
          data-testid="about-restart-now"
          variant="outline"
          size="sm"
          disabled={restarting}
          onClick={restart}
        >
          <PowerIcon className="size-3.5" />
          {restarting
            ? t("settings.about.restarting")
            : t("settings.about.restartNow")}
        </Button>
      ) : null}
    </div>
  );
  const urlInvalid = !isValidWebappUrl(webappUrl);
  // The default agent URL to surface as the field's placeholder/hint: the
  // native `defaultUrl`, falling back to the guest's own URL, then a generic
  // example.
  const placeholderUrl =
    defaultUrl || guestCurrentUrl() || WEBAPP_URL_PLACEHOLDER;
  // This page renders INSIDE the runtime, so the runtime is trivially running
  // — but the SOURCE displayed above (the override, or the built-in default)
  // is only the one actually serving the page while there is nothing saved
  // and unapplied. Right after a channel switch or a hand-edited URL commit,
  // `savedUrl` names a source that has not taken effect yet (it takes a
  // restart — see `showRestartTip`), so it must not read as "Connected"
  // until it genuinely is.
  const connected = !unavailable && version !== null && !showRestartTip;
  // Bundle build time, folded into the card heading ("Runtime (…)").
  // Empty when the build-time define is missing (plain "Runtime" then).
  const buildTimeText = formatBuildTime(getBuildTime(), locale);
  // The one channel (if any) this binary is too old for — what the amber
  // explainer talks about. With two channels only the non-current one can be
  // blocked, so the first hit is the whole story.
  const blocked = UPDATE_CHANNELS.find(c => availability[c] === "unavailable");

  return (
    <SettingsSubpageLayout
      title={t("settings.about.title")}
      adornment={
        <Badge variant="success" data-testid="about-runtime-active">
          {t("settings.about.active")}
        </Badge>
      }
      description={
        <>
          <p>{t("settings.about.tagline")}</p>
          <p className="mt-1">{t("settings.about.taglineRuntime")}</p>
        </>
      }
    >

      {/* ── Card 1 · Runtime — build, source, connection, where it loads from ── */}
      <section className="rounded-xl border border-border/70 bg-card">
        {/* items-center (not items-start): the URL/edit/refresh controls sit
            vertically centered against the two-line card heading. */}
        <div className="flex items-center justify-between gap-4 p-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-info/10 text-info">
              <BoxIcon className="size-5" />
            </div>
            <div className="min-w-0">
              <div className="font-medium text-sm">
                {buildTimeText
                  ? t("settings.about.runtimeCardBuilt", {
                      date: buildTimeText,
                    })
                  : t("settings.about.runtimeCard")}
              </div>
              {unavailable ? (
                <div className="mt-0.5 text-muted-foreground text-xs">
                  {t("settings.about.unavailable")}
                </div>
              ) : (
                <div className="mt-1 flex items-center gap-2 text-xs">
                  {/* Unread, the source is unknown — not "built-in". */}
                  {canReadUrl ? (
                    <Badge variant="info" size="sm">
                      {savedUrl.trim()
                        ? t("settings.about.customSource")
                        : t("settings.about.builtinSource")}
                    </Badge>
                  ) : null}
                  {connected ? (
                    <span className="flex items-center gap-1.5 text-success">
                      <span
                        aria-hidden
                        className="inline-block size-1.5 rounded-full bg-success"
                      />
                      {t("settings.about.connected")}
                    </span>
                  ) : null}
                </div>
              )}
            </div>
          </div>
          <div
            data-testid="about-runtime-controls"
            className="flex items-center gap-3"
          >
            {unavailable || !canWriteUrl ? null : (
              <EditableField
                type="url"
                ariaLabel={t("settings.about.runtimeSource")}
                value={webappUrl}
                placeholder={placeholderUrl}
                href={effectiveUrl || undefined}
                actionVariant="outline"
                className="gap-3"
                onCommit={commitUrl}
              />
            )}
            {/* Icon-only force-refresh to the newest bundle. The build is
                cached hard (`public/_headers`), so this busts both the browser
                and edge caches for index.html — see `forceReloadNewest`.
                Web-only; no host route. */}
            <Button
              data-testid="about-force-refresh"
              variant="outline"
              size="icon-sm"
              aria-label={t("settings.about.reloadTitle")}
              title={t("settings.about.reloadHint")}
              onClick={forceReloadNewest}
            >
              <RefreshCwIcon className="size-3.5" />
            </Button>
          </div>
        </div>
        {urlInvalid ? (
          <p className="px-4 pb-3 text-destructive text-xs">
            {t("settings.about.invalidUrl")}
          </p>
        ) : null}
        {restartTipInRuntimeCard ? (
          <div className="mx-4 mb-3">{restartTip}</div>
        ) : null}
      </section>

      {/* ── Card 2 · Update channel. Only for the official origins — `channel`
           is null for a hand-set URL or the dev server, and there the free-text
           field above is the only control. Hidden with the bridge unavailable
           too: without `setWebappUrl` the picker would do nothing — and for
           a connection that may not call it, for the same reason. ── */}
      {!channelCardVisible ? null : (
        <section className="rounded-xl border border-border/70 bg-card" data-testid="about-channel">
          <div className="flex items-center gap-3 p-4">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-info/10 text-info">
              <RadioTowerIcon className="size-5" />
            </div>
            <div className="min-w-0">
              <div className="font-medium text-sm">
                {t("settings.about.channelTitle")}
              </div>
              <div className="mt-0.5 text-muted-foreground text-xs">
                {t("settings.about.channelDescription")}
              </div>
            </div>
          </div>

          <div className="px-4 pb-4">
            <RadioGroup
              value={channel}
              onValueChange={value => switchChannel(value as UpdateChannel)}
              className="gap-2"
            >
              {UPDATE_CHANNELS.map(c => {
                const selected = c === channel;
                // The badge names the channel actually running, which can
                // differ from `selected` right after a switch — the radio
                // moves to the new pick immediately, but nothing is running
                // off it until the pending-restart notice below is acted on.
                const isActive = c === activeChannel;
                return (
                  <ChannelOption
                    key={c}
                    value={c}
                    testId={`about-channel-${c}`}
                    availability={availability[c]}
                    selected={selected}
                    disabled={channelBusy || availability[c] === "unavailable"}
                    label={t(CHANNEL_TEXT[c].label)}
                    description={t(CHANNEL_TEXT[c].description)}
                    tag={
                      c === RECOMMENDED_CHANNEL ? (
                        <Badge variant="success" size="sm">
                          {t("settings.about.channelRecommended")}
                        </Badge>
                      ) : null
                    }
                    status={
                      isActive ? (
                        <Badge variant="success">
                          <CircleCheckIcon />
                          {t("settings.about.channelActiveBadge")}
                        </Badge>
                      ) : availability[c] === "unavailable" ? (
                        <Badge variant="muted">
                          {t("settings.about.channelNotAvailable")}
                        </Badge>
                      ) : null
                    }
                  />
                );
              })}
            </RadioGroup>

            {/* A channel this binary is too old for is NOT an error: amber
                guidance, not red text, and it names the way out. */}
            {blocked ? (
              <div
                data-testid="about-channel-blocked"
                className="mt-3 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3"
              >
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-warning-emphasis text-sm">
                    {t("settings.about.channelBlockedTitle", {
                      channel: t(CHANNEL_TEXT[blocked].label),
                    })}
                  </p>
                  <p className="mt-0.5 text-warning-emphasis/80 text-sm">
                    {t("settings.about.channelBlockedBody", {
                      channel: t(CHANNEL_TEXT[blocked].label),
                    })}
                  </p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <a
                    href={t("settings.about.channelDocsUrl")}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("settings.about.channelLearnMore")}
                    <ExternalLinkIcon className="size-3.5" />
                  </a>
                </Button>
              </div>
            ) : null}

            {channelError ? (
              <p className="mt-3 text-destructive text-xs">{channelError}</p>
            ) : null}
            {/* The switch writes a pref the running panel does not re-read;
                without this line the picker looks like it did nothing. */}
            <p className="mt-3 text-muted-foreground text-xs">
              {t("settings.about.channelHint")}
            </p>
            {/* Pending-restart notice for a switch made HERE — at the bottom of
                this card, under the control that caused it, instead of up in
                the Runtime card the user never touched. */}
            {restartTipInChannelCard ? (
              <div className="mt-3">{restartTip}</div>
            ) : null}
          </div>
        </section>
      )}

      {/* ── Card 3 · Version — the fork's own product version (the same number
           the browser's About page shows) and the Chromium base. ── */}
      <section className="rounded-xl border border-border/70 bg-card">
        <div className="flex items-center justify-between gap-4 p-4">
          <span className="flex min-w-0 items-center gap-3 text-sm">
            <MonitorIcon className="size-5 shrink-0 text-muted-foreground" />
            {t("settings.about.client")}
          </span>
          <span
            className="text-muted-foreground text-sm"
            data-testid="about-app-version"
          >
            {version?.appVersion ?? "—"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-4 border-t p-4">
          <span className="flex min-w-0 items-center gap-3 text-sm">
            <GlobeIcon className="size-5 shrink-0 text-muted-foreground" />
            {t("settings.about.builtOnChromium")}
          </span>
          <span
            className="text-muted-foreground text-sm"
            data-testid="about-chromium-version"
          >
            {version?.chromiumVersion ?? "—"}
          </span>
        </div>
      </section>

      {/* One line: the licensing statement, the copyright, and the notices of
          the third-party packages this bundle ships (emitted at build time). */}
      <p className="mt-6 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
        <ShieldCheckIcon className="size-3.5 shrink-0" />
        <span>
          {`${t("settings.about.licenseValue")} ${t("settings.about.copyright", { year })}`}
        </span>
        <a
          href={`${import.meta.env.BASE_URL}${THIRD_PARTY_NOTICES_FILE}`}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
          data-testid="about-third-party-notices"
        >
          {t("settings.about.thirdPartyNotices")}
        </a>
      </p>
    </SettingsSubpageLayout>
  );
}
