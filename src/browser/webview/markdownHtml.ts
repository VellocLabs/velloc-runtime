import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Markdown to HTML with the transcript's Markdown dialect; raw HTML in the source stays text. */
export function renderMarkdownHtml(markdown: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], skipHtml: true }, markdown),
  )
}
