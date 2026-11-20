# Vendored source: what differs from upstream

Upstream: https://github.com/CopilotKit/CopilotKit, commit
`c1f317e839996dc845b930567210c8d976d6c5b1`, directory
`examples/showcases/a2ui-playground`. Licence: MIT (`LICENSE` beside this file).

Everything here is a copy of the upstream file of the same name, with only the
changes below. To take a newer upstream, copy the files again and re-apply
this list.

| Here | Upstream | Change |
|---|---|---|
| `catalog/definitions/*`, `catalog/entries.ts` | `src/a2ui/catalog/…` | `zod` imports read `zod/v3`. `definitions/index.ts` no longer includes the map definitions. `definitions/maps.ts` is not copied. |
| `catalog/renderers/*` | `src/a2ui/catalog/renderers/…` | `@/components/ui/*` and `@/lib/utils` imports are relative paths into `ui/` and `lib/`. The `"use client"` line is removed. `maps.tsx` and `map/` are not copied. `content.tsx` copies code through `writeClipboard` from `@/utils/clipboard`, which also works off a secure context. One comment in `domain.tsx` is reworded. |
| `catalog/theme.ts` | `src/a2ui/catalog/catalog.ts` | Only the `playgroundTheme` constant. |
| `ui/*` | `src/components/ui/*` | Only the files the renderers import. Same import rewrites. |
| `lib/utils.ts` | `src/lib/utils.ts` | None. |
| `styles/motion.css` | `src/styles/motion.css` | The reduced-motion rule drops two selectors of the playground's chat shell. |
| `styles/tokens.css` | `src/app/globals.css` | Only the token blocks, the surface component rules, the grid rules and the table-container rules. `:root` and `.dark` selectors are narrowed to the surface host and the overlay root, so the tokens do not reach the rest of the app. |

Not copied: maps, the other design systems, the build log overlay, the
playground shell.
