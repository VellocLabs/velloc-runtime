/**
 * Tiny renderer-safe path helpers. Kept dependency-free (no React, no host
 * bridge) so both pure utils (`toolLabels.ts`) and view components
 * (`file-content-view.tsx`) can share one implementation instead of each
 * carrying a byte-identical copy.
 */

/**
 * Final path segment, tolerant of either slash style and trailing slashes:
 * `/repo/src/foo.ts` → `foo.ts`, `D:\project\bar.ts` → `bar.ts`, `/repo/dir/`
 * → `dir`.
 */
export function baseName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * A canonical key for comparing two paths that point at the SAME file but are
 * spelled differently: back- vs forward-slashes (`D:\a\b` vs `D:/a/b`) and
 * drive-letter case (`D:` vs `d:`, which Windows treats as equal). Used to
 * de-duplicate file lists — NOT for display or fs access (keep the original
 * string for those). Separators only + drive-letter case; the rest of the path
 * is left untouched so genuinely case-sensitive names are still distinct.
 */
export function normalizePathKey(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  return slashed.replace(/^([a-zA-Z]):/, (_m, drive: string) => `${drive.toLowerCase()}:`);
}
