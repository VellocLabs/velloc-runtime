// An `<a2ui>` block in a reply, drawn in its place (F-1): the inline card of each
// surface it targets, or why it could not be drawn. The block's source is never
// shown.

import { useMemo, useSyncExternalStore } from 'react'
import { TriangleAlertIcon } from 'lucide-react'
import { a2uiBlockKey, blockSurfaceIds } from '../../../toolkit/builtin/a2ui/express/a2uiBlocks'
import { getA2uiBlockError, subscribeA2uiBlockErrors } from './a2uiBlockErrors'
import { A2uiInlineSurface } from './A2uiInlineSurface'
import { useT } from '../i18n'

export function A2uiBlockMention({ body }: { body: string }) {
  const t = useT()
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
