/**
 * A model's figures as the pages word them — its context window and its
 * price per 1M tokens (or Free) — shared by the settings page's Add models
 * dialog and entry list and the quick picker's detail footer, so a price
 * reads the same everywhere it appears.
 */
import { formatTokenCount } from './settings/customProviderHelpers'
import type { useT } from './i18n'

type Translate = ReturnType<typeof useT>

export type ModelFigures = {
  contextWindow?: number
  /** USD per million tokens. */
  price?: { input: number; output: number }
  free?: boolean
}

/** A USD price per million tokens, as the locale writes money: cents always,
 *  sub-cent digits only when the price has them (`$0.05`, `$0.0625`). */
export function formatUsdPrice(amount: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(amount)
  } catch {
    return '$' + String(amount)
  }
}

/** A price as a bare number (`0.1`, `0.0625`, `15`) — for the compact
 *  form, where an icon says it is money and a tooltip the unit. */
export function formatPlainPrice(amount: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(amount)
  } catch {
    return String(amount)
  }
}

/** `1M context`, or undefined when the window is unknown. */
export function contextFigure(model: ModelFigures, t: Translate): string | undefined {
  return model.contextWindow
    ? t('settings.models.contextLabel', { value: formatTokenCount(model.contextWindow) })
    : undefined
}

/**
 * `Free`, or `$0.10 in · $0.50 out per 1M tokens` (`compact`: `0.1 in ·
 * 0.5 out`, bare numbers beside a money icon), or undefined when the listing
 * states no price. The price is what tells a
 * gateway's look-alike variants apart (a model, its `:batch` half-price twin).
 */
export function priceFigure(
  model: ModelFigures,
  t: Translate,
  locale: string,
  compact = false,
): string | undefined {
  if (model.free) return t('settings.models.entries.free')
  if (!model.price) return undefined
  const format = compact ? formatPlainPrice : formatUsdPrice
  return t(compact ? 'modelPicker.price' : 'settings.models.entries.price', {
    input: format(model.price.input, locale),
    output: format(model.price.output, locale),
  })
}
