import type {
  NexusConfiguredModel,
  NexusModelConfig,
  NexusModelPattern,
  NexusProviderModelConfig,
} from './nexusModelConfig'
import type {
  NexusConfiguredModelWire,
  NexusModelConfigWire,
  NexusProviderModelConfigWire,
} from '../browser/bridge/browserBridgeProtocol'

import { knownModelRows } from './nexusModelConfig/familyRows'
import { versionParser } from './nexusModelConfig/modelEntries'

/**
 * Converts a `NexusModelPattern` to its wire representation. Plain strings
 * pass through; regexes become their `source` (the C++ side stores the
 * value verbatim; `BuildCatalog` derives a model id from it with
 * `DeriveTsModelId`).
 */
function patternToWire(pattern: NexusModelPattern): string {
  return pattern instanceof RegExp ? pattern.source : pattern
}

function modelToWire(model: NexusConfiguredModel): NexusConfiguredModelWire {
  const wire: NexusConfiguredModelWire = {
    model: patternToWire(model.model),
  }
  if (model.name !== undefined) wire.name = model.name
  if (model.exclude !== undefined) {
    wire.exclude = model.exclude.map(patternToWire)
  }
  if (model.defaultThinkingTier !== undefined) {
    wire.defaultThinkingTier = model.defaultThinkingTier
  }
  if (model.availableThinkingTiers !== undefined) {
    wire.availableThinkingTiers = [...model.availableThinkingTiers]
  }
  if (model.contextWindow !== undefined) {
    wire.contextWindow = model.contextWindow
  }
  if (model.defaultMaxOutputTokens !== undefined) {
    wire.defaultMaxOutputTokens = model.defaultMaxOutputTokens
  }
  if (model.maxOutputTokens !== undefined) {
    wire.maxOutputTokens = model.maxOutputTokens
  }
  if (model.supportsStrictTools !== undefined) {
    wire.supportsStrictTools = model.supportsStrictTools
  }
  if (model.supportsImageInput !== undefined) {
    wire.supportsImageInput = model.supportsImageInput
  }
  return wire
}

function providerToWire(
  provider: NexusProviderModelConfig,
): NexusProviderModelConfigWire {
  const wire: NexusProviderModelConfigWire = {
    providerId: provider.providerId,
    // One row per KNOWN model: the host flattens each `model` to a literal
    // id and drops what it cannot flatten, so a family row goes out as its
    // verified version and the versions it names (./nexusModelConfig/familyRows.ts).
    // Each row carries the model catalog's figures where it leaves them unset
    // (./nexusModelConfig/catalogFigures.ts), so the host holds what the
    // runtime reads.
    models: knownModelRows(provider.models, versionParser(provider.providerId), provider.providerId).map(modelToWire),
  }
  if (provider.filterMode !== undefined) {
    wire.filterMode = provider.filterMode
  }
  if (provider.defaultBaseUrl !== undefined) {
    wire.defaultBaseUrl = provider.defaultBaseUrl
  }
  return wire
}

/**
 * Serialises the in-memory `NexusModelConfig` (which may contain RegExp
 * patterns) into a JSON-friendly `NexusModelConfigWire`. Used by
 * MultiSessionShell to push the catalog to C++ at boot.
 */
export function serializeNexusModelConfig(
  config: NexusModelConfig,
): NexusModelConfigWire {
  return {
    providers: config.providers.map(providerToWire),
  }
}
