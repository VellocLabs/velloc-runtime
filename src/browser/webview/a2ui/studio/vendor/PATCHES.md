# Vendored source: what differs from upstream

Upstream: https://github.com/CopilotKit/CopilotKit, commit
`c1f317e839996dc845b930567210c8d976d6c5b1`, directory
`examples/showcases/a2ui-playground`. Licence: MIT (`LICENSE` beside this file).

Everything here is a copy of the upstream file of the same name, with only the
changes below. To take a newer upstream, copy the files again and re-apply
this list.

| Here | Upstream | Change |
|---|---|---|
| `catalog/definitions/*`, `catalog/entries.ts` | `src/a2ui/catalog/…` | `zod` imports read `zod/v3`. `definitions/index.ts` no longer includes the map definitions. `definitions/maps.ts` is not copied. `shared.ts` adds `onChange`; ButtonGroup and ChipSelect declare it and DataTable declares `onRowClick`, a column `filter` flag, row selection (`selectKey`, a writable `value`, `onChange`), and `reorderable` with an `onReorder` event. |
| `catalog/renderers/*` | `src/a2ui/catalog/renderers/…` | `@/components/ui/*` and `@/lib/utils` imports are relative paths into `ui/` and `lib/`. The `"use client"` line is removed. `maps.tsx` and `map/` are not copied. `inputs.tsx` sends `onChange` and `data.tsx` sends `onRowClick` (click, Enter or Space on a focusable row) and draws a chip row per column marked `filter`, which narrows the rows in place, and with `selectKey` a first checkbox column and a Selection filter row (checked / not checked, with counts) (`ui/checkbox`, `use-bound`), and with `reorderable` a first grip column, native HTML5 row drag and arrow keys on the grip, every row on one page without search, filters or sorting, the dropped order held locally until new rows arrive, and `onReorder`; `types.ts` types the event props. `content.tsx` copies code through `writeClipboard` from `@/utils/clipboard`, which also works off a secure context. One comment in `domain.tsx` is reworded. Every string a person can see (chart names, table search, paging, empty states, date and option pickers, "Feels like", "Sample data") is read with `studioText("a2ui.studio.…")` from `../../../studioText` instead of written in place: `chart-kit.tsx`, `charts.tsx`, `content.tsx`, `data.tsx`, `domain.tsx`, `inputs.tsx`. |
| `catalog/theme.ts` | `src/a2ui/catalog/catalog.ts` | Only the `playgroundTheme` constant. |
| `ui/*` | `src/components/ui/*` | Only the files the renderers import. Same import rewrites. |
| `lib/utils.ts` | `src/lib/utils.ts` | None. |
| `styles/motion.css` | `src/styles/motion.css` | The reduced-motion rule drops two selectors of the playground's chat shell. |
| `styles/tokens.css` | `src/app/globals.css` | Only the token blocks, the surface component rules, the grid rules and the table-container rules. `:root` and `.dark` selectors are narrowed to the surface host and the overlay root, so the tokens do not reach the rest of the app. |

Not copied: maps, the other design systems, the build log overlay, the
playground shell.
