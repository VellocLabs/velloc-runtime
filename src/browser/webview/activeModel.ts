/**
 * The session's active model: the catalog row its selection names, and the name a surface shows for
 * it. Shared by the desktop picker, the composer's effort control and the phone shell's model sheet
 * and menu, so every surface resolves the same row and names it alike.
 */
import { displayModelLabel } from '../../config/nexusModelConfig/modelDisplay'
import type {
  BrowserLlmCatalog,
  BrowserLlmModel,
  BrowserLlmProvider,
  BrowserLlmSelection,
} from '../bridge/protocol/nexus_llm'

export function findActiveModel(
  catalog: BrowserLlmCatalog | null | undefined,
  selection: BrowserLlmSelection | null | undefined,
): { provider: BrowserLlmProvider; model: BrowserLlmModel } | null {
  if (!catalog || !selection) return null
  const provider = catalog.providers.find(p => p.id === selection.providerId)
  const model = provider?.models.find(m => m.id === selection.modelId)
  // A disabled provider/model is not a usable selection — the curated catalog
  // still lists a provider's models after its config is reset, but with
  // `enabled: false`. Treat that as "no active model" so the trigger shows
  // "Select model" rather than a model the user can't actually use.
  if (!provider || !model || !provider.enabled || !model.enabled) return null
  return { provider, model }
}

/**
 * What a surface names for the active model. A Latest entry names the model it runs today: the
 * trigger says what is answering, the row says it follows upgrades.
 */
export function activeModelLabel(active: { provider: BrowserLlmProvider; model: BrowserLlmModel }): string {
  const latest = active.model.entry?.kind === 'latest' ? active.model.entry : undefined
  return displayModelLabel(
    active.provider.id,
    latest
      ? latest.resolvedLabel ??
          (latest.resolvedVersion ? `${active.model.label} ${latest.resolvedVersion}` : active.model.label)
      : active.model.label,
    active.model,
  )
}
