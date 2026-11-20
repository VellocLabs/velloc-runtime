// The studio components' own text (F-1): the vendored renderers read every
// string a person can see through here, by message key. The surface host sets
// the translator of the page's language before it draws.

import { createTranslate, type TranslateFn } from '../../i18n/translate'

type TextKey = Parameters<TranslateFn>[0]
type TextParams = Parameters<TranslateFn>[1]

/** A message key of the studio components. */
export type StudioTextKey = Extract<TextKey, `a2ui.studio.${string}`>

let translate: TranslateFn = createTranslate('en')

/** Use `next` for every string drawn from now on. */
export function setStudioTranslate(next: TranslateFn): void {
  translate = next
}

export function studioText(key: StudioTextKey, params?: TextParams): string {
  return translate(key, params)
}
