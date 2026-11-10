import type { PluginOrigin } from "../../../../../pluginHost/registryFormats";
import type { TranslateFn } from "../../../i18n";

export function originLabel(source: PluginOrigin | undefined): string {
  if (!source) return "";
  switch (source.source) {
    case "github":
      return `github:${source.repo}`;
    case "url":
      return source.url;
    case "directory":
      return `directory:${source.path}`;
    case "inline":
      return "inline:embedded";
    default:
      return "";
  }
}

export function relativeTime(t: TranslateFn, iso?: string): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  // Match the original granularity: floored minute/hour/day buckets, then an
  // ISO `YYYY-MM-DD` date for anything older than a week.
  const sec = Math.floor((Date.now() - then) / 1000);
  if (sec < 60) return t("settings.time.justNow");
  const min = Math.floor(sec / 60);
  if (min < 60)
    return t(
      min === 1 ? "settings.time.minuteAgo" : "settings.time.minutesAgo",
      { n: min },
    );
  const hr = Math.floor(min / 60);
  if (hr < 24)
    return t(hr === 1 ? "settings.time.hourAgo" : "settings.time.hoursAgo", {
      n: hr,
    });
  const day = Math.floor(hr / 24);
  if (day <= 7)
    return t(day === 1 ? "settings.time.dayAgo" : "settings.time.daysAgo", {
      n: day,
    });
  return new Date(then).toISOString().slice(0, 10);
}
