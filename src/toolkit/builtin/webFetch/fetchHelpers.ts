// WebFetch helpers: fetching via `network.httpGet` (browser process, so no CORS),
// caching, redirect policy, HTML→markdown and the fast-model extraction step.
// Safety comes from the redirect-safety, per-domain permission-rule and
// same-host-redirect-only layers.

import { LRUCache } from 'lru-cache'

import { getProductName } from '../../../branding/productName'
import { queryFastModel } from '../../../models/fastModelCall'
import type { ToolCallContext } from '../../toolCallContext'
import {
  fsForContext,
  processFs,
  type RuntimeFs,
} from '../../../utils/fs/runtimeFs'
import type { BrowserNetworkOperations } from '../../../utils/BrowserNetworkOperations'

import { isAutoAllowedFetch } from './autoAllowedSites'
import { pageQuestionBrief } from './fetchPrompt'

// Per-call deps from the CALLER's context: `network` over that runtime's scoped
// transport, and its project root. This module holds no state.

export type WebFetchDeps = {
  network: BrowserNetworkOperations
  /**
   * The runtime's project root (`resolvedProjectRoot` — the model's working
   * directory, e.g. `<install>/.velloc/shared-workspace/<type>/`).
   * Persisted artifacts land under `<runtimeCwd>/webfetch/`.
   */
  runtimeCwd: string
  /**
   * The runtime's own fs (`context.options.fsOperations`) the persisted
   * artifacts are written through — never the realm-global slot.
   */
  fs?: RuntimeFs
}

/**
 * Resolve the WebFetch deps from a tool-use context. Throws when the
 * runtime's host bridge does not expose the `network` capability (tests /
 * non-browser runtimes) — there is deliberately no realm-wide fallback to
 * fall through to.
 */
export function resolveWebFetchDeps(context: ToolCallContext): WebFetchDeps {
  const network = context.platformCapabilities?.network
  if (!network) {
    throw new Error(
      'WebFetch: the network capability is not available on this ' +
        "runtime's host bridge (context.platformCapabilities.network).",
    )
  }
  return {
    network,
    runtimeCwd: context.options.projectRoot ?? context.options.cwd ?? '',
    fs: fsForContext(context),
  }
}

// =============================================================================
// Errors
// =============================================================================

export class HostRefusedError extends Error {
  constructor(domain: string) {
    super(`${getProductName()} is unable to fetch from ${domain}`)
    this.name = 'HostRefusedError'
  }
}

export class AbortError extends Error {
  constructor() {
    super('WebFetch aborted')
    this.name = 'AbortError'
  }
}

// =============================================================================
// Cache (15-min TTL, 50MB max).
// =============================================================================

type CacheEntry = {
  bytes: number
  code: number
  codeText: string
  content: string
  contentType: string
  savedCopyPath?: string
  savedCopyBytes?: number
  // V2: persisted overflow-markdown path when content > PAGE_TEXT_CHAR_CAP.
  overflowMarkdownPath?: string
  overflowMarkdownSize?: number
}

const PAGE_MEMO_TTL_MS = 15 * 60 * 1000 // 15 minutes
const PAGE_MEMO_BYTE_CAP = 50 * 1024 * 1024 // 50MB

const URL_CACHE = new LRUCache<string, CacheEntry>({
  maxSize: PAGE_MEMO_BYTE_CAP,
  ttl: PAGE_MEMO_TTL_MS,
  // `lru-cache` requires a sizeCalculation when maxSize is set, but
  // we pass `size` explicitly on `.set()` so this is just a safety
  // fallback for any accidental call site that forgets.
  sizeCalculation: (entry) =>
    Math.max(1, entry.content.length + entry.bytes),
})

export function forgetFetchedPages(): void {
  URL_CACHE.clear()
}

// Turndown + Domino lazy singletons. A SharedWorker has no `document`, so HTML is
// pre-parsed with domino and the Document handed to Turndown.

type HtmlToMdCtor = typeof import('turndown')
// @mixmark-io/domino ships a non-module .d.ts (`declare module
// 'domino'` — legacy name), so `typeof import('@mixmark-io/domino')`
// doesn't resolve. We import via a string the bundler still
// understands and shape the runtime value through `unknown` casts.
type DominoModule = {
  createDocument?: (html?: string, force?: boolean) => unknown
}

let htmlToMdLoading:
  | Promise<InstanceType<HtmlToMdCtor>>
  | undefined
let dominoPromise: Promise<DominoModule> | undefined

function htmlToMdConverter(): Promise<InstanceType<HtmlToMdCtor>> {
  return (htmlToMdLoading ??= import('turndown').then((m) => {
    const Turndown = (m as unknown as { default: HtmlToMdCtor }).default
    return new Turndown()
  }))
}

function getDomino(): Promise<DominoModule> {
  return (dominoPromise ??=
    // Untyped dynamic import — domino's .d.ts isn't an ES module.
    (import('@mixmark-io/domino' as string) as unknown as Promise<
      DominoModule & { default?: DominoModule }
    >).then((m) => m.default ?? m))
}

/**
 * Parse an HTML string into a DOM Document in any JS environment
 * (browser main thread, SharedWorker, Node). Returns the parsed
 * Document ready to be handed to Turndown.turndown().
 */
async function parseHtmlInWorker(html: string): Promise<unknown> {
  const domino = await getDomino()
  if (typeof domino.createDocument !== 'function') {
    throw new Error(
      'WebFetch: @mixmark-io/domino loaded but createDocument is unavailable',
    )
  }
  return domino.createDocument(html)
}

// =============================================================================
// Constants
// =============================================================================

const URL_CHAR_CAP = 2000
const PAGE_WAIT_MS = 60_000
// High on purpose: the binary-persist and text-overflow paths keep full bytes for `Read`.
const PAGE_BYTE_CAP = 50 * 1024 * 1024 // 50 MB
const HOP_LIMIT = 10

export const PAGE_TEXT_CHAR_CAP = 100_000

// =============================================================================
// URL helpers
// =============================================================================

export function onTrustedDocsList(url: string): boolean {
  try {
    const parsedUrl = new URL(url)
    return isAutoAllowedFetch(parsedUrl.hostname, parsedUrl.pathname)
  } catch {
    return false
  }
}

export function validateURL(url: string): boolean {
  if (url.length > URL_CHAR_CAP) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  // Reject URLs with embedded credentials. The bridge would strip
  // them anyway, but rejecting here makes the contract explicit.
  if (parsed.username || parsed.password) return false
  // Hostnames must have at least two parts (no `localhost`-style
  // privileged-internal URLs).
  const parts = parsed.hostname.split('.')
  if (parts.length < 2) return false
  return true
}

/**
 * Security: a redirect is permitted only with the same protocol, the same port, no
 * added credentials and the same hostname modulo `www`; others surface as a
 * `HopNotice`.
 */
export function hopAllowed(
  originalUrl: string,
  redirectUrl: string,
): boolean {
  try {
    const a = new URL(originalUrl)
    const b = new URL(redirectUrl)
    if (a.protocol !== b.protocol) return false
    if (a.port !== b.port) return false
    if (b.username || b.password) return false
    const stripWww = (h: string) => h.replace(/^www\./, '')
    return stripWww(a.hostname) === stripWww(b.hostname)
  } catch {
    return false
  }
}

// =============================================================================
// HTTP GET with manual redirect handling
// =============================================================================

export type HopNotice = {
  type: 'redirect'
  originalUrl: string
  redirectUrl: string
  statusCode: number
}

type HttpGetSuccess = {
  type: 'response'
  status: number
  statusText: string
  headers: Record<string, string>
  body: Uint8Array
  finalUrl: string
}

async function fetchFollowingSafeHops(
  network: BrowserNetworkOperations,
  url: string,
  signal: AbortSignal,
  hopFilter: (originalUrl: string, redirectUrl: string) => boolean,
  depth = 0,
): Promise<HttpGetSuccess | HopNotice> {
  if (depth > HOP_LIMIT) {
    throw new Error(`Too many redirects (exceeded ${HOP_LIMIT})`)
  }

  const result = await network.httpGet(url, {
    signal,
    timeoutMs: PAGE_WAIT_MS,
    maxResponseBytes: PAGE_BYTE_CAP,
    // We do redirect handling ourselves so we can apply the
    // same-host-only policy.
    followRedirects: false,
    headers: {
      Accept: 'text/markdown, text/html, */*',
      // C++ default UA already adds `Mozilla/5.0 (Velloc WebFetch)`
      // when omitted; the WebFetch input has no per-call UA override.
    },
  })

  // Redirect branch: 301/302/307/308 with a Location header.
  if (
    result.status === 301 ||
    result.status === 302 ||
    result.status === 307 ||
    result.status === 308
  ) {
    const redirectLocation =
      result.headers['location'] ?? result.headers['Location']
    if (!redirectLocation) {
      throw new Error('Redirect missing Location header')
    }
    const redirectUrl = new URL(redirectLocation, url).toString()
    if (hopFilter(url, redirectUrl)) {
      return fetchFollowingSafeHops(
        network,
        redirectUrl,
        signal,
        hopFilter,
        depth + 1,
      )
    }
    return {
      type: 'redirect',
      originalUrl: url,
      redirectUrl,
      statusCode: result.status,
    }
  }

  return {
    type: 'response',
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
    body: result.body,
    finalUrl: result.finalUrl,
  }
}

// =============================================================================
// Content-type sniffing
// =============================================================================

const BINARY_CONTENT_TYPE_PREFIXES = [
  'application/pdf',
  'application/octet-stream',
  'application/zip',
  'application/x-tar',
  'application/x-gzip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument',
  'application/vnd.ms-',
  'image/',
  'audio/',
  'video/',
  'font/',
]

function isNonTextMime(contentType: string): boolean {
  const normalized = contentType.toLowerCase().split(';')[0]?.trim() ?? ''
  return BINARY_CONTENT_TYPE_PREFIXES.some((p) =>
    normalized.startsWith(p),
  )
}

function mimeToExtension(contentType: string): string {
  const t = contentType.toLowerCase().split(';')[0]?.trim() ?? ''
  if (t.includes('pdf')) return 'pdf'
  if (t.includes('zip')) return 'zip'
  if (t.startsWith('image/png')) return 'png'
  if (t.startsWith('image/jpeg')) return 'jpg'
  if (t.startsWith('image/gif')) return 'gif'
  if (t.startsWith('image/webp')) return 'webp'
  if (t.startsWith('image/svg')) return 'svg'
  if (t.startsWith('audio/mpeg')) return 'mp3'
  if (t.startsWith('audio/')) return 'audio'
  if (t.startsWith('video/mp4')) return 'mp4'
  if (t.startsWith('video/')) return 'video'
  if (t.includes('msword') || t.includes('wordprocessingml')) return 'docx'
  if (t.includes('spreadsheetml') || t.includes('ms-excel')) return 'xlsx'
  if (t.includes('presentationml') || t.includes('ms-powerpoint'))
    return 'pptx'
  return 'bin'
}

/**
 * Compute a stable short id for the persisted-binary filename. We
 * combine timestamp + a small random suffix so concurrent fetches
 * of the same URL don't clobber each other on disk
 * (`webfetch-<timestamp>-<random>.<ext>`).
 */
function makePersistId(): string {
  return `webfetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// =============================================================================
// Persist binary content to disk
// =============================================================================

async function persistBinaryToWebFetchDir(
  runtimeCwd: string,
  bytes: Uint8Array,
  contentType: string,
  fs: RuntimeFs,
): Promise<{ filepath: string; size: number } | { error: string }> {
  if (!runtimeCwd) {
    return { error: 'webfetch deps not initialised' }
  }
  const ext = mimeToExtension(contentType)
  // `runtimeCwd` is `resolvedProjectRoot` (the model's working
  // directory, e.g. `<install>/.velloc/shared-workspace/<type>/`). Persist
  // under a plain `webfetch/` subdirectory — matching the `<projectRoot>/
  // memory/` convention — so the model can Glob/Read these files
  // from its own cwd. Do NOT prefix with `.velloc/` here: the parent
  // already lives under `.velloc/shared-workspace/`, and a second `.velloc/`
  // would put the files outside the searchable workspace tree.
  const dir = `${runtimeCwd}/webfetch`
  const filepath = `${dir}/${makePersistId()}.${ext}`
  try {
    // Best-effort directory creation. `RuntimeFs.mkdir` doesn't
    // expose a `recursive` flag today, so we try the leaf-most dir
    // first and swallow EEXIST-style errors. The parent workspace
    // dir is created at runtime bootstrap (see createBrowserRuntime.
    // ts) so the only path that needs creating here is `webfetch/`.
    if (typeof fs.mkdir === 'function') {
      try {
        await fs.mkdir(dir)
      } catch {
        // Directory likely already exists. If it really doesn't —
        // e.g. the workspace itself is missing — the writeFile
        // below will fail and the outer try/catch will return the
        // error envelope.
      }
    }
    await fs.writeFile(filepath, bytes)
    return { filepath, size: bytes.byteLength }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Persist the FULL markdown when it exceeds `PAGE_TEXT_CHAR_CAP` so the outer model
 * can `Read` the tail; only the copy sent to the fast model is truncated.
 */
async function persistMarkdownToWebFetchDir(
  runtimeCwd: string,
  markdown: string,
  fs: RuntimeFs,
): Promise<{ filepath: string; size: number } | { error: string }> {
  if (!runtimeCwd) {
    return { error: 'webfetch deps not initialised' }
  }
  // See `persistBinaryToWebFetchDir` for why we use `webfetch/`
  // (workspace-relative) and not `.velloc/webfetch/` (which would
  // escape the model's searchable cwd).
  const dir = `${runtimeCwd}/webfetch`
  const filepath = `${dir}/${makePersistId()}.md`
  try {
    if (typeof fs.mkdir === 'function') {
      try {
        await fs.mkdir(dir)
      } catch {
        // Directory likely already exists; writeFile will surface
        // any real failure.
      }
    }
    const bytes = new TextEncoder().encode(markdown)
    await fs.writeFile(filepath, bytes)
    return { filepath, size: bytes.byteLength }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// =============================================================================
// Public surface: capturePageAsMarkdown + askAboutPage
// =============================================================================

export type PageCapture = {
  content: string
  bytes: number
  code: number
  codeText: string
  contentType: string
  /**
   * Path of the BINARY persisted to disk (PDFs, images, archives,
   * etc. — anything matching `isNonTextMime`). Present iff
   * `persistBinaryToWebFetchDir` succeeded for this fetch.
   */
  savedCopyPath?: string
  savedCopyBytes?: number
  /**
   * V2: path of the FULL markdown persisted to disk when the
   * post-Turndown markdown exceeded `PAGE_TEXT_CHAR_CAP`. The
   * model receives the truncated copy through the fast-model
   * extraction; this path lets it `Read` the tail in a follow-up
   * turn. Present iff (a) markdown.length > PAGE_TEXT_CHAR_CAP
   * AND (b) `persistMarkdownToWebFetchDir` succeeded.
   */
  overflowMarkdownPath?: string
  overflowMarkdownSize?: number
}

export async function capturePageAsMarkdown(
  url: string,
  abortController: AbortController,
  deps: WebFetchDeps,
): Promise<PageCapture | HopNotice> {
  if (!validateURL(url)) {
    throw new Error('Invalid URL')
  }

  // Cache hit short-circuits the network round-trip.
  const cached = URL_CACHE.get(url)
  if (cached) {
    return {
      bytes: cached.bytes,
      code: cached.code,
      codeText: cached.codeText,
      content: cached.content,
      contentType: cached.contentType,
      savedCopyPath: cached.savedCopyPath,
      savedCopyBytes: cached.savedCopyBytes,
      overflowMarkdownPath: cached.overflowMarkdownPath,
      overflowMarkdownSize: cached.overflowMarkdownSize,
    }
  }

  // Upgrade http → https.
  let upgradedUrl = url
  const parsedUrl = new URL(url)
  if (parsedUrl.protocol === 'http:') {
    parsedUrl.protocol = 'https:'
    upgradedUrl = parsedUrl.toString()
  }

  const response = await fetchFollowingSafeHops(
    deps.network,
    upgradedUrl,
    abortController.signal,
    hopAllowed,
  )

  if (response.type === 'redirect') {
    return response
  }

  const rawBytes = response.body
  const contentType = response.headers['content-type'] ?? ''

  // Binary persist (PDFs, images, etc.) — optional supplement; we
  // still try the utf-8 decode below so the model at least sees the
  // ASCII structure (e.g. PDF /Title metadata) on a best-effort basis.
  let savedCopyPath: string | undefined
  let savedCopyBytes: number | undefined
  if (isNonTextMime(contentType)) {
    const result = await persistBinaryToWebFetchDir(
      deps.runtimeCwd,
      rawBytes,
      contentType,
      deps.fs ?? processFs(),
    )
    if (!('error' in result)) {
      savedCopyPath = result.filepath
      savedCopyBytes = result.size
    }
  }

  const bytes = rawBytes.byteLength
  const htmlContent = new TextDecoder('utf-8').decode(rawBytes)

  let markdownContent: string
  let contentBytes: number
  if (contentType.includes('text/html')) {
    // Two-step convert: domino parses HTML → Document (works in
    // SharedWorker contexts where `window`/`document` are
    // undefined), then Turndown walks the parsed tree to emit
    // markdown. Bypasses Turndown's automatic browser-DOM
    // detection which crashes here.
    const doc = await parseHtmlInWorker(htmlContent)
    const turndown = await htmlToMdConverter()
    markdownContent = turndown.turndown(
      // Turndown's TS types narrow `turndown()` to `string`, but
      // the runtime accepts a parsed `Node` too — used by every
      // server-side caller. Cast through `unknown` to take the
      // Node-input fast path without fighting the types.
      doc as unknown as string,
    )
    contentBytes = new TextEncoder().encode(markdownContent).byteLength
  } else {
    markdownContent = htmlContent
    contentBytes = bytes
  }

  // Text-overflow persistence; skipped when the markdown fits or the raw bytes
  // were already persisted.
  let overflowMarkdownPath: string | undefined
  let overflowMarkdownSize: number | undefined
  if (markdownContent.length > PAGE_TEXT_CHAR_CAP && !savedCopyPath) {
    const result = await persistMarkdownToWebFetchDir(
      deps.runtimeCwd,
      markdownContent,
      deps.fs ?? processFs(),
    )
    if (!('error' in result)) {
      overflowMarkdownPath = result.filepath
      overflowMarkdownSize = result.size
    }
  }

  const entry: CacheEntry = {
    bytes,
    code: response.status,
    codeText: response.statusText,
    content: markdownContent,
    contentType,
    savedCopyPath,
    savedCopyBytes,
    overflowMarkdownPath,
    overflowMarkdownSize,
  }
  URL_CACHE.set(url, entry, { size: Math.max(1, contentBytes) })
  return entry
}

/**
 * Hand off the fetched markdown + the user's prompt to the
 * per-provider fast model (queryFastModel) and return its extracted
 * answer.
 */
export async function askAboutPage(
  prompt: string,
  pageText: string,
  signal: AbortSignal,
  trustedSource: boolean,
  toolUseContext: ToolCallContext,
  providerId: string,
): Promise<string> {
  const truncatedContent =
    pageText.length > PAGE_TEXT_CHAR_CAP
      ? pageText.slice(0, PAGE_TEXT_CHAR_CAP) +
        '\n\n[Content truncated due to length...]'
      : pageText

  const modelPrompt = pageQuestionBrief(
    truncatedContent,
    prompt,
    trustedSource,
  )

  try {
    const answer = await queryFastModel({
      userPrompt: modelPrompt,
      signal,
      toolUseContext,
      providerId,
      querySource: 'web_fetch_apply',
    })
    if (signal.aborted) {
      throw new AbortError()
    }
    return answer
  } catch (err) {
    // Fail-soft: when the fast model is unavailable (e.g. provider
    // misconfig, queryFastModel boot order not satisfied) we return
    // the truncated raw markdown so the outer model can do its own
    // extraction. This matches SpawnAgentTool's "cache-safe params
    // missing" graceful-degradation branch.
    if (err instanceof AbortError) throw err
    return truncatedContent
  }
}
