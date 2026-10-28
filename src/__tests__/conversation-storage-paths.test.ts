import { describe, expect, it } from 'vitest'
import {
  FORCED_FOLDER_TEMPLATE_TYPE,
  FORCED_FOLDER_TEMPLATE_TYPES,
  SLUG_MAX_CHARS,
  getConversationSessionDirectoryPath,
  getConversationSkillEventsPath,
  userDataRoot,
  getNexusWorkspaceDir,
  getNexusWorkspaceDirForType,
  projectHomeFor,
  projectsHome,
  isForcedFolderTemplateType,
  isPerTypeSharedTemplateType,
  resolveSessionStorageBase,
  projectFolderKey,
} from '../utils/conversationStoragePaths'

describe('projectFolderKey', () => {
  it('replaces every non-alphanumeric char with a dash', () => {
    expect(projectFolderKey('D:\\project\\Maxh')).toBe('D--project-Maxh')
    expect(projectFolderKey('/Users/foo/my-project')).toBe('-Users-foo-my-project')
    expect(projectFolderKey('plugin:name:server')).toBe('plugin-name-server')
  })

  it('leaves a short already-safe name unchanged', () => {
    expect(projectFolderKey('main')).toBe('main')
  })

  it('truncates + hashes paths over the length cap (deterministic)', () => {
    const long = 'C:\\' + 'a/'.repeat(300)
    const out = projectFolderKey(long)
    expect(out.length).toBeLessThanOrEqual(SLUG_MAX_CHARS + 12)
    expect(projectFolderKey(long)).toBe(out) // stable across calls
  })
})

describe('getConversationSkillEventsPath', () => {
  it('is a skill-events.json sibling in the session directory', () => {
    const dir = getConversationSessionDirectoryPath('/home/.velloc/projects/p', 's1')
    expect(getConversationSkillEventsPath('/home/.velloc/projects/p', 's1')).toBe(
      `${dir}/skill-events.json`,
    )
  })
})

describe('home-anchored project roots (projectsHome / projectHomeFor)', () => {
  it('config home + projects root sit under <home>/.velloc', () => {
    expect(userDataRoot('C:\\Users\\me')).toBe('C:\\Users\\me\\.velloc')
    expect(projectsHome('C:\\Users\\me')).toBe(
      'C:\\Users\\me\\.velloc\\projects',
    )
  })

  it('projectHomeFor groups by sanitized projectRoot (trailing sep trimmed)', () => {
    expect(projectHomeFor('C:\\Users\\me', 'D:\\project\\Maxh\\')).toBe(
      'C:\\Users\\me\\.velloc\\projects\\D--project-Maxh',
    )
  })

  it('workspace (unbound sandbox) is <home>/.velloc/shared-workspace', () => {
    expect(getNexusWorkspaceDir('C:\\Users\\me')).toBe(
      'C:\\Users\\me\\.velloc\\shared-workspace',
    )
  })

  it('uses POSIX separators when the home dir is POSIX', () => {
    expect(projectHomeFor('/home/me', '/home/me/.velloc/shared-workspace')).toBe(
      '/home/me/.velloc/projects/-home-me--velloc-shared-workspace',
    )
  })
})

describe('per-type-shared default project roots', () => {
  it('FORCED_FOLDER_TEMPLATE_TYPE stays the canonical "code" string', () => {
    // The primary forced-folder type (e.g. the project-menu one-click shortcut);
    // shared with createBrowserRuntime's usedSandboxProjectRoot gate so the two
    // never disagree.
    expect(FORCED_FOLDER_TEMPLATE_TYPE).toBe('code')
  })

  it('FORCED_FOLDER_TEMPLATE_TYPES = code + safe_code + team (all bind a real folder)', () => {
    // `safe_code` is the experimental clone of `code` and shares its
    // must-bind-a-folder behavior; a `team` lead reviews diffs and spawns git
    // worktrees off the bound repo — see isForcedFolderTemplateType.
    expect([...FORCED_FOLDER_TEMPLATE_TYPES].sort()).toEqual([
      'code',
      'safe_code',
      'team',
    ])
    expect(isForcedFolderTemplateType('code')).toBe(true)
    expect(isForcedFolderTemplateType('safe_code')).toBe(true)
    expect(isForcedFolderTemplateType('team')).toBe(true)
    expect(isForcedFolderTemplateType('agent')).toBe(false)
    expect(isForcedFolderTemplateType('chat')).toBe(false)
    expect(isForcedFolderTemplateType(undefined)).toBe(false)
  })

  it('a plugin type is forced-folder only when its manifest says projectFolder "required"', () => {
    const plugins = [
      { type: 'nebius:safecode', projectFolder: 'required' as const },
      { type: 'acme:notes' },
    ]
    expect(isForcedFolderTemplateType('nebius:safecode', plugins)).toBe(true)
    expect(isForcedFolderTemplateType('acme:notes', plugins)).toBe(false)
    expect(isForcedFolderTemplateType('nebius:safecode')).toBe(false)
    expect(isForcedFolderTemplateType('code', plugins)).toBe(true)
  })

  it('isPerTypeSharedTemplateType: any safe-named non-forced type → true (rule, not a list)', () => {
    // The live types: agent/chat get a per-type shared root; code/safe_code do not.
    expect(isPerTypeSharedTemplateType('agent')).toBe(true)
    expect(isPerTypeSharedTemplateType('chat')).toBe(true)
    // The forced types are excluded.
    expect(isPerTypeSharedTemplateType('code')).toBe(false)
    expect(isPerTypeSharedTemplateType('safe_code')).toBe(false)
    expect(isPerTypeSharedTemplateType(FORCED_FOLDER_TEMPLATE_TYPE)).toBe(false)
    // No hardcoded list → a future safe-named type works automatically; the
    // phantom 'project' is NOT special-cased anywhere (it just isn't produced).
    expect(isPerTypeSharedTemplateType('research')).toBe(true)
    // Absent / unsafe (injection, uppercase, dots, slashes) → false (bare).
    expect(isPerTypeSharedTemplateType(undefined)).toBe(false)
    expect(isPerTypeSharedTemplateType('')).toBe(false)
    expect(isPerTypeSharedTemplateType('../etc')).toBe(false)
    expect(isPerTypeSharedTemplateType('..')).toBe(false)
    expect(isPerTypeSharedTemplateType('a/b')).toBe(false)
    expect(isPerTypeSharedTemplateType('Agent')).toBe(false)
  })

  it('getNexusWorkspaceDirForType: per-type subdir for shared types, bare otherwise', () => {
    expect(getNexusWorkspaceDirForType('C:\\Users\\me', 'agent')).toBe(
      'C:\\Users\\me\\.velloc\\shared-workspace\\agent',
    )
    expect(getNexusWorkspaceDirForType('/home/me', 'chat')).toBe(
      '/home/me/.velloc/shared-workspace/chat',
    )
    // code / unsafe / absent fall back to the bare shared-workspace.
    expect(getNexusWorkspaceDirForType('/home/me', 'code')).toBe(
      getNexusWorkspaceDir('/home/me'),
    )
    expect(getNexusWorkspaceDirForType('/home/me', '../etc')).toBe(
      getNexusWorkspaceDir('/home/me'),
    )
    expect(getNexusWorkspaceDirForType('/home/me', undefined)).toBe(
      getNexusWorkspaceDir('/home/me'),
    )
  })

  it('a per-type root groups its transcripts under projects/<projectFolderKey(...)>', () => {
    // Mirrors the user-stated expected memory/transcript slug for the chat type.
    const home = 'C:\\Users\\alice'
    const chatRoot = getNexusWorkspaceDirForType(home, 'chat')
    expect(projectHomeFor(home, chatRoot)).toBe(
      'C:\\Users\\alice\\.velloc\\projects\\C--Users-alice--velloc-shared-workspace-chat',
    )
  })
})

describe('resolveSessionStorageBase', () => {
  it('prefers the routed base over re-deriving from projectRoot', () => {
    // A teammate's base is nested under its lead; projectRoot cannot say so.
    expect(
      resolveSessionStorageBase({
        storageBase: '/home/.velloc/projects/D--proj/lead/teammates',
        homeDir: '/home',
        projectRoot: 'D:/proj',
      }),
    ).toBe('/home/.velloc/projects/D--proj/lead/teammates')
  })

  it('falls back to the projectRoot-derived dir when no base was routed', () => {
    expect(
      resolveSessionStorageBase({ homeDir: '/home', projectRoot: 'D:/proj' }),
    ).toBe(projectHomeFor('/home', 'D:/proj'))
    expect(
      resolveSessionStorageBase({
        storageBase: '',
        homeDir: '/home',
        projectRoot: 'D:/proj',
      }),
    ).toBe(projectHomeFor('/home', 'D:/proj'))
  })

  it('is undefined with neither a base nor a home dir', () => {
    expect(resolveSessionStorageBase({ projectRoot: 'D:/proj' })).toBeUndefined()
  })
})
