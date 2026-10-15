/**
 * Turns a plugin's provider into a `runtimeOnly` `ProviderDefinition`, so a provider
 * mod is served by `runtimeProviders.ts` and no other path. NOTHING here calls into
 * the mod: a definition is data and closures over the listing cache.
 */

import { resolveLocalizedText } from '../../config/localizedText'
import type {
  ProviderCodeListing,
  ProviderDefinition,
} from '../../config/nexusModelConfig/providerDefinition'
import type { NexusProviderModelConfig } from '../../config/nexusModelConfig/types'
import { parseModelVersion } from '../../config/nexusModelConfig/providers/shared/modelVersions'
import type { ModelVersionInfo } from '../../config/nexusModelConfig/providers/shared/modelVersions'
import { listedModelInfo } from '../../models/drivers/runtimeProviders'
import type { ResolvedProvider } from './providerManifest'

/** A vendor's mark is drawn into the page; anything bigger is not a mark. */
export const MOD_ICON_MAX_BYTES = 64 * 1024

/**
 * The text of a vendor's `.svg` icon if it is safe to draw into the page, else
 * undefined (the generic mark is shown instead). The page puts the string in
 * as markup, so anything that can run code or reach out is refused: scripts,
 * event-handler attributes, `javascript:` and `data:` links, foreign objects,
 * embedded documents, external references, and any entity or doctype tricks.
 */
export function safeIconSvg(text: string): string | undefined {
  if (text.length === 0 || text.length > MOD_ICON_MAX_BYTES) return undefined
  const svg = text.replace(/^﻿/, '').trim()
  if (!/^<svg[\s>]/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) return undefined
  if (/<!(?:doctype|entity|\[cdata\[)/i.test(svg) || /<\?/.test(svg)) return undefined
  if (/<\s*(?:script|foreignobject|iframe|object|embed|style|animate|set|use|image|a|link|meta|audio|video)\b/i.test(svg)) {
    return undefined
  }
  // An attribute starts after whitespace, `/` or a closing quote alike.
  if (/(?:^|[^a-z0-9_.:-])on[a-z]+\s*=/i.test(svg)) return undefined
  if (/(?:javascript|vbscript|data)\s*:/i.test(svg)) return undefined
  // A reference that leaves the document: only `url(#id)` into itself is fine.
  if (/url\(\s*['"]?(?!#)/i.test(svg)) return undefined
  if (/\b(?:xlink:)?href\s*=/i.test(svg)) return undefined
  return svg
}

/**
 * Security: the markup the page draws for a vendor's checked mark. The
 * vendor's text is never put into the page as markup: it becomes the data URL
 * of an `<image>` in a frame of our own, and an SVG loaded as an image runs no
 * script and fetches nothing, whatever `safeIconSvg` missed.
 */
export function iconAsImage(svg: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
    `<image width="24" height="24" href="data:image/svg+xml,${encodeURIComponent(svg)}"/></svg>`
  )
}

export type ModProviderDefinitionOptions = {
  plugin: string
  pluginVersion?: string
  /** The plugin's id as `pluginConfigs` is keyed (`modSlot.pluginConfigId`). */
  pluginId?: string
  provider: ResolvedProvider
  /** The vendor's icon text, read and checked by the host (`safeIconSvg`);
   *  absent = the generic mark. */
  iconSvg?: string
  /** The module's worker is up now (`ProviderModRuntime` status). */
  isLoaded: () => boolean
  /** Ask the module for its models (`provider.models`). Absent: the call is
   *  not connected, and a listing request fails without touching the module —
   *  the cached listing stands. */
  list?: ProviderCodeListing['list']
  /** The connection check through the module (`provider.verify`). Absent:
   *  the core probe alone. */
  verify?: ProviderCodeListing['verify']
  /** Usage through the module (`provider.usage`). Absent: none is shown. */
  usage?: {
    reports(providerId: string): boolean
    fetch: NonNullable<ProviderCodeListing['usage']>['fetch']
  }
}

const NOT_CONNECTED = 'the provider module cannot list models yet: provider.models is not connected in this build'

/** `family`/`version` as the listing states them, else the shared reading of
 *  the id — a mod registers no id-reading rule of its own. */
function versionOf(providerId: string, id: string): ModelVersionInfo {
  const stated = listedModelInfo(providerId, id)
  const shared = parseModelVersion(id)
  if (!stated?.family && !stated?.version) return shared
  const label = stated.version ?? shared.versionLabel
  const numbers = /^\d+(?:\.\d+)*$/.test(label) ? label.split('.').map(Number) : shared.version
  return {
    ...shared,
    family: stated.family ?? shared.family,
    version: numbers,
    versionLabel: label,
  }
}

export function modProviderDefinition(options: ModProviderDefinitionOptions): ProviderDefinition {
  const { provider } = options
  const { manifest, id } = provider
  const config: NexusProviderModelConfig = {
    providerId: id,
    // The person picks from the vendor's listing, as with a gateway.
    filterMode: 'passthrough',
    defaultBaseUrl: manifest.defaultBaseUrl,
    wire: { format: manifest.format },
    models: [],
  }
  const secrets = manifest.credentials.secrets ?? []
  const definition: ProviderDefinition = {
    config,
    runtimeOnly: true,
    // The English name stands for the row's plain `label`; the page resolves
    // the person's language from `catalogMod.displayName`.
    label: resolveLocalizedText(manifest.displayName, 'en'),
    ...(options.iconSvg !== undefined ? { iconSvg: iconAsImage(options.iconSvg) } : {}),
    codeListing: {
      isLoaded: options.isLoaded,
      list: options.list ?? (() => Promise.reject(new Error(NOT_CONNECTED))),
      ...(options.verify ? { verify: options.verify } : {}),
      ...(options.usage
        ? { usage: { reports: () => options.usage!.reports(id), fetch: options.usage.fetch } }
        : {}),
    },
    versions: modelId => versionOf(id, modelId),
    ...(secrets.length > 0 ? { modSecretNames: secrets.map(secret => secret.name) } : {}),
    catalogMod: {
      state: 'ready',
      plugin: options.plugin,
      ...(options.pluginVersion !== undefined ? { version: options.pluginVersion } : {}),
      ...(options.pluginId !== undefined ? { configId: options.pluginId } : {}),
      displayName: manifest.displayName,
      defaultBaseUrl: manifest.defaultBaseUrl,
      credentialMethods: [...manifest.credentials.methods],
      secrets: secrets.map(secret => ({ ...secret })),
      settings: manifest.settings ?? {},
      prompts: manifest.credentials.prompts ?? [],
      ...(manifest.modelsUi ? { modelsUi: manifest.modelsUi } : {}),
      ...(manifest.credentials.readsSecrets ? { readsSecrets: true } : {}),
    },
  }
  return definition
}
