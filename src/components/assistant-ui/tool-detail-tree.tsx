import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { cn } from '../../lib/utils'
import { useT } from '@/browser/webview/i18n'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExpandable(value: unknown): value is Record<string, unknown> | unknown[] {
  return (
    (Array.isArray(value) && value.length > 0) ||
    (isRecord(value) && Object.keys(value).length > 0)
  )
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`
}

function formatPrimitive(value: unknown): string {
  if (typeof value === 'string') {
    return `"${truncate(value, 120)}"`
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  if (typeof value === 'bigint') {
    return `${value}n`
  }

  if (value === null) {
    return 'null'
  }

  if (value === undefined) {
    return 'undefined'
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (value instanceof URL) {
    return value.toString()
  }

  if (value instanceof URLSearchParams) {
    return truncate(
      JSON.stringify(Object.fromEntries(value.entries())),
      120,
    )
  }

  if (value instanceof Map) {
    return truncate(
      JSON.stringify(
        Array.from(value.entries()).map(([key, entry]) => ({
          key,
          value: entry,
        })),
      ),
      120,
    )
  }

  if (value instanceof Set) {
    return truncate(JSON.stringify(Array.from(value.values())), 120)
  }

  if (ArrayBuffer.isView(value)) {
    return truncate(
      JSON.stringify(
        Array.from(
          new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        ),
      ),
      120,
    )
  }

  if (value instanceof ArrayBuffer) {
    return truncate(JSON.stringify(Array.from(new Uint8Array(value))), 120)
  }

  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value)
      if (typeof json === 'string') {
        return truncate(json, 120)
      }
    } catch {
      // Fall through to the object tag fallback below.
    }

    return Object.prototype.toString.call(value)
  }

  return truncate(String(value), 120)
}

function summarizeValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.length}]`
  }

  if (isRecord(value)) {
    const keys = Object.keys(value)
    return `{${keys.length}}`
  }

  return formatPrimitive(value)
}

function getNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function getBrowserElementPreview(value: Record<string, unknown>): string | null {
  const type = getNonEmptyString(value.type)
  if (!type) {
    return null
  }

  // Current C++ wire format emits `index` (LLM-facing element id, mapped
  // internally to DOM content_node_id); older builds may still emit
  // `node_id` / `element_id` / `id`. Recognize all four so the preview
  // renders for any vintage of observation.
  const hasNodeId =
    typeof value.index === 'number' ||
    typeof value.node_id === 'number' ||
    typeof value.element_id === 'number' ||
    typeof value.id === 'number'
  if (!hasNodeId) {
    return null
  }

  const form = isRecord(value.form) ? value.form : null
  const text = getNonEmptyString(value.text)
  const title = getNonEmptyString(value.title)
  const label = getNonEmptyString(value.label)
  const placeholder = form ? getNonEmptyString(form.placeholder) : null
  const href = getNonEmptyString(value.href)
  const description =
    text ??
    title ??
    label ??
    placeholder ??
    href

  if (!description) {
    return type
  }

  const descriptionLabel =
    text ? 'text' : title ? 'title' : label ? 'label' : placeholder ? 'placeholder' : 'href'
  return `${type} ${descriptionLabel}: ${formatPrimitive(description)}`
}

function getObservationPreview(value: Record<string, unknown>): string | null {
  if (typeof value.tab_id !== 'number') {
    return null
  }

  const title = getNonEmptyString(value.title)
  const url = getNonEmptyString(value.url)
  if (title) {
    return `tab_id: ${value.tab_id} title: ${formatPrimitive(title)}`
  }
  if (url) {
    return `tab_id: ${value.tab_id} url: ${formatPrimitive(url)}`
  }
  return `tab_id: ${value.tab_id}`
}

function getTabPreview(value: Record<string, unknown>): string | null {
  const tabId =
    typeof value.tab_id === 'number'
      ? value.tab_id
      : typeof value.id === 'number'
        ? value.id
        : null
  if (tabId === null || typeof value.active !== 'boolean') {
    return null
  }

  const title = getNonEmptyString(value.title)
  const url = getNonEmptyString(value.url)
  const state = value.active ? 'active' : 'background'
  if (title) {
    return `tab ${tabId} ${state} title: ${formatPrimitive(title)}`
  }
  if (url) {
    return `tab ${tabId} ${state} url: ${formatPrimitive(url)}`
  }
  return `tab ${tabId} ${state}`
}

function getStructuredPreview(value: Record<string, unknown>): string | null {
  return (
    getBrowserElementPreview(value) ??
    getTabPreview(value) ??
    getObservationPreview(value)
  )
}

function firstChildPreview(value: unknown): string | null {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return null
    }

    const firstEntry = value[0]
    if (isRecord(firstEntry)) {
      const structuredPreview = getStructuredPreview(firstEntry)
      if (structuredPreview) {
        return `0: ${structuredPreview}`
      }
    }

    return `0: ${summarizeValue(firstEntry)}`
  }

  if (isRecord(value)) {
    const structuredPreview = getStructuredPreview(value)
    if (structuredPreview) {
      return structuredPreview
    }

    const entries = Object.entries(value)
    if (entries.length === 0) {
      return null
    }

    const [key, entry] = entries[0]!
    return `${key}: ${summarizeValue(entry)}`
  }

  return null
}

function ToolDetailTreeNode({
  label,
  value,
  depth,
  defaultExpanded = false,
}: {
  label?: string
  value: unknown
  depth: number
  defaultExpanded?: boolean
}) {
  const expandable = isExpandable(value)
  const [open, setOpen] = useState(defaultExpanded)
  const preview = useMemo(() => firstChildPreview(value), [value])

  if (!expandable) {
    return (
      <div
        className={cn(
          'flex items-start gap-2 rounded-md px-2 py-1 font-mono text-code',
          depth > 0 && 'ml-4',
        )}
      >
        {label ? (
          <span className="shrink-0 text-muted-foreground">{label}:</span>
        ) : null}
        {/* `break-all` (not `break-words`) so a long unbroken token — a base64
            blob, a URL, a long CJK run — wraps inside the row instead of
            overflowing past the parent card. */}
        <span className="min-w-0 break-all text-foreground">{formatPrimitive(value)}</span>
      </div>
    )
  }

  const entries = Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry] as const)
    : Object.entries(value)

  return (
    <div className={cn('min-w-0', depth > 0 && 'ml-4')}>
      <button
        type="button"
        onClick={() => setOpen(current => !current)}
        className="flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md px-2 py-1 font-mono text-left text-code hover:bg-muted/60"
      >
        {open ? (
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        {label ? (
          <span className="shrink-0 text-muted-foreground">{label}:</span>
        ) : null}
        <span className="shrink-0 text-foreground">{summarizeValue(value)}</span>
        {!open && preview ? (
          <span className="min-w-0 truncate text-muted-foreground">{preview}</span>
        ) : null}
      </button>
      {open ? (
        <div className="min-w-0 border-l border-border/60 py-1">
          {entries.map(([entryLabel, entryValue], index) => (
            <ToolDetailTreeNode
              key={`${entryLabel}-${index}`}
              label={entryLabel}
              value={entryValue}
              depth={depth + 1}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

// A screenshot image pulled out of a tool result for rendering.
type ExtractedImage = { src: string; mime: string }

// Build a renderable data URI from a base64 string (or pass through an
// already-formed data:/http(s) URL).
function toImageSrc(image: string, mime: string): string {
  if (
    image.startsWith('data:') ||
    image.startsWith('http://') ||
    image.startsWith('https://')
  ) {
    return image
  }
  return `data:${mime || 'image/jpeg'};base64,${image}`
}

// Recursively pull screenshot images out of a tool result, in either shape: a content
// part `{ type:'image', … }` or a raw observation's `tabs[].screenshot`. Stops at a
// screenshot leaf so no image is collected twice.
export function extractScreenshotImages(value: unknown): ExtractedImage[] {
  const out: ExtractedImage[] = []
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    const rec = node as Record<string, unknown>
    // Shape 1: content-part image block.
    if (
      rec.type === 'image' &&
      typeof rec.image === 'string' &&
      rec.image.length > 0
    ) {
      out.push({
        src: toImageSrc(
          rec.image,
          typeof rec.mimeType === 'string' ? rec.mimeType : 'image/jpeg',
        ),
        mime: typeof rec.mimeType === 'string' ? rec.mimeType : 'image/jpeg',
      })
      return
    }
    // Shape 2: raw observation screenshot leaf.
    if (typeof rec.data_base64 === 'string' && rec.data_base64.length > 0) {
      out.push({
        src: toImageSrc(
          rec.data_base64,
          typeof rec.mime === 'string' ? rec.mime : 'image/jpeg',
        ),
        mime: typeof rec.mime === 'string' ? rec.mime : 'image/jpeg',
      })
      return
    }
    for (const child of Object.values(rec)) visit(child)
  }
  visit(value)
  return out
}

// Deep-clone `value` with screenshot base64 blobs replaced by a short
// marker, so the JSON tree below the rendered image(s) stays readable
// instead of showing a wall of base64.
function stripImageBlobs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripImageBlobs)
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (
      key === 'image' &&
      value.type === 'image' &&
      typeof entry === 'string'
    ) {
      out[key] = '<screenshot rendered above>'
    } else if (key === 'data_base64' && typeof entry === 'string') {
      out[key] = '<screenshot rendered above>'
    } else {
      out[key] = stripImageBlobs(entry)
    }
  }
  return out
}

export function ToolDetailTree({
  value,
}: {
  value: unknown
}) {
  const t = useT()
  const images = useMemo(() => extractScreenshotImages(value), [value])
  // Only pay the deep-clone cost when there's actually an image to strip.
  const treeValue = useMemo(
    () => (images.length > 0 ? stripImageBlobs(value) : value),
    [images.length, value],
  )
  return (
    <div className="min-w-0 rounded-md border bg-muted/20 py-1">
      {images.length > 0 ? (
        <div className="flex flex-wrap gap-2 px-2 pb-2">
          {images.map((img, index) => (
            <a
              // eslint-disable-next-line react/no-array-index-key
              key={index}
              href={img.src}
              target="_blank"
              rel="noreferrer"
              title={t('tool.openScreenshot')}
            >
              <img
                src={img.src}
                alt={t('tool.pageScreenshot')}
                // Decode-memory control, not layout: a browser-tool screenshot
                // is a full-resolution bitmap (~4 bytes/px decoded) shown as a
                // 256px-tall thumb. `lazy` keeps off-viewport screenshots
                // (scrolled-away expanded cards; content-visibility-skipped
                // rows) undecoded until they approach, and lets the browser
                // discard their decoded data more aggressively; `async` keeps
                // the decode off the critical paint path. Zero visual change.
                loading="lazy"
                decoding="async"
                className="max-h-64 rounded border object-contain"
              />
            </a>
          ))}
        </div>
      ) : null}
      <ToolDetailTreeNode value={treeValue} depth={0} defaultExpanded />
    </div>
  )
}
