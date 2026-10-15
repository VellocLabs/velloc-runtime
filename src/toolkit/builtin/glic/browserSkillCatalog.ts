// The browser skill's system-prompt catalog (`## Browser tools`), on the JS
// skill-catalog seam so it stays hidden until `Skill('browser')` activates it where
// the skill is deferred. The only copy. The one-call-per-turn rule lives in this
// prose so it arrives exactly when the capability does.

import browserCatalogMd from './prompts/browser-catalog.md?raw'

/** Holder name, following the `skill.<name>.<role>` convention a2ui set. */
export const BROWSER_CATALOG_HOLDER = 'skill.browser.catalog'

export const BROWSER_SKILL_NAME = 'browser'

export const BROWSER_SYSTEM_PROMPT_CATALOG = browserCatalogMd.trimEnd()

/**
 * True for a browser tool wire name. The browser tools are host-published, so this
 * is a prefix probe; `Done` never appears without them.
 */
export function isBrowserToolName(name: string): boolean {
  return name.startsWith('Browser')
}
