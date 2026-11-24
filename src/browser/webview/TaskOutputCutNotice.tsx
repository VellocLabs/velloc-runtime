import { useRightPanelContent } from '@/components/assistant-ui/right-panel-content-context'
import { formatByteSize } from './formatByteSize'
import { useLocale, useT } from './i18n'

/**
 * The Background Tasks detail's notice for an output shown only in part: the
 * full size, and an *Open file* action when the host can open the file (F-2).
 */
export function TaskOutputCutNotice({
  totalBytes,
  path,
}: {
  totalBytes: number
  path?: string
}) {
  const t = useT()
  const locale = useLocale()
  const { openFile } = useRightPanelContent()
  return (
    <p
      data-testid="background-tasks-detail-output-cut"
      className="mb-1 text-[10px] text-muted-foreground"
    >
      {t('backgroundTasks.outputCut', { size: formatByteSize(locale, totalBytes) })}
      {path && openFile ? (
        <>
          {' '}
          <button
            type="button"
            data-testid="background-tasks-detail-output-open"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => openFile({ path })}
          >
            {t('backgroundTasks.openOutputFile')}
          </button>
        </>
      ) : null}
    </p>
  )
}
