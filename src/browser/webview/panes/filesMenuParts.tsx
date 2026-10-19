import { ChevronRightIcon } from 'lucide-react'
import { ContextMenu as ContextMenuPrimitive } from 'radix-ui'
import { Fragment, type ReactElement, type ReactNode } from 'react'

import { writeClipboard } from '@/utils/clipboard'
import { baseName } from '@/utils/paths'

import { useT } from '../i18n'
import { relativeToRoots, showInFolderLabel } from './filesMenuModel'

/** The Files pane's menus (F-9): rows and content shared by the row and tab menus. */
export const FILES_MENU_ITEM_CLASS =
  'flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-start text-body outline-none data-[highlighted]:bg-muted data-[state=open]:bg-muted'

export const FILES_MENU_CONTENT_CLASS =
  'z-50 min-w-[12rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md'

const SEPARATOR_CLASS = '-mx-1 my-1 h-px bg-border'

/** The item groups that have items, a separator between each two. */
export function MenuGroups({ groups }: { groups: readonly (readonly ReactNode[])[] }): ReactElement {
  const present = groups.map(group => group.filter(Boolean)).filter(group => group.length > 0)
  return (
    <>
      {present.map((group, index) => (
        <Fragment key={index}>
          {index > 0 && <ContextMenuPrimitive.Separator className={SEPARATOR_CLASS} />}
          {group}
        </Fragment>
      ))}
    </>
  )
}

export function MenuItem({
  testId,
  label,
  shortcut,
  onSelect,
}: {
  testId: string
  label: string
  shortcut?: string
  onSelect: () => void
}): ReactElement {
  return (
    <ContextMenuPrimitive.Item data-testid={testId} onSelect={onSelect} className={FILES_MENU_ITEM_CLASS}>
      <span className="flex-1">{label}</span>
      {shortcut && <kbd className="ps-4 font-sans text-caption text-muted-foreground">{shortcut}</kbd>}
    </ContextMenuPrimitive.Item>
  )
}

export type FilesPathMenuActions = {
  /** The session's folders; *Relative path* is omitted for a path outside them. */
  roots: readonly string[]
  /** Adds the path to the composer; omitted when absent. */
  onAttach?: (path: string) => void
  /** Reveals the path in the OS file manager; omitted when absent. */
  onShowInFolder?: (path: string) => void
}

/** *Attach as context* and the *Copy* submenu, as one group. */
export function pathItems(path: string, actions: FilesPathMenuActions): ReactNode[] {
  return [
    actions.onAttach && <AttachItem key="attach" path={path} onAttach={actions.onAttach} />,
    <CopyPathSubmenu key="copy" path={path} roots={actions.roots} />,
  ]
}

/** *Show in Explorer / Finder / file manager*, when the host can reveal. */
export function showInFolderItem(path: string, actions: FilesPathMenuActions): ReactNode {
  return actions.onShowInFolder && <ShowInFolderItem key="show" path={path} onShowInFolder={actions.onShowInFolder} />
}

function AttachItem({ path, onAttach }: { path: string; onAttach: (path: string) => void }): ReactElement {
  const t = useT()
  return <MenuItem testId="files-menu-attach" label={t('filesMenu.attach')} onSelect={() => onAttach(path)} />
}

function ShowInFolderItem({
  path,
  onShowInFolder,
}: {
  path: string
  onShowInFolder: (path: string) => void
}): ReactElement {
  const t = useT()
  const platform = typeof navigator !== 'undefined' ? navigator.platform : undefined
  return (
    <MenuItem
      testId="files-menu-show-in-folder"
      label={t(showInFolderLabel(platform))}
      onSelect={() => onShowInFolder(path)}
    />
  )
}

function CopyPathSubmenu({ path, roots }: { path: string; roots: readonly string[] }): ReactElement {
  const t = useT()
  const relative = relativeToRoots(path, roots)
  const copy = (text: string) => () => void writeClipboard(text)
  return (
    <ContextMenuPrimitive.Sub>
      <ContextMenuPrimitive.SubTrigger data-testid="files-menu-copy" className={FILES_MENU_ITEM_CLASS}>
        <span className="flex-1">{t('filesMenu.copy')}</span>
        <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground rtl:rotate-180" />
      </ContextMenuPrimitive.SubTrigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.SubContent sideOffset={6} className={FILES_MENU_CONTENT_CLASS}>
          <MenuItem testId="files-menu-copy-absolute" label={t('filesMenu.copyAbsolutePath')} onSelect={copy(path)} />
          {relative !== null && (
            <MenuItem testId="files-menu-copy-relative" label={t('filesMenu.copyRelativePath')} onSelect={copy(relative)} />
          )}
          <MenuItem testId="files-menu-copy-name" label={t('filesMenu.copyFilename')} onSelect={copy(baseName(path))} />
        </ContextMenuPrimitive.SubContent>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Sub>
  )
}
