import { CheckIcon, ChevronRightIcon, EllipsisIcon } from 'lucide-react'
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui'
import type { ReactElement } from 'react'

import { useT } from '../i18n'
import {
  FILES_EDITOR_TAB_SIZES,
  isFilesEditorTabSize,
  type FilesEditorPrefs,
} from '../layout/filesEditor'
import { FILES_MENU_CONTENT_CLASS, FILES_MENU_ITEM_CLASS } from './filesMenuParts'

export type FilesOptionsMenuProps = {
  editor: FilesEditorPrefs
  onEditorChange: (change: Partial<FilesEditorPrefs>) => void
  /** The Show file tree toggle; the item is omitted without a handler. */
  treeVisible?: boolean
  onTreeVisibleChange?: (visible: boolean) => void
}

/** The Files pane's options menu (F-9), behind the ⋯ button in the pane header. */
export function FilesOptionsMenu(props: FilesOptionsMenuProps): ReactElement {
  const t = useT()
  const label = t('filesMenu.paneOptions')
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          data-testid="files-pane-options"
          aria-label={label}
          title={label}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <EllipsisIcon aria-hidden className="size-4" />
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          data-testid="files-options-menu"
          align="end"
          sideOffset={4}
          className={FILES_MENU_CONTENT_CLASS}
        >
          {props.onTreeVisibleChange && (
            <>
              <CheckItem
                testId="files-options-tree"
                label={t('filesPane.showTree')}
                shortcut={t('filesMenu.showFileTreeShortcut')}
                checked={props.treeVisible === true}
                onChange={props.onTreeVisibleChange}
              />
              <DropdownMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />
            </>
          )}
          <CheckItem
            testId="files-options-wrap"
            label={t('filesMenu.wordWrap')}
            checked={props.editor.wordWrap}
            onChange={wordWrap => props.onEditorChange({ wordWrap })}
          />
          <DropdownMenuPrimitive.Sub>
            <DropdownMenuPrimitive.SubTrigger data-testid="files-options-tab-size" className={FILES_MENU_ITEM_CLASS}>
              <span className="flex-1">{t('filesMenu.tabSize')}</span>
              <span className="text-muted-foreground">{props.editor.tabSize}</span>
              <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground rtl:rotate-180" />
            </DropdownMenuPrimitive.SubTrigger>
            <DropdownMenuPrimitive.Portal>
              <DropdownMenuPrimitive.SubContent sideOffset={6} className={FILES_MENU_CONTENT_CLASS}>
                <DropdownMenuPrimitive.RadioGroup
                  value={String(props.editor.tabSize)}
                  onValueChange={value => {
                    const size = Number(value)
                    if (isFilesEditorTabSize(size)) props.onEditorChange({ tabSize: size })
                  }}
                >
                  {FILES_EDITOR_TAB_SIZES.map(size => (
                    <DropdownMenuPrimitive.RadioItem
                      key={size}
                      value={String(size)}
                      data-testid={`files-options-tab-size:${size}`}
                      className={FILES_MENU_ITEM_CLASS}
                    >
                      <span className="flex-1">{size}</span>
                      <DropdownMenuPrimitive.ItemIndicator>
                        <CheckIcon aria-hidden className="size-4 text-primary" />
                      </DropdownMenuPrimitive.ItemIndicator>
                    </DropdownMenuPrimitive.RadioItem>
                  ))}
                </DropdownMenuPrimitive.RadioGroup>
              </DropdownMenuPrimitive.SubContent>
            </DropdownMenuPrimitive.Portal>
          </DropdownMenuPrimitive.Sub>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  )
}

/** A checkbox row that keeps the menu open. */
function CheckItem({
  testId,
  label,
  shortcut,
  checked,
  onChange,
}: {
  testId: string
  label: string
  shortcut?: string
  checked: boolean
  onChange: (checked: boolean) => void
}): ReactElement {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-testid={testId}
      checked={checked}
      onCheckedChange={value => onChange(value === true)}
      onSelect={event => event.preventDefault()}
      className={FILES_MENU_ITEM_CLASS}
    >
      <span className="flex size-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon aria-hidden className="size-4 text-primary" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      <span className="flex-1">{label}</span>
      {shortcut && <kbd className="ps-4 font-sans text-caption text-muted-foreground">{shortcut}</kbd>}
    </DropdownMenuPrimitive.CheckboxItem>
  )
}
