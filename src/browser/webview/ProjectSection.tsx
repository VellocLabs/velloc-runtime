/**
 * The sidebar's "Projects" node. Reads no filesystem: `buildProjectTree` derives the tree
 * from the session summaries (`metadata.projectRoot`) plus `projectsStorage`.
 */
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  MoreHorizontalIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react'
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui'
import { useCallback, useMemo, useState } from 'react'
import { FORCED_FOLDER_TEMPLATE_TYPE } from '../../utils/conversationStoragePaths'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useT } from './i18n'
import { buildProjectMenuEntries } from './projectMenu'
import { buildProjectTree, type ProjectNode } from './projectTree'
import {
  readProjectsCollapsed,
  writeProjectsCollapsed,
} from './projectsStorage'
import {
  filterLaunchers,
  getThreadLaunchers,
  launcherTemplateType,
  launcherTitle,
} from './threadLaunchers'
import { useCapabilities } from './useCan'
import {
  SIDEBAR_ROW_HEIGHT,
  SessionRowList,
  type SessionListItem,
  type SessionRowEditing,
} from './SessionRows'
import { ungroupedView } from './sessionListView'
import { pinnedFirst } from './sessionPinning'

export type ProjectSectionProps = {
  sessions: SessionListItem[]
  activeSessionId: string
  /** Paths of projects the user added that may not have sessions yet. */
  addedProjectPaths: string[]
  /** `path → addedAt`, so projects with no sessions order newest-first. */
  addedProjectOrder: ReadonlyMap<string, number>
  onAddProject?: () => void
  onDeleteProject?: (path: string, sessionCount: number) => void
  onRevealProject?: (path: string) => void
  onCopyProjectPath?: (path: string) => void
  /** Create a session of `templateType` bound to `projectRoot`. */
  onLaunchInProject?: (projectRoot: string, templateType: string) => void
  onSwitchThread?: (sessionId: string) => void
  onDeleteThread?: (sessionId: string) => void
  onRenameThread?: (sessionId: string, title: string) => void
  onPinThread?: (sessionId: string, pinned: boolean) => void
  onForkThread?: (sessionId: string) => void
  /** Inline-rename state, shared with Recents so both copies of a session agree. */
  editing?: SessionRowEditing
  onEditingChange?: (next: SessionRowEditing) => void
}

export function ProjectSection({
  sessions,
  activeSessionId,
  addedProjectPaths,
  addedProjectOrder,
  onAddProject: onAddProjectProp,
  onDeleteProject: onDeleteProjectProp,
  onRevealProject: onRevealProjectProp,
  onCopyProjectPath,
  onLaunchInProject,
  onSwitchThread,
  onDeleteThread,
  onRenameThread,
  onPinThread,
  onForkThread,
  editing,
  onEditingChange,
}: ProjectSectionProps) {
  const t = useT()
  // Two controls here act on the HOST machine, not the runtime: "+" opens the
  // host's folder picker (`ui.pickProjectFolder`) and registers the brand-new
  // host path it returns (`workspace.addProject`); a project's "Show in
  // Explorer" opens the host's file manager (`ui.revealProjectFolder`). All
  // three are `full`, so a scoped connection gets neither control instead of
  // one that is refused when clicked. A `full` grant and a tree with no
  // capability provider both answer true, so the desktop sidebar is unchanged.
  const capabilities = useCapabilities()
  const onAddProject =
    capabilities.can('ui', 'pickProjectFolder') &&
    capabilities.can('workspace', 'addProject')
      ? onAddProjectProp
      : undefined
  const onRevealProject = capabilities.can('ui', 'revealProjectFolder')
    ? onRevealProjectProp
    : undefined
  // Delete deletes the folder's sessions (`session.delete`, `control`) and then
  // forgets the folder (`workspace.removeProject`, `manager`). A control grant
  // could do the first half only. The runtime refused the second, so a folder
  // the user had added came back empty on the next workspace update. The whole
  // action therefore needs the forget; a session can still be deleted from its
  // own row.
  const onDeleteProject = capabilities.can('workspace', 'removeProject')
    ? onDeleteProjectProp
    : undefined
  // Collapsed by DEFAULT — see `readProjectsCollapsed`.
  const [collapsed, setCollapsed] = useState<boolean>(readProjectsCollapsed)
  // Which project nodes are open: in-memory and empty at startup — every project starts
  // collapsed, with no auto-expand.
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  )

  const applyCollapsed = useCallback((next: boolean) => {
    setCollapsed(next)
    writeProjectsCollapsed(next)
  }, [])

  // Building the tree is pure array work over data already in memory, but it is
  // still O(sessions) per render — memoized on the same inputs the sidebar
  // already keeps referentially stable across session switches.
  //
  // Skipped entirely while collapsed: a collapsed section renders only its
  // header, so there is nothing to group. This is what "collapsed does not load
  // its children" buys — with the tree derived rather than fetched, the saving
  // is render work rather than IO.
  const tree = useMemo(
    () =>
      collapsed
        ? []
        : buildProjectTree(sessions, addedProjectPaths, addedProjectOrder),
    [collapsed, sessions, addedProjectPaths, addedProjectOrder],
  )

  const toggleProject = useCallback((path: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  // Every launcher the catalog offers. NOT filtered on `launcher.type`: the
  // Agent launcher carries `type: undefined` on purpose (it doubles as "New
  // Thread"), so filtering on truthiness would drop Agent from the project
  // menu entirely. `launcherTemplateType` resolves it back to 'agent'.
  const projectLaunchers = useMemo(
    () => filterLaunchers(getThreadLaunchers(), 'projectMenu'),
    [],
  )

  return (
    <div className="flex shrink-0 flex-col gap-1">
      {/* Section header: label + collapse chevron on the left, the
          add-workspace folder button on the right. Not a session row (no `span.min-w-0.flex-1`), so the e2e
          row-count harness ignores it. */}
      <div className="flex w-full items-center pr-1">
        <button
          type="button"
          data-testid="sidebar-projects-toggle"
          aria-expanded={!collapsed}
          onClick={() => applyCollapsed(!collapsed)}
          onKeyDown={e => {
            if (e.key === 'ArrowRight') {
              e.preventDefault()
              applyCollapsed(false)
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
              e.preventDefault()
              applyCollapsed(true)
            }
          }}
          className="flex min-w-0 flex-1 select-none items-center rounded-md px-3 pb-1 pt-3 text-start text-caption font-medium uppercase tracking-wider text-muted-foreground/70 transition-colors hover:text-muted-foreground"
        >
          {t('sidebar.projects')}
          {collapsed && (
            <ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
          )}
        </button>
        {onAddProject && (
          <button
            type="button"
            data-testid="sidebar-add-project"
            aria-label={t('sidebar.addProject')}
            title={t('sidebar.addProject')}
            onClick={() => {
              // Adding while collapsed would drop the new project straight
              // out of view; open the section so the user sees the result.
              applyCollapsed(false)
              onAddProject()
            }}
            className="mt-2 shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
          >
            {/* Folder-with-plus, not a bare "+": the section adds a *folder*
                from disk, and the glyph says so before the tooltip does. */}
            <FolderPlusIcon className="size-3.5" />
          </button>
        )}
      </div>

      {/* Collapsed → no children rendered at all. */}
      {!collapsed &&
        tree.map(node => (
          <ProjectRow
            key={node.path}
            node={node}
            activeSessionId={activeSessionId}
            expanded={expandedPaths.has(node.path)}
            onToggle={() => toggleProject(node.path)}
            launchers={projectLaunchers}
            onDeleteProject={onDeleteProject}
            onRevealProject={onRevealProject}
            onCopyProjectPath={onCopyProjectPath}
            onLaunchInProject={onLaunchInProject}
            onSwitchThread={onSwitchThread}
            onDeleteThread={onDeleteThread}
            onRenameThread={onRenameThread}
            onPinThread={onPinThread}
            onForkThread={onForkThread}
            editing={editing}
            onEditingChange={onEditingChange}
          />
        ))}

      {!collapsed && tree.length === 0 && (
        <p
          data-testid="sidebar-projects-empty"
          className="px-3 py-1 text-caption leading-relaxed text-muted-foreground/60"
        >
          {t('sidebar.projectsEmpty')}
        </p>
      )}
    </div>
  )
}

type ProjectRowProps = {
  node: ProjectNode<SessionListItem>
  activeSessionId: string
  expanded: boolean
  onToggle: () => void
  launchers: ReturnType<typeof getThreadLaunchers>
  onDeleteProject?: (path: string, sessionCount: number) => void
  onRevealProject?: (path: string) => void
  onCopyProjectPath?: (path: string) => void
  onLaunchInProject?: (projectRoot: string, templateType: string) => void
  onSwitchThread?: (sessionId: string) => void
  onDeleteThread?: (sessionId: string) => void
  onRenameThread?: (sessionId: string, title: string) => void
  onPinThread?: (sessionId: string, pinned: boolean) => void
  onForkThread?: (sessionId: string) => void
  editing?: SessionRowEditing
  onEditingChange?: (next: SessionRowEditing) => void
}

function ProjectRow({
  node,
  activeSessionId,
  expanded,
  onToggle,
  launchers,
  onDeleteProject,
  onRevealProject,
  onCopyProjectPath,
  onLaunchInProject,
  onSwitchThread,
  onDeleteThread,
  onRenameThread,
  onPinThread,
  onForkThread,
  editing,
  onEditingChange,
}: ProjectRowProps) {
  const t = useT()
  const FolderGlyph = expanded ? FolderOpenIcon : FolderIcon
  // Tracked so the hover actions stay on screen while the ⋯ menu is open. The
  // menu is portal'd, so moving the pointer from the trigger onto a menu item
  // leaves the row and ends `:hover` — without this the buttons would vanish
  // out from under the pointer mid-selection. Kept as state (rather than a
  // `:has([data-state=open])` variant) so both buttons react, not just the
  // trigger that carries Radix's own `data-state`.
  const [menuOpen, setMenuOpen] = useState(false)
  // The code launcher ALSO gets its own one-click button beside the ⋯ — it is
  // the common case for a project row. It stays in the menu all the same, so
  // the menu lists every launcher the catalog offers and a user who opens it
  // never has to notice the shortcut. Falls back gracefully if a catalog has no
  // `code` type (no button; the menu is unaffected).
  const codeLauncher = launchers.find(
    launcher => launcherTemplateType(launcher) === FORCED_FOLDER_TEMPLATE_TYPE,
  )
  const CodeGlyph = codeLauncher?.Icon
  // Order + separators live in `projectMenu.ts`; see the note there on why.
  const menuEntries = useMemo(
    () =>
      buildProjectMenuEntries({
        launchers,
        canLaunch: Boolean(onLaunchInProject),
        canReveal: Boolean(onRevealProject),
        canCopyPath: Boolean(onCopyProjectPath),
        canDelete: Boolean(onDeleteProject),
      }),
    [
      launchers,
      onLaunchInProject,
      onRevealProject,
      onCopyProjectPath,
      onDeleteProject,
    ],
  )
  return (
    <>
      <div className="group relative">
        <button
          type="button"
          data-testid="sidebar-project-row"
          data-project-path={node.path}
          data-expanded={expanded || undefined}
          // The full path is the tooltip — the label is only the basename, and
          // two projects can share one.
          title={node.path}
          aria-expanded={expanded}
          onClick={onToggle}
          className={cn(
            'relative flex w-full items-center gap-1.5 rounded-lg px-3 text-start text-body transition-[background-color,padding] hover:bg-muted group-hover:pr-8',
            SIDEBAR_ROW_HEIGHT,
          )}
        >
          {expanded ? (
            <ChevronDownIcon
              aria-hidden
              className="size-3 shrink-0 text-muted-foreground/60"
            />
          ) : (
            <ChevronRightIcon
              aria-hidden
              className="size-3 shrink-0 text-muted-foreground/60"
            />
          )}
          <FolderGlyph
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground/70"
          />
          {/* Deliberately NOT `span.min-w-0.flex-1` — that shape is how the e2e
              harness identifies a SESSION row, and a project is not one. */}
          <span className="min-w-0 flex-[1_1_0%] truncate leading-tight">
            {node.name}
          </span>
        </button>

        {/* Hover actions, right-aligned: a one-click "new code session", then
            the ⋯ menu. `menuOpen` keeps BOTH on screen while the menu is up —
            the menu is portal'd, so the pointer travelling to an item leaves
            the row and would otherwise drop them mid-selection. */}
        <div
          data-testid="sidebar-project-hover-actions"
          className={cn(
            'absolute right-1.5 top-1/2 -translate-y-1/2 items-center gap-0.5',
            // One display class at a time: `hidden` and `flex` are the same
            // specificity, so relying on source order to break the tie is a
            // coin flip.
            menuOpen ? 'flex' : 'hidden group-hover:flex',
          )}
        >
          {onLaunchInProject && codeLauncher && CodeGlyph && (
            <button
              type="button"
              data-testid="sidebar-project-new-code"
              aria-label={t('sidebar.projectNewCodeAria', { name: node.name })}
              title={t('sidebar.projectNewCodeAria', { name: node.name })}
              onClick={e => {
                // Never let the click fall through to the row's expand toggle.
                e.stopPropagation()
                onLaunchInProject(
                  node.path,
                  launcherTemplateType(codeLauncher),
                )
              }}
              className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
            >
              <CodeGlyph className="size-3.5" />
            </button>
          )}
          <DropdownMenuPrimitive.Root open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuPrimitive.Trigger asChild>
              <button
                type="button"
                data-testid="sidebar-project-actions"
                aria-label={t('sidebar.projectActionsAria', {
                  name: node.name,
                })}
                onClick={e => e.stopPropagation()}
                className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
              >
                <MoreHorizontalIcon className="size-3.5" />
              </button>
            </DropdownMenuPrimitive.Trigger>
          <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content
              align="end"
              sideOffset={4}
              onCloseAutoFocus={e => e.preventDefault()}
              className="z-50 min-w-[10rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            >
              {menuEntries.map((entry, index) => {
                switch (entry.kind) {
                  case 'separator':
                    return (
                      <DropdownMenuPrimitive.Separator
                        // Purely decorative and index-keyed on purpose: a
                        // separator has no identity of its own, and the list
                        // only changes shape when a callback appears or goes.
                        key={`separator-${index}`}
                        className="-mx-1 my-1 h-px bg-border"
                      />
                    )
                  case 'launcher': {
                    const { launcher } = entry
                    const Icon = launcher.Icon
                    return (
                      <DropdownMenuPrimitive.Item
                        key={launcher.testId}
                        asChild
                        onSelect={() =>
                          onLaunchInProject?.(
                            node.path,
                            launcherTemplateType(launcher),
                          )
                        }
                      >
                        <button
                          type="button"
                          data-testid={`sidebar-project-launch-${launcherTemplateType(
                            launcher,
                          )}`}
                          className="flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-start text-body outline-none hover:bg-muted focus:bg-muted data-[highlighted]:bg-muted"
                        >
                          <Icon className="size-4" />
                          {launcherTitle(launcher, t)}
                        </button>
                      </DropdownMenuPrimitive.Item>
                    )
                  }
                  case 'reveal':
                    return (
                      <DropdownMenuPrimitive.Item
                        key="reveal"
                        asChild
                        onSelect={() => onRevealProject?.(node.path)}
                      >
                        <button
                          type="button"
                          data-testid="sidebar-project-reveal"
                          className="flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-start text-body outline-none hover:bg-muted focus:bg-muted data-[highlighted]:bg-muted"
                        >
                          <FolderOpenIcon className="size-4" />
                          {t('sidebar.projectReveal')}
                        </button>
                      </DropdownMenuPrimitive.Item>
                    )
                  case 'copyPath':
                    return (
                      <DropdownMenuPrimitive.Item
                        key="copy-path"
                        asChild
                        onSelect={() => onCopyProjectPath?.(node.path)}
                      >
                        <button
                          type="button"
                          data-testid="sidebar-project-copy-path"
                          className="flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-start text-body outline-none hover:bg-muted focus:bg-muted data-[highlighted]:bg-muted"
                        >
                          <CopyIcon className="size-4" />
                          {t('sidebar.projectCopyPath')}
                        </button>
                      </DropdownMenuPrimitive.Item>
                    )
                  case 'delete':
                    return (
                      <DropdownMenuPrimitive.Item
                        key="delete"
                        asChild
                        onSelect={() =>
                          onDeleteProject?.(node.path, node.sessions.length)
                        }
                      >
                        <button
                          type="button"
                          data-testid="sidebar-project-delete"
                          className="flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-start text-body text-destructive outline-none hover:bg-destructive/10 focus:bg-destructive/10 data-[highlighted]:bg-destructive/10"
                        >
                          <Trash2Icon className="size-4" />
                          {t('sidebar.projectDelete')}
                        </button>
                      </DropdownMenuPrimitive.Item>
                    )
                }
              })}
            </DropdownMenuPrimitive.Content>
            </DropdownMenuPrimitive.Portal>
          </DropdownMenuPrimitive.Root>
        </div>
      </div>

      {/* Collapsed project → children are not rendered.
          The wrapper scopes "rows belonging to THIS project" for tests and for
          anything that needs to tell a project's copy of a session row apart
          from the same session's row under Recents. */}
      {expanded && (
        <div
          data-testid="sidebar-project-child"
          data-project-path={node.path}
          className="flex flex-col gap-1"
        >
          {node.sessions.length > 0 ? (
            <SessionRowList
              groups={ungroupedView(pinnedFirst(node.sessions))}
              activeSessionId={activeSessionId}
              onSwitchThread={onSwitchThread}
              onDeleteThread={onDeleteThread}
              onRenameThread={onRenameThread}
              onPinThread={onPinThread}
              onForkThread={onForkThread}
              editing={editing}
              onEditingChange={onEditingChange}
              indented
              scope={`project:${node.path}`}
            />
          ) : (
            <p
              data-testid="sidebar-project-empty"
              className={cn(
                'py-1 pl-7 pr-3 text-caption leading-relaxed text-muted-foreground/60',
              )}
            >
              {t('sidebar.projectNoThreads')}
            </p>
          )}
        </div>
      )}
    </>
  )
}
