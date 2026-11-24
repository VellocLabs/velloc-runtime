// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { BackgroundTasksDrawer } from '../browser/webview/BackgroundTasksDrawer'
import { RightPanelContentContext } from '../components/assistant-ui/right-panel-content-context'
import type { NexusTaskDetail, NexusTaskInfo, NexusTaskSummaryRow } from '../browser/bridge/protocol/ui'

const NOW = Date.now()
const LOG = 'C:/proj/.velloc/tasks/b-run.output'

const finishedRow: NexusTaskSummaryRow = {
  sessionId: 'b-run',
  spawnerSessionId: 'P',
  status: 'success',
  type: 'local_bash',
  description: 'npm run build',
  command: 'npm run build',
  startedAt: NOW - 5_000,
  lastActivityAt: NOW - 1_000,
  finishedAt: NOW - 1_000,
}

function renderDetail(info: NexusTaskInfo, openFile?: (t: { path: string }) => void) {
  const detail: NexusTaskDetail = { entries: null, info }
  const drawer = createElement(BackgroundTasksDrawer, {
    rows: [finishedRow],
    focusSessionId: 'b-run',
    onClose: () => {},
    onStop: () => {},
    onResume: () => {},
    loadTranscript: async () => detail,
  })
  render(
    openFile
      ? createElement(RightPanelContentContext.Provider, { value: { openFile } }, drawer)
      : drawer,
  )
}

const outputBlock = () =>
  document.querySelector('[data-testid="background-tasks-detail-output"]')
const cutNotice = () =>
  document.querySelector('[data-testid="background-tasks-detail-output-cut"]')
const openButton = () =>
  document.querySelector<HTMLElement>('[data-testid="background-tasks-detail-output-open"]')

afterEach(() => cleanup())

describe('BackgroundTasksDrawer cut output notice', () => {
  it('says the output was cut, gives the full size, and opens the file', async () => {
    const openFile = vi.fn()
    renderDetail(
      {
        type: 'local_bash',
        task: 'npm run build',
        outputFilePath: LOG,
        outputText: 'TAIL_ONLY',
        outputTruncated: true,
        outputBytes: 12 * 1024 * 1024,
      },
      openFile,
    )
    await waitFor(() => expect(cutNotice()).not.toBeNull())
    expect(cutNotice()!.textContent).toContain('Showing the end of the output')
    expect(cutNotice()!.textContent).toContain('12 MB')
    expect(outputBlock()!.textContent).toContain('TAIL_ONLY')
    fireEvent.click(openButton()!)
    expect(openFile).toHaveBeenCalledWith({ path: LOG })
  })

  it('shows the notice without an open action where the host cannot open files', async () => {
    renderDetail({
      type: 'local_bash',
      outputFilePath: LOG,
      outputText: 'TAIL_ONLY',
      outputTruncated: true,
      outputBytes: 300 * 1024,
    })
    await waitFor(() => expect(cutNotice()).not.toBeNull())
    expect(cutNotice()!.textContent).toContain('300 kB')
    expect(openButton()).toBeNull()
  })

  it('shows no notice for an output that was not cut', async () => {
    renderDetail({ type: 'local_bash', outputFilePath: LOG, outputText: 'WHOLE' }, vi.fn())
    await waitFor(() => expect(outputBlock()).not.toBeNull())
    expect(outputBlock()!.textContent).toContain('Output')
    expect(cutNotice()).toBeNull()
  })
})
