// The drag handle on the context popover's bar: it sits at the auto-compact
// threshold and sets the active model's window (what `/autocompact` saves).
//
// Dragging and arrow keys only preview — `onPreview` feeds the figure under
// the bar every move — and one save goes out when the drag ends (pointer up)
// or the keys settle. Escape, or a cancelled pointer, drops the preview and
// saves nothing. Range and snapping live in context/compaction/windowSlider.
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  choiceAtFraction,
  fractionForChoice,
  stepChoice,
  thresholdForChoice,
  WINDOW_SLIDER_PAGE_STEP,
  WINDOW_SLIDER_STEP,
  type WindowChoice,
  type WindowSliderScale,
} from '../../context/compaction/windowSlider'
import { useT } from './i18n'

/** Keys settle this long before their value is saved. */
const KEY_COMMIT_DELAY_MS = 400

export function AutoCompactHandle({
  scale,
  modelId,
  providerId,
  usedTokens,
  value,
  disabled,
  format,
  onPreview,
  onCommit,
}: {
  scale: WindowSliderScale
  modelId: string | undefined
  providerId?: string
  usedTokens: number
  /** The saved (or just-saved, pending) choice. */
  value: WindowChoice
  /** Read-only: shown at its place, not movable. */
  disabled?: boolean
  format: (tokens: number) => string
  /** The choice being dragged, or null when the drag ends / is cancelled. */
  onPreview: (choice: WindowChoice | null) => void
  onCommit: (choice: WindowChoice) => void
}) {
  const t = useT()
  const trackRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<WindowChoice | null>(null)
  const [dragging, setDragging] = useState(false)
  const keyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pointerId = useRef<number | null>(null)

  useEffect(() => () => clearTimeout(keyTimer.current), [])

  const shown = preview ?? value
  const threshold = thresholdForChoice(shown, modelId, providerId)
  const fraction = fractionForChoice(shown, scale)
  const pastUsage = threshold <= usedTokens
  const valueText = shown === 'auto'
    ? t('tokenUsage.autoCompactHandleAuto', { threshold: format(threshold) })
    : t('tokenUsage.autoCompactHandleFixed', { threshold: format(threshold) })

  const show = (choice: WindowChoice | null) => {
    setPreview(choice)
    onPreview(choice)
  }
  const finish = (choice: WindowChoice | null) => {
    show(null)
    if (choice !== null && choice !== value) onCommit(choice)
  }
  const choiceAt = (clientX: number): WindowChoice => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return value
    return choiceAtFraction((clientX - rect.left) / rect.width, scale, usedTokens)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return
    e.preventDefault()
    clearTimeout(keyTimer.current)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // No capture (a synthetic pointer): moves still arrive over the strip.
    }
    pointerId.current = e.pointerId
    // Focus the handle so Escape reaches it mid-drag.
    thumbRef.current?.focus()
    setDragging(true)
    show(choiceAt(e.clientX))
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== e.pointerId) return
    show(choiceAt(e.clientX))
  }
  const endDrag = (e: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
    if (pointerId.current !== e.pointerId) return
    pointerId.current = null
    setDragging(false)
    finish(commit ? choiceAt(e.clientX) : null)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    if (e.key === 'Escape') {
      if (preview === null) return
      // Cancel the drag or unsaved keys; keep the popover open.
      e.preventDefault()
      e.stopPropagation()
      clearTimeout(keyTimer.current)
      pointerId.current = null
      setDragging(false)
      show(null)
      return
    }
    const delta = ({
      ArrowRight: WINDOW_SLIDER_STEP,
      ArrowUp: WINDOW_SLIDER_STEP,
      ArrowLeft: -WINDOW_SLIDER_STEP,
      ArrowDown: -WINDOW_SLIDER_STEP,
      PageUp: WINDOW_SLIDER_PAGE_STEP,
      PageDown: -WINDOW_SLIDER_PAGE_STEP,
      Home: -Infinity,
      End: Infinity,
    } as Record<string, number>)[e.key]
    if (delta === undefined) return
    e.preventDefault()
    const next = stepChoice(shown, delta, scale)
    show(next)
    clearTimeout(keyTimer.current)
    keyTimer.current = setTimeout(() => finish(next), KEY_COMMIT_DELAY_MS)
  }

  return (
    <div
      ref={trackRef}
      // A taller hit strip than the 6px bar it sits on.
      className={cn(
        'absolute inset-x-0 -top-2 -bottom-2 touch-none',
        disabled ? 'pointer-events-none' : 'cursor-pointer',
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={e => endDrag(e, true)}
      onPointerCancel={e => endDrag(e, false)}
      onLostPointerCapture={e => endDrag(e, false)}
      data-testid="composer-auto-compact-track"
    >
      {/* Room past the threshold: what a compact frees before it is used. */}
      <div
        aria-hidden
        className="absolute top-2 bottom-2 right-0 rounded-r-full bg-foreground/10"
        style={{ left: `${fraction * 100}%` }}
      />
      <div
        ref={thumbRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={t('tokenUsage.autoCompactHandle')}
        aria-disabled={disabled || undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
        aria-valuetext={valueText}
        title={disabled ? undefined : valueText}
        data-testid="composer-auto-compact-handle"
        data-value={shown}
        className={cn(
          'absolute top-1/2 h-3.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full',
          'outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring',
          disabled
            ? 'bg-muted-foreground/50'
            : pastUsage
              ? 'bg-warning'
              : 'bg-foreground',
          dragging && 'scale-125',
        )}
        style={{ left: `${fraction * 100}%` }}
        onKeyDown={onKeyDown}
        onDoubleClick={() => {
          if (!disabled) finish('auto')
        }}
      />
      {preview !== null && (
        <div
          className="pointer-events-none absolute bottom-full mb-1 -translate-x-1/2 whitespace-nowrap rounded bg-popover px-1.5 py-0.5 text-xs tabular-nums shadow-sm ring-1 ring-border"
          style={{ left: `${Math.min(85, Math.max(15, fraction * 100))}%` }}
          data-testid="composer-auto-compact-bubble"
        >
          {valueText}
        </div>
      )}
    </div>
  )
}
