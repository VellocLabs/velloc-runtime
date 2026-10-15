import { visit } from 'unist-util-visit'
import type { Root, Text } from 'mdast'
import type { Parent } from 'unist'

import { extractFilePathCandidates } from '@/utils/filePathDetection'

/**
 * Markdown plugin turning file paths in PROSE into `<nexus-file-path>` elements
 * (`PathChip`). Inline code is handled by the `code` component; fenced code is left
 * alone. Runs on the mdast, so it never touches text inside links or code.
 */

export const FILE_PATH_TAG = 'nexus-file-path'

type FilePathNode = Text & {
  data: {
    hName: string
    hProperties: Record<string, string>
    hChildren: Array<{ type: 'text'; value: string }>
  }
}

export function remarkFilePaths() {
  return (tree: Root): void => {
    visit(tree, 'text', (node: Text, index: number | undefined, parent: Parent | undefined) => {
      if (!parent || index === undefined) return
      // Already a link target, or the label of one — leave it be.
      if (parent.type === 'link' || parent.type === 'linkReference') return

      const candidates = extractFilePathCandidates(node.value)
      if (candidates.length === 0) return

      const replacement: Array<Text | FilePathNode> = []
      let cursor = 0
      for (const candidate of candidates) {
        if (candidate.index > cursor) {
          replacement.push({
            type: 'text',
            value: node.value.slice(cursor, candidate.index),
          })
        }
        replacement.push({
          type: 'text',
          value: candidate.raw,
          data: {
            hName: FILE_PATH_TAG,
            hProperties: {
              path: candidate.path,
              ...(candidate.line === undefined
                ? {}
                : { line: String(candidate.line) }),
            },
            hChildren: [{ type: 'text', value: candidate.raw }],
          },
        } as FilePathNode)
        cursor = candidate.index + candidate.raw.length
      }
      if (cursor < node.value.length) {
        replacement.push({ type: 'text', value: node.value.slice(cursor) })
      }

      parent.children.splice(index, 1, ...replacement)
      // Resume AFTER what we just inserted — the new nodes are already final,
      // and re-visiting them would recurse forever.
      return index + replacement.length
    })
  }
}
