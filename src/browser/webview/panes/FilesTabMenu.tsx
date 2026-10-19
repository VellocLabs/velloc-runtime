import { ContextMenu as ContextMenuPrimitive } from 'radix-ui'
import type { ReactElement } from 'react'

import { composerShortcutModifiers } from '@/components/assistant-ui/composer-send-shortcuts'

import { useT } from '../i18n'
import {
  FILES_MENU_CONTENT_CLASS,
  MenuGroups,
  MenuItem,
  pathItems,
  showInFolderItem,
  type FilesPathMenuActions,
} from './filesMenuParts'
import { tabMenuCloses } from './filesMenuModel'

export type FilesTabMenuActions = FilesPathMenuActions & {
  /** The strip's tabs, in order; decides which bulk closes apply. */
  tabs: readonly string[]
  /** Shows the docked tree and selects the file in it; omitted when absent. */
  onRevealInTree?: (path: string) => void
  onFind: (path: string) => void
  onCopyContents: (path: string) => void
  onReload: (path: string) => void
  onClose: (path: string) => void
  onCloseOthers: (path: string) => void
  onCloseToRight: (path: string) => void
  onCloseAll: () => void
}

/** The context menu of a Files pane tab (F-9), opened by right-clicking the tab. */
export function FilesTabMenu({
  path,
  children,
  ...actions
}: FilesTabMenuActions & { path: string; children: ReactElement }): ReactElement {
  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild>{children}</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content data-testid="files-tab-menu" className={FILES_MENU_CONTENT_CLASS}>
          <TabMenuItems path={path} actions={actions} />
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  )
}

function TabMenuItems({ path, actions }: { path: string; actions: FilesTabMenuActions }): ReactElement {
  const t = useT()
  const closes = tabMenuCloses(actions.tabs, path)
  const { modifier } = composerShortcutModifiers(typeof navigator !== 'undefined' ? navigator.platform : undefined)
  return (
    <MenuGroups
      groups={[
        pathItems(path, actions),
        [showInFolderItem(path, actions)],
        [
          actions.onRevealInTree && (
            <MenuItem
              key="reveal"
              testId="files-menu-reveal-in-tree"
              label={t('filesMenu.revealInFileTree')}
              onSelect={() => actions.onRevealInTree?.(path)}
            />
          ),
        ],
        [
          <MenuItem
            key="find"
            testId="files-menu-find"
            label={t('filesMenu.findInFile')}
            shortcut={t('filesMenu.findShortcut', { modifier })}
            onSelect={() => actions.onFind(path)}
          />,
          <MenuItem
            key="contents"
            testId="files-menu-copy-contents"
            label={t('filesMenu.copyFileContents')}
            onSelect={() => actions.onCopyContents(path)}
          />,
          <MenuItem
            key="reload"
            testId="files-menu-reload"
            label={t('filesMenu.reloadFile')}
            onSelect={() => actions.onReload(path)}
          />,
        ],
        [
          <MenuItem key="close" testId="files-menu-close" label={t('filesMenu.closeFile')} onSelect={() => actions.onClose(path)} />,
          closes.others && (
            <MenuItem
              key="others"
              testId="files-menu-close-others"
              label={t('filesMenu.closeOtherFiles')}
              onSelect={() => actions.onCloseOthers(path)}
            />
          ),
          closes.right && (
            <MenuItem
              key="right"
              testId="files-menu-close-right"
              label={t('filesMenu.closeFilesToRight')}
              onSelect={() => actions.onCloseToRight(path)}
            />
          ),
          closes.all && (
            <MenuItem key="all" testId="files-menu-close-all" label={t('filesMenu.closeAllFiles')} onSelect={actions.onCloseAll} />
          ),
        ],
      ]}
    />
  )
}
