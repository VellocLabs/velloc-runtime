import { describe, expect, it } from 'vitest'
import { BotIcon, CodeIcon, MessageCircleIcon } from 'lucide-react'
import {
  buildProjectMenuEntries,
  type ProjectMenuEntry,
} from '../browser/webview/projectMenu'
import type { ThreadLauncher } from '../browser/webview/threadLaunchers'

/**
 * The sidebar project row's ⋯ menu: which entries it carries and where the
 * separators fall. The menu itself is a portaled radix dropdown that does not
 * open under happy-dom, so this pins the composition and the e2e spec
 * pins the rendering.
 */

// The catalog order the launcher list arrives in: agent, chat, code.
const LAUNCHERS: ThreadLauncher[] = [
  {
    type: undefined,
    titleKey: 'launcher.agent',
    defaultTitleKey: 'launcher.newAgent',
    Icon: BotIcon,
    testId: 'sidebar-new-thread',
  },
  {
    type: 'chat',
    titleKey: 'launcher.chat',
    defaultTitleKey: 'launcher.newChat',
    Icon: MessageCircleIcon,
    testId: 'launcher-chat',
  },
  {
    type: 'code',
    titleKey: 'launcher.code',
    defaultTitleKey: 'launcher.newCode',
    Icon: CodeIcon,
    testId: 'launcher-code',
  },
]

const ALL = {
  launchers: LAUNCHERS,
  canLaunch: true,
  canReveal: true,
  canCopyPath: true,
  canDelete: true,
}

/** Entry kinds, with launchers named by the template type they create. */
function shape(entries: ProjectMenuEntry[]): string[] {
  return entries.map(entry =>
    entry.kind === 'launcher'
      ? `launcher:${entry.launcher.type ?? 'agent'}`
      : entry.kind,
  )
}

describe('buildProjectMenuEntries', () => {
  it('lists every launcher — code included — then the actions, then delete', () => {
    // `code` also has a one-click button beside the ⋯, but it stays in the
    // menu: the menu offers every launcher the catalog does.
    expect(shape(buildProjectMenuEntries(ALL))).toEqual([
      'launcher:agent',
      'launcher:chat',
      'launcher:code',
      'separator',
      'reveal',
      'copyPath',
      'separator',
      'delete',
    ])
  })

  it('separates the launcher group from the actions and delete from both', () => {
    const entries = buildProjectMenuEntries(ALL)
    const separators = entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.kind === 'separator')
      .map(({ index }) => index)
    // Exactly two rules: after the three launchers, and above delete.
    expect(separators).toEqual([3, 6])
    expect(entries[entries.length - 1]!.kind).toBe('delete')
  })

  it('never opens or closes with a separator when a group is missing', () => {
    // No launch callback → the menu starts at reveal, with no leading rule.
    expect(
      shape(buildProjectMenuEntries({ ...ALL, canLaunch: false })),
    ).toEqual(['reveal', 'copyPath', 'separator', 'delete'])
    // No delete → no trailing rule.
    expect(
      shape(buildProjectMenuEntries({ ...ALL, canDelete: false })),
    ).toEqual([
      'launcher:agent',
      'launcher:chat',
      'launcher:code',
      'separator',
      'reveal',
      'copyPath',
    ])
    // Middle group gone entirely → launchers and delete share one rule.
    expect(
      shape(
        buildProjectMenuEntries({
          ...ALL,
          canReveal: false,
          canCopyPath: false,
        }),
      ),
    ).toEqual([
      'launcher:agent',
      'launcher:chat',
      'launcher:code',
      'separator',
      'delete',
    ])
  })

  it('emits no separator at all when only one group survives', () => {
    expect(
      shape(
        buildProjectMenuEntries({
          ...ALL,
          canReveal: false,
          canCopyPath: false,
          canDelete: false,
        }),
      ),
    ).toEqual(['launcher:agent', 'launcher:chat', 'launcher:code'])
    expect(
      buildProjectMenuEntries({
        launchers: [],
        canLaunch: true,
        canReveal: false,
        canCopyPath: false,
        canDelete: false,
      }),
    ).toEqual([])
  })

  it('drops the launcher group when the catalog is empty, without a stray rule', () => {
    // `canLaunch` true but nothing to launch — an empty group is still empty.
    expect(shape(buildProjectMenuEntries({ ...ALL, launchers: [] }))).toEqual([
      'reveal',
      'copyPath',
      'separator',
      'delete',
    ])
  })
})
