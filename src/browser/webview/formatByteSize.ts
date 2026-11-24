/** A byte count as a locale-formatted size: megabytes from 1 MB, else whole kilobytes (at least 1). */
export function formatByteSize(locale: string, bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "megabyte",
      maximumFractionDigits: 1,
    }).format(mb);
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "kilobyte",
    maximumFractionDigits: 0,
  }).format(Math.max(1, bytes / 1024));
}
