/**
 * Pure paging helpers for the import dialog's numbered pager.
 * Pages are 0-based internally; `pageWindow` yields the 1-based labels the
 * pager renders, with `'ellipsis'` standing in for a skipped run.
 */

export type PageToken = number | "ellipsis";

export function pagesNeeded(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
}

/** 1-based range `{from, to}` of the rows a page shows, or null when the
 *  list is empty. */
export function pageRange(
  page: number,
  pageSize: number,
  total: number,
): { from: number; to: number } | null {
  if (total <= 0) return null;
  const from = page * pageSize + 1;
  if (from > total) return null;
  return { from, to: Math.min(total, from + pageSize - 1) };
}

/**
 * The page labels to render around `current` (0-based): always the first
 * and last page, `radius` neighbours on each side of the current one, and
 * an ellipsis wherever a run of pages is skipped. Every page is listed when
 * the count is small enough that no ellipsis would save a slot.
 */
export function pageWindow(
  current: number,
  count: number,
  radius = 1,
): PageToken[] {
  if (count <= 0) return [];
  const last = count - 1;
  const cur = Math.min(Math.max(0, current), last);
  // first, last, current ± radius, plus one slot per ellipsis.
  const maxVisible = 2 + 2 * radius + 1 + 2;
  if (count <= maxVisible) {
    return Array.from({ length: count }, (_, i) => i + 1);
  }
  const pages = new Set<number>([0, last]);
  for (let p = cur - radius; p <= cur + radius; p++) {
    if (p >= 0 && p <= last) pages.add(p);
  }
  const sorted = Array.from(pages).sort((a, b) => a - b);
  const out: PageToken[] = [];
  let previous = -1;
  for (const p of sorted) {
    if (previous >= 0 && p - previous > 1) {
      // A gap of exactly one page is shown as that page, not an ellipsis.
      if (p - previous === 2) out.push(previous + 2);
      else out.push("ellipsis");
    }
    out.push(p + 1);
    previous = p;
  }
  return out;
}
