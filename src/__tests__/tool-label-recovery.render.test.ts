// @vitest-environment happy-dom
/**
 * useToolLabelArgs through the single-tool ToolFallback card: a settled row whose label field is missing (historical
 * transcripts) fetches the tool-detail sidecar once and labels from it. Also pins the WorkspaceDiff title jump.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentType, type ReactElement, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ToolFallback } from '../components/assistant-ui/tool-fallback'
import { ToolCallDetailProvider } from '../components/assistant-ui/tool-call-detail-context'
import {
  RightPanelContentContext,
  type RightPanelContentContextValue,
} from '../components/assistant-ui/right-panel-content-context'
import type { BrowserToolCallDetailRecord } from '../utils/toolCallDetails'

type ToolFallbackTestProps = {
  toolCallId: string
  toolName: string
  args?: unknown
  result?: unknown
  isError?: boolean
  status?: { type: string; reason?: string }
}
const Tool = ToolFallback as unknown as ComponentType<ToolFallbackTestProps>

function withProviders(
  node: ReactNode,
  opts: {
    loadToolCallDetail?: (
      toolCallId: string,
    ) => Promise<BrowserToolCallDetailRecord | null>
    rightPanel?: RightPanelContentContextValue
  } = {},
): ReactNode {
  return createElement(
    RightPanelContentContext.Provider,
    { value: opts.rightPanel ?? {} },
    createElement(
      ToolCallDetailProvider,
      { loadToolCallDetail: opts.loadToolCallDetail, children: node },
    ),
  )
}

afterEach(() => cleanup())

describe('sidecar label recovery (historical stripped args)', () => {
  it('a settled Read row with no file_path recovers "Read <basename>" from the sidecar', async () => {
    const load = vi.fn(async (toolCallId: string) => ({
      toolCallId,
      toolName: 'Read',
      args: { file_path: '/repo/deep/alpha.ts' },
    }))
    render(
      (withProviders(
            createElement(Tool, {
              toolCallId: 'hist-read-1',
              toolName: 'Read',
              args: {},
              result: 'file text',
              status: { type: 'complete' },
            }),
            { loadToolCallDetail: load },
          ) as ReactElement),
    )
    await waitFor(() =>
      expect(document.body.textContent).toContain('Read alpha.ts'),
    )
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('a settled SuperEdit row with no description recovers "Super Edit: <description>" (code stays out of the DOM)', async () => {
    const load = vi.fn(async (toolCallId: string) => ({
      toolCallId,
      toolName: 'SuperEdit',
      args: { description: 'Rename files', code: 'SECRET_JS_SOURCE' },
    }))
    render(
      (withProviders(
            createElement(Tool, {
              toolCallId: 'hist-js-1',
              toolName: 'SuperEdit',
              args: {},
              result: 'done',
              status: { type: 'complete' },
            }),
            { loadToolCallDetail: load },
          ) as ReactElement),
    )
    await waitFor(() =>
      expect(document.body.textContent).toContain('Super Edit: Rename files'),
    )
    expect(document.body.textContent).not.toContain('SECRET_JS_SOURCE')
  })

  it('a Grep row recovers its quoted pattern ("Search: …")', async () => {
    const load = vi.fn(async (toolCallId: string) => ({
      toolCallId,
      toolName: 'Grep',
      args: { pattern: 'NEEDLE', path: '/repo' },
    }))
    render(
      (withProviders(
            createElement(Tool, {
              toolCallId: 'hist-grep-1',
              toolName: 'Grep',
              args: {},
              result: 'hits',
              status: { type: 'complete' },
            }),
            { loadToolCallDetail: load },
          ) as ReactElement),
    )
    await waitFor(() =>
      expect(document.body.textContent).toContain('Search: "NEEDLE" in /repo'),
    )
  })

  it('a missing sidecar keeps the honest bare-name fallback (no retry loop)', async () => {
    const load = vi.fn(async () => null)
    render(
      (withProviders(
            createElement(Tool, {
              toolCallId: 'hist-none-1',
              toolName: 'Read',
              args: {},
              result: 'x',
              status: { type: 'complete' },
            }),
            { loadToolCallDetail: load },
          ) as ReactElement),
    )
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    // Give any (buggy) retry a chance to fire, then re-assert single-shot.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(load).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('Read')
  })

  it('a RUNNING call never fetches (the sidecar is written at turn end)', async () => {
    const load = vi.fn(async () => null)
    render(
      (withProviders(
            createElement(Tool, {
              toolCallId: 'live-1',
              toolName: 'Grep',
              args: {},
              status: { type: 'running' },
            }),
            { loadToolCallDetail: load },
          ) as ReactElement),
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(load).not.toHaveBeenCalled()
  })
})

describe('WorkspaceDiff card title jump', () => {
  it('renders "WorkspaceDiff: <basename>" and jumps with the path', () => {
    const opened: Array<string | undefined> = []
    render(
      (withProviders(
            createElement(Tool, {
              toolCallId: 'wd-1',
              toolName: 'WorkspaceDiff',
              args: { path: 'src/x.ts' },
              result: 'diff text',
              status: { type: 'complete' },
            }),
            { rightPanel: { openWorkspaceDiff: path => opened.push(path) } },
          ) as ReactElement),
    )
    expect(document.body.textContent).toContain('WorkspaceDiff: x.ts')
    const link = document.querySelector<HTMLElement>(
      '[data-slot="tool-fallback-trigger-title-link"]',
    )
    expect(link).not.toBeNull()
    link!.click()
    expect(opened).toEqual(['src/x.ts'])
  })

  it('a path-less call renders bare WorkspaceDiff and jumps to the history tab (undefined path)', () => {
    const opened: Array<string | undefined> = []
    render(
      (withProviders(
            createElement(Tool, {
              toolCallId: 'wd-2',
              toolName: 'WorkspaceDiff',
              args: {},
              result: 'diff text',
              status: { type: 'complete' },
            }),
            { rightPanel: { openWorkspaceDiff: path => opened.push(path) } },
          ) as ReactElement),
    )
    const link = document.querySelector<HTMLElement>(
      '[data-slot="tool-fallback-trigger-title-link"]',
    )
    expect(link).not.toBeNull()
    link!.click()
    expect(opened).toEqual([undefined])
  })

  it('renders no title link without the openWorkspaceDiff handle (test-harness hosts)', () => {
    render(
      (withProviders(
            createElement(Tool, {
              toolCallId: 'wd-3',
              toolName: 'WorkspaceDiff',
              args: { path: 'src/x.ts' },
              result: 'diff text',
              status: { type: 'complete' },
            }),
          ) as ReactElement),
    )
    expect(
      document.querySelector('[data-slot="tool-fallback-trigger-title-link"]'),
    ).toBeNull()
  })
})

describe('SendMessage card — recipient row, message body behind the ">"', () => {
  const MESSAGE = 'Rebase onto main, then re-run the e2e suite.'

  it('a historical row with stripped args recovers "SendMessage: <to>"', async () => {
    // Same class of bug as Read/Write above: a team session persisted before
    // the `{ to }` slim preview existed carries no recipient in the transcript,
    // so the row would sit at a bare "SendMessage" with no jump.
    const load = vi.fn(async (toolCallId: string) => ({
      toolCallId,
      toolName: 'SendMessage',
      args: { to: 'worker-a', message: MESSAGE, team: 't1' },
    }))
    render(
      withProviders(
        createElement(Tool, {
          toolCallId: 'hist-send-1',
          toolName: 'SendMessage',
          args: {},
          result: 'Message sent to worker-a',
          status: { type: 'complete' },
        }),
        { loadToolCallDetail: load },
      ) as ReactElement,
    )
    await waitFor(() =>
      expect(document.body.textContent).toContain('SendMessage: worker-a'),
    )
    // Recovering the recipient is also what makes the ">>" jump possible.
    expect(screen.getByTestId('send-message-jump-to-teammate')).toBeTruthy()
  })

  it('renders the message text on expand, and NOT the delivery ack', async () => {
    const load = vi.fn(async (toolCallId: string) => ({
      toolCallId,
      toolName: 'SendMessage',
      args: { to: 'worker-a', message: MESSAGE, team: 't1' },
    }))
    render(
      withProviders(
        createElement(Tool, {
          toolCallId: 'send-expand-1',
          toolName: 'SendMessage',
          // The live/slim transcript shape: the recipient preview only.
          args: { to: 'worker-a' },
          result: 'Message sent to worker-a',
          status: { type: 'complete' },
        }),
        { loadToolCallDetail: load },
      ) as ReactElement,
    )

    // Collapsed: one line, no body.
    expect(screen.queryByTestId('send-message-body')).toBeNull()
    expect(document.body.textContent).toContain('SendMessage: worker-a')

    fireEvent.click(screen.getByTestId('tool-row-SendMessage'))

    await waitFor(() =>
      expect(screen.getByTestId('send-message-body').textContent).toContain(
        MESSAGE,
      ),
    )
    // The expand shows the message and nothing else: no `team` arg, and no
    // one-line ack under it.
    expect(document.body.textContent).not.toContain('Message sent to worker-a')
    expect(screen.getByTestId('send-message-body').textContent).not.toContain(
      't1',
    )
  })
})
