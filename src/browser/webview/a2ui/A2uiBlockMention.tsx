// An `<a2ui>` block in a reply, drawn in its place (F-1): the inline card of each
// surface it targets, or why it could not be drawn; while the model is still
// writing it, the card of the surface it is drawing. The block's source is
// never shown.

import { useCallback, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { TriangleAlertIcon } from 'lucide-react'
import { a2uiBlockKey, blockSurfaceIds } from '../../../toolkit/builtin/a2ui/express/a2uiBlocks'
import { getA2uiBlockError, subscribeA2uiBlockErrors } from './a2uiBlockErrors'
import { A2uiInlineSurface } from './A2uiInlineSurface'
import { useT } from '../i18n'
import { useA2uiLiveBlocks } from './a2uiLiveContext'

export function A2uiBlockMention({ body, segmentKey }: { body: string; segmentKey?: string }) {
  const t = useT()
  const live = useA2uiLiveBlocks()
  useEffect(() => {
    if (segmentKey) live?.feed(segmentKey, body, true)
  }, [live, segmentKey, body])
  const { targets } = useMemo(() => blockSurfaceIds(body), [body])
  const key = a2uiBlockKey(targets[0] ?? '', body)
  const read = () => getA2uiBlockError(key)
  const error = useSyncExternalStore(subscribeA2uiBlockErrors, read, read)
  if (error) {
    return (
      <div
        data-slot="a2ui-block-error"
        className="my-2 flex w-full flex-col gap-1 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-xs"
      >
        <span className="flex items-center gap-2 font-medium text-warning">
          <TriangleAlertIcon className="size-3.5 shrink-0" />
          {t('a2ui.blockFailed')}
        </span>
        <code className="whitespace-pre-wrap break-words text-muted-foreground">{error}</code>
      </div>
    )
  }
  return (
    <>
      {targets.map(surfaceId => (
        <A2uiInlineSurface key={surfaceId} surfaceId={surfaceId} mentionKey={a2uiBlockKey(surfaceId, body)} />
      ))}
    </>
  )
}

/** A block still streaming: fed to the live reader, drawn once its surface is known. */
export function A2uiLiveBlockMention({
  body,
  segmentKey,
  pending,
}: {
  body: string
  segmentKey: string
  pending: ReactNode
}) {
  const live = useA2uiLiveBlocks()
  useEffect(() => {
    live?.feed(segmentKey, body, false)
  }, [live, segmentKey, body])
  const read = useCallback(() => live?.snapshot() ?? null, [live])
  const subscribe = useCallback((listener: () => void) => live?.subscribe(listener) ?? (() => {}), [live])
  const snapshot = useSyncExternalStore(subscribe, read, read)
  if (!snapshot || snapshot.segmentKey !== segmentKey || !snapshot.surfaceId) return <>{pending}</>
  return <A2uiInlineSurface surfaceId={snapshot.surfaceId} mentionKey={snapshot.mentionKey} />
}
