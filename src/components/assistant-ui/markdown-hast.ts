import { unified, type PluggableList } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import type { Nodes, Root } from "hast";

import { remarkFilePaths } from "@/components/assistant-ui/remarkFilePaths";

/** The remark plugins of the conversation's Markdown, inline and off-thread alike. */
export const CONVERSATION_REMARK_PLUGINS: PluggableList = [remarkGfm, remarkFilePaths];

/**
 * The conversation's Markdown pipeline up to hast: the same parser, plugins
 * and remark-rehype options the Markdown renderer runs, so a tree made here
 * renders the same document (F-9).
 * Contract: pure and DOM-free; safe in a Worker. `position` is kept only on
 * `code` elements (a shell fence keys its run by its offset) and dropped
 * elsewhere to keep the tree small to clone.
 */
const processor = unified()
  .use(remarkParse)
  .use(CONVERSATION_REMARK_PLUGINS)
  .use(remarkRehype, { allowDangerousHtml: true });

export function markdownToHast(text: string): Root {
  const tree = processor.runSync(processor.parse(text)) as Root;
  dropPositions(tree);
  return tree;
}

function dropPositions(node: Nodes): void {
  if (!(node.type === "element" && node.tagName === "code")) delete node.position;
  if ("children" in node) for (const child of node.children) dropPositions(child);
}
