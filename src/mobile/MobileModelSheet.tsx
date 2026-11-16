/**
 * The phone shell's model sheet (F-24), opened from the session menu. It lists the models set up
 * on the desktop — enabled models of enabled providers, grouped by provider — marks the open
 * session's, and picking one switches the session to it (with the model's default reasoning tier).
 */
import { CheckIcon } from 'lucide-react'

import type {
  BrowserLlmCatalog,
  BrowserLlmSelection,
} from '../browser/bridge/browserBridgeProtocol'
import { findActiveModel } from '../browser/webview/activeModel'
import { useT } from '../browser/webview/i18n'
import { MobileSheet } from './MobileSheet'

export type MobileModelSheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  catalog?: BrowserLlmCatalog | null
  selection?: BrowserLlmSelection | null
  onSelect: (selection: BrowserLlmSelection) => void
}

export function MobileModelSheet({ open, onOpenChange, catalog, selection, onSelect }: MobileModelSheetProps) {
  const t = useT()
  // An alias-hidden selection (a persisted snapshot id) resolves to its curated twin.
  const active = findActiveModel(catalog, selection)
  const activeAliasId = active?.model.pickerAliasId
  const groups = (catalog?.providers ?? [])
    .filter(provider => provider.enabled)
    .map(provider => ({
      provider,
      models: provider.models.filter(model => model.enabled && !model.pickerAliasId),
    }))
    .filter(group => group.models.length > 0)

  return (
    <MobileSheet open={open} onOpenChange={onOpenChange} title={t('mobile.model.title')} testId="mobile-model-sheet">
      {groups.length === 0 ? (
        <p data-testid="mobile-model-empty" className="px-3 py-2 text-muted-foreground text-sm">
          {t('mobile.model.empty')}
        </p>
      ) : (
        groups.map(({ provider, models }) => (
          <section key={provider.id} role="radiogroup" aria-label={provider.label} className="flex flex-col pb-2">
            <h2 className="px-3 pt-1 pb-1 text-muted-foreground text-sm">{provider.label}</h2>
            {models.map(model => {
              const current =
                !!active &&
                active.provider.id === provider.id &&
                (active.model.id === model.id || activeAliasId === model.id)
              return (
                <button
                  key={model.id}
                  type="button"
                  role="radio"
                  aria-checked={current}
                  data-testid="mobile-model-option"
                  data-provider-id={provider.id}
                  data-model-id={model.id}
                  onClick={() => {
                    const next: BrowserLlmSelection = { providerId: provider.id, modelId: model.id }
                    if (model.defaultThinkingTier) next.thinkingTier = model.defaultThinkingTier
                    onSelect(next)
                  }}
                  className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-left active:bg-accent"
                >
                  <span className="min-w-0 flex-1 truncate text-body">{model.label}</span>
                  <span aria-hidden className="flex size-5 shrink-0 items-center justify-center">
                    {current ? <CheckIcon className="size-5" /> : null}
                  </span>
                </button>
              )
            })}
          </section>
        ))
      )}
    </MobileSheet>
  )
}
