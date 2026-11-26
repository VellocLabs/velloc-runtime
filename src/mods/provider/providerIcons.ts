/**
 * Contract: a provider's brand mark as a mod is handed it (F-27): the `icon`
 * of a peer, of a definition a router's settings app lists, and of
 * `$.provider.icons({ definitions })`. An icon is an image URL
 * (`data:image/svg+xml`), the one form an app page may load. A built-in's
 * mark is the host catalog's, a provider mod's is its manifest's; a custom
 * provider has none. Read from memory: nothing is fetched and the host is not
 * asked.
 *
 * Security: the SVG text only ever leaves as an image URL, and an SVG loaded
 * as an image runs no script and fetches nothing. A mark names a vendor and
 * nothing about an account.
 */
import { hostProviderIconSvg } from '../../config/hostProviderIcons'
import { getProviderDefinition } from '../../config/nexusModelConfig/providers'
import { routerReaches, type RoutesTo } from '../../models/drivers/providerRouter'
import { providerDefinitionId } from '../../models/drivers/runtimeProviders'

/** The most definitions one `icons` call may name. */
export const ICON_DEFINITIONS_MAX = 32

/** How many converted marks are kept; the one read longest ago is dropped first. */
export const ICON_URL_CACHE_SIZE = 64

/**
 * What `currentColor` resolves to inside the image: an image takes no colour
 * from the page, so the mark states one per colour scheme itself.
 */
const SCHEME_STYLE =
  '<style>:root{color:#18181b}@media (prefers-color-scheme:dark){:root{color:#fafafa}}</style>'

const OPENING_TAG = /^<svg\b[^>]*>/i

const urls = new Map<string, string>()

/** `svg` with a colour for `currentColor` in each scheme; unchanged when it uses none. */
function withSchemeColour(svg: string): string {
  if (!/currentcolor/i.test(svg)) return svg
  const text = svg.replace(/^﻿/, '').trimStart()
  const opening = OPENING_TAG.exec(text)
  if (!opening) return svg
  return opening[0] + SCHEME_STYLE + text.slice(opening[0].length)
}

/** The image URL of a mark's SVG text. */
export function iconImageUrl(svg: string): string {
  const held = urls.get(svg)
  if (held !== undefined) {
    urls.delete(svg)
    urls.set(svg, held)
    return held
  }
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withSchemeColour(svg))}`
  urls.set(svg, url)
  if (urls.size > ICON_URL_CACHE_SIZE) urls.delete(urls.keys().next().value as string)
  return url
}

/** The router asking `icons`, and its boundary. */
export type IconReader = { routerId: string; routesTo: RoutesTo }

/**
 * The mark of one registered definition; undefined for an id that is none, and for one without a mark.
 * Security: with `reader`, a provider mod's definition is answered only when the router reaches it, so
 * the answer says no more about which plugins are installed than the router's peers do.
 */
function definitionIcon(definitionId: string, reader?: IconReader): string | undefined {
  const definition = getProviderDefinition(definitionId)
  if (!definition) return undefined
  const mod = definition.catalogMod
  if (reader && mod && !routerReaches(reader.routerId, reader.routesTo, { definition: definitionId, ...(mod.managedBy !== undefined ? { managedBy: mod.managedBy } : {}) })) {
    return undefined
  }
  const svg = mod
    ? definition.iconSource
    : (definition.iconSvg ?? hostProviderIconSvg(definitionId))
  return svg ? iconImageUrl(svg) : undefined
}

/** The mark of the definition a provider instance belongs to; undefined for a custom provider. */
export function providerIconOf(instanceId: string): string | undefined {
  return definitionIcon(providerDefinitionId(instanceId))
}

/** `{ icon }` when the instance's definition has a mark, else nothing: the field is absent, never empty. */
export function providerIconField(instanceId: string): { icon?: string } {
  const icon = providerIconOf(instanceId)
  return icon !== undefined ? { icon } : {}
}

function readDefinitionIds(args: unknown): string[] {
  const list = typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as { definitions?: unknown }).definitions : undefined
  if (!Array.isArray(list)) throw new TypeError('$.provider.icons({ definitions }): definitions must be an array of definition ids')
  if (list.length > ICON_DEFINITIONS_MAX) {
    throw new RangeError(`$.provider.icons: at most ${ICON_DEFINITIONS_MAX} definitions in one call, got ${list.length}`)
  }
  for (const id of list) {
    if (typeof id !== 'string' || id === '') throw new TypeError('$.provider.icons: each definition must be a definition id')
  }
  return list as string[]
}

/**
 * `$.provider.icons({ definitions })`: the mark of each named definition that
 * is a built-in or a registered provider mod's the router reaches, set up or
 * not. An id that is neither, or whose definition has no mark, is left out.
 */
export function serveProviderIcons(args: unknown, reader: IconReader): Record<string, string> {
  const found = new Map<string, string>()
  for (const id of readDefinitionIds(args)) {
    const icon = definitionIcon(id, reader)
    if (icon !== undefined) found.set(id, icon)
  }
  return Object.fromEntries(found)
}

/** Test seam: forget the converted marks. */
export function resetProviderIconUrls(): void {
  urls.clear()
}
