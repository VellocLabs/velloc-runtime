// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { Root, Text } from 'mdast'

import {
  FilePathContext,
  createFilePathProbe,
  type FilePathStat,
} from '../components/assistant-ui/file-path-context'
import {
  PathChip,
  TextWithFilePaths,
} from '../components/assistant-ui/file-path-link'
import { RightPanelContentContext } from '../components/assistant-ui/right-panel-content-context'
import {
  FILE_PATH_TAG,
  remarkFilePaths,
} from '../components/assistant-ui/remarkFilePaths'

/**
 * Detected file paths get a clickable `>>` only after the host confirms the file exists: an unconfirmed path
 * renders as plain text, probing is batched and cached, and a click opens the resolved absolute path.
 */

afterEach(() => cleanup())

function renderLink(
  options: {
    path: string
    projectRoot?: string
    stats?: readonly FilePathStat[]
    openFile?: (target: { path: string }) => void
    statPaths?: (paths: string[]) => Promise<readonly FilePathStat[]>
  },
) {
  const statPaths =
    options.statPaths ??
    (async () => options.stats ?? [])
  const probe = createFilePathProbe(statPaths, { batchMs: 0 })
  return render(
    createElement(
      RightPanelContentContext.Provider,
      { value: { openFile: options.openFile } },
      createElement(
        FilePathContext.Provider,
        { value: { projectRoot: options.projectRoot, probe } },
        createElement(PathChip, { path: options.path }, options.path),
      ),
    ),
  )
}

describe('PathChip', () => {
  it('renders plain text until the host confirms the file exists', async () => {
    renderLink({
      path: 'src/a.ts',
      projectRoot: '/repo',
      stats: [{ path: '/repo/src/a.ts', isFile: false }],
    })
    expect(screen.getByText('src/a.ts')).toBeTruthy()
    // Never becomes an affordance.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(document.querySelector('[data-slot="file-path-link"]')).toBeNull()
    expect(document.body.textContent).not.toContain('>>')
  })

  it('adds the >> affordance once the host confirms a real file', async () => {
    renderLink({
      path: 'src/a.ts',
      projectRoot: '/repo',
      stats: [{ path: '/repo/src/a.ts', isFile: true }],
      openFile: () => {},
    })
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="file-path-link"]'),
      ).not.toBeNull(),
    )
    expect(
      document.querySelector('[data-slot="file-path-open-marker"]')?.textContent,
    ).toBe('>>')
  })

  it('opens the RESOLVED absolute path when clicked', async () => {
    const openFile = vi.fn()
    renderLink({
      path: 'src/a.ts',
      projectRoot: '/repo',
      stats: [{ path: '/repo/src/a.ts', isFile: true }],
      openFile,
    })
    const link = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(
        '[data-slot="file-path-link"]',
      )
      expect(el).not.toBeNull()
      return el!
    })
    link.click()
    expect(openFile).toHaveBeenCalledWith({ path: '/repo/src/a.ts' })
  })

  it('stays plain text on a host with no way to open files', async () => {
    // No `openFile` in context (embedded harness) — offering `>>` would be a
    // dead affordance, so the path renders exactly as written.
    renderLink({
      path: 'src/a.ts',
      projectRoot: '/repo',
      stats: [{ path: '/repo/src/a.ts', isFile: true }],
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(document.querySelector('[data-slot="file-path-link"]')).toBeNull()
    expect(screen.getByText('src/a.ts')).toBeTruthy()
  })

  it('stays plain text when a relative path has no project root to resolve against', async () => {
    const statPaths = vi.fn(async () => [])
    renderLink({ path: 'src/a.ts', statPaths })
    await new Promise(resolve => setTimeout(resolve, 10))
    // Nothing was even probed — no root, no guessing.
    expect(statPaths).not.toHaveBeenCalled()
    expect(document.querySelector('[data-slot="file-path-link"]')).toBeNull()
  })
})

describe('TextWithFilePaths', () => {
  it('renders text with no paths verbatim', () => {
    const { container } = render(
      createElement(TextWithFilePaths, { text: 'no paths in here at all' }),
    )
    expect(container.textContent).toBe('no paths in here at all')
    expect(container.querySelector('[data-slot="file-path-link"]')).toBeNull()
  })

  it('wraps only the path runs and keeps the surrounding text intact', async () => {
    // The user-message surface: raw text, not markdown. Once the probe
    // confirms the file, the path run gains the >> affordance; the plain
    // segments around it are byte-identical.
    const probe = createFilePathProbe(
      async paths => paths.map(path => ({ path, isFile: true })),
      { batchMs: 0 },
    )
    const { container } = render(
      createElement(
        RightPanelContentContext.Provider,
        { value: { openFile: () => {} } },
        createElement(
          FilePathContext.Provider,
          { value: { projectRoot: '/repo', probe } },
          createElement(TextWithFilePaths, {
            text: '看看 src/a.ts，还有 D:\\x\\b.cc 这两个',
          }),
        ),
      ),
    )
    await waitFor(() =>
      expect(
        container.querySelectorAll('[data-slot="file-path-link"]'),
      ).toHaveLength(2),
    )
    // Text content = original + two markers appended to the path runs.
    expect(container.textContent).toBe(
      '看看 src/a.ts>>，还有 D:\\x\\b.cc>> 这两个',
    )
  })
})

describe('createFilePathProbe', () => {
  it('collapses same-tick requests into ONE host round-trip', async () => {
    const statPaths = vi.fn(async (paths: string[]) =>
      paths.map(path => ({ path, isFile: true })),
    )
    const probe = createFilePathProbe(statPaths, { batchMs: 0 })
    const answers = await Promise.all([
      probe.check('/a.ts'),
      probe.check('/b.ts'),
      probe.check('/c.ts'),
    ])
    expect(answers).toEqual([true, true, true])
    expect(statPaths).toHaveBeenCalledTimes(1)
    expect(statPaths.mock.calls[0][0]).toEqual(['/a.ts', '/b.ts', '/c.ts'])
  })

  it('caches both answers — a path is probed at most once', async () => {
    const statPaths = vi.fn(async (paths: string[]) =>
      paths.map(path => ({ path, isFile: path === '/yes.ts' })),
    )
    const probe = createFilePathProbe(statPaths, { batchMs: 0 })
    await Promise.all([probe.check('/yes.ts'), probe.check('/no.ts')])
    expect(probe.peek('/yes.ts')).toBe(true)
    expect(probe.peek('/no.ts')).toBe(false)

    await Promise.all([probe.check('/yes.ts'), probe.check('/no.ts')])
    expect(statPaths).toHaveBeenCalledTimes(1)
  })

  it('splits an oversized batch instead of sending one giant call', async () => {
    const statPaths = vi.fn(async (paths: string[]) =>
      paths.map(path => ({ path, isFile: true })),
    )
    const probe = createFilePathProbe(statPaths, { batchMs: 0, batchMax: 2 })
    const answers = await Promise.all([
      probe.check('/a.ts'),
      probe.check('/b.ts'),
      probe.check('/c.ts'),
    ])
    expect(answers).toEqual([true, true, true])
    expect(statPaths).toHaveBeenCalledTimes(2)
    expect(statPaths.mock.calls[0][0]).toHaveLength(2)
    expect(statPaths.mock.calls[1][0]).toEqual(['/c.ts'])
  })

  it('treats a bridge failure as "not a file" rather than throwing', async () => {
    const probe = createFilePathProbe(async () => {
      throw new Error('bridge down')
    }, { batchMs: 0 })
    await expect(probe.check('/a.ts')).resolves.toBe(false)
  })

  it('does not negative-cache a bridge FAILURE — it backs off and retries', async () => {
    // One bridge hiccup must not mark every in-flight path "doesn't exist"
    // for the rest of the page. Failed answers stay uncached; while the
    // backoff window is open new checks short-circuit false without touching
    // the bridge, and after it clears the path is genuinely re-asked.
    let fail = true
    const statPaths = vi.fn(async (paths: string[]) => {
      if (fail) throw new Error('bridge down')
      return paths.map(path => ({ path, isFile: true }))
    })
    const probe = createFilePathProbe(statPaths, {
      batchMs: 0,
      failureBackoffMs: 60_000,
    })
    await expect(probe.check('/a.ts')).resolves.toBe(false)
    // Not cached — the answer was a failure, not a fact.
    expect(probe.peek('/a.ts')).toBeUndefined()
    // Inside the backoff window: resolves false with NO new bridge call.
    await expect(probe.check('/a.ts')).resolves.toBe(false)
    expect(statPaths).toHaveBeenCalledTimes(1)

    // With no backoff, a recovered bridge answers on the next check.
    const recovering = createFilePathProbe(statPaths, {
      batchMs: 0,
      failureBackoffMs: 0,
    })
    fail = false
    await expect(recovering.check('/a.ts')).resolves.toBe(true)
    expect(recovering.peek('/a.ts')).toBe(true)
  })
})

describe('remarkFilePaths', () => {
  const paragraph = (value: string): Root => ({
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
  } as Root)

  const transform = (tree: Root): Root => {
    remarkFilePaths()(tree)
    return tree
  }

  it('splits a prose path out of its surrounding text', () => {
    const tree = transform(paragraph('edit src/a/b.ts now'))
    const children = (tree.children[0] as { children: Text[] }).children
    expect(children.map(c => c.value)).toEqual(['edit ', 'src/a/b.ts', ' now'])
    const marked = children[1] as Text & { data?: { hName?: string } }
    expect(marked.data?.hName).toBe(FILE_PATH_TAG)
  })

  it('carries the parsed path and line as element properties', () => {
    const tree = transform(paragraph('see src/a.ts:42 there'))
    const children = (tree.children[0] as { children: Text[] }).children
    const marked = children[1] as Text & {
      data?: { hProperties?: Record<string, string> }
    }
    expect(marked.data?.hProperties).toMatchObject({
      path: 'src/a.ts',
      line: '42',
    })
    // The rendered text keeps the `:42` the user actually sees.
    expect(marked.value).toBe('src/a.ts:42')
  })

  it('leaves text with no path completely alone', () => {
    const tree = transform(paragraph('nothing to see here'))
    const children = (tree.children[0] as { children: Text[] }).children
    expect(children).toHaveLength(1)
    expect(
      (children[0] as Text & { data?: unknown }).data,
    ).toBeUndefined()
  })

  it('does not touch link labels', () => {
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              url: 'https://example.com',
              children: [{ type: 'text', value: 'src/a.ts' }],
            },
          ],
        },
      ],
    } as Root
    transform(tree)
    const link = (tree.children[0] as { children: Array<{ children: Text[] }> })
      .children[0]
    expect(link.children).toHaveLength(1)
    expect((link.children[0] as Text & { data?: unknown }).data).toBeUndefined()
  })
})
