import { ContextMenu as ContextMenuPrimitive } from 'radix-ui'
import { createContext, useState, type MouseEvent, type ReactElement } from 'react'

import { useT } from '../i18n'
import {
  FILES_MENU_CONTENT_CLASS,
  MenuGroups,
  MenuItem,
  pathItems,
  showInFolderItem,
  type FilesPathMenuActions,
} from './filesMenuParts'

/** The attribute a row carries to name its path to the row menu. */
export const FILES_ROW_PATH_ATTR = 'data-files-row-path'

export type FilesRowMenuActions = FilesPathMenuActions & {
  /** Shows the row in the tree; given by flat lists only. */
  onRevealInTree?: (path: string) => void
}

/** What a Files pane list offers on its rows; `null` = no row menu. */
export const FilesRowMenuContext = createContext<FilesRowMenuActions | null>(null)

/**
 * The context menu of a Files pane row (F-9): one menu for a whole list,
 * opened on the row under the pointer or the focused row. Rows mark
 * themselves with {@link FILES_ROW_PATH_ATTR}; elsewhere in the list no menu
 * opens.
 */
export function FilesRowMenu({
  children,
  ...actions
}: FilesRowMenuActions & { children: ReactElement }): ReactElement {
  const t = useT()
  const [path, setPath] = useState<string | null>(null)
  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    const row = (event.target as Element | null)?.closest?.(`[${FILES_ROW_PATH_ATTR}]`)
    const rowPath = row?.getAttribute(FILES_ROW_PATH_ATTR)
    if (!rowPath) {
      event.preventDefault()
      return
    }
    setPath(rowPath)
  }
  return (
    <ContextMenuPrimitive.Root onOpenChange={open => !open && setPath(null)}>
      <ContextMenuPrimitive.Trigger asChild onContextMenu={onContextMenu}>
        {children}
      </ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        {path !== null && (
          <ContextMenuPrimitive.Content data-testid="files-row-menu" className={FILES_MENU_CONTENT_CLASS}>
            <MenuGroups
              groups={[
                pathItems(path, actions),
                [
                  showInFolderItem(path, actions),
                  actions.onRevealInTree && (
                    <MenuItem
                      key="reveal"
                      testId="files-menu-reveal-in-tree"
                      label={t('filesMenu.revealInFileTree')}
                      onSelect={() => actions.onRevealInTree?.(path)}
                    />
                  ),
                ],
              ]}
            />
          </ContextMenuPrimitive.Content>
        )}
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  )
}
