// The WebFetch tool: fetch a URL, convert it to markdown, and extract
// what the prompt asks for. Permissions go through Nexus's
// `ToolPermissionContext`.
//
//   1. Secondary model is `queryFastModel` against the per-provider
//      `NEXUS_MODEL_CONFIG.fastModel` (see `src/models/fastModelCall.ts`).
//   2. No domain-info preflight; redirect safety + per-domain permission
//      rules protect the fetch.

import type { ToolContract, InputCheck } from '../../toolContract'
import type { ToolPermissionResult } from '../../permissionVerdict'
import type { ToolCallContext } from '../../toolCallContext'
import { declareTool } from '../../toolContract'
import { getProductName } from '../../../branding/productName'

import { isAutoAllowedFetch } from './autoAllowedSites'
import { webFetchRuleContent } from '../../../permissions/webFetchRuleMatching'
import { PAGE_READ_TOOL_ID } from './fetchPrompt'
import {
  AbortError,
  type PageCapture,
  type HopNotice,
  askAboutPage,
  capturePageAsMarkdown,
  onTrustedDocsList,
  PAGE_TEXT_CHAR_CAP,
  resolveWebFetchDeps,
} from './fetchHelpers'

export { PAGE_READ_TOOL_ID } from './fetchPrompt'
export {
  forgetFetchedPages,
  resolveWebFetchDeps,
  type WebFetchDeps,
} from './fetchHelpers'

export type WebFetchInput = {
  url: string
  prompt: string
}

// The model-facing tool result is a plain prose string: only the
// extracted result reaches the model. Hooks / programmatic consumers
// don't see byte counts, status codes or timings either.
export type WebFetchOutput = string

// Pre-flight URL validation that runs before permission resolution.
async function checkInput(
  input: WebFetchInput,
  _context: ToolCallContext,
): Promise<InputCheck> {
  if (typeof input.url !== 'string' || input.url.trim().length === 0) {
    return {
      result: false,
      message: 'url is required and must be a non-empty string.',
      errorCode: 1,
    }
  }
  if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
    return {
      result: false,
      message: 'prompt is required and must be a non-empty string.',
      errorCode: 2,
    }
  }
  try {
    // eslint-disable-next-line no-new
    new URL(input.url)
  } catch {
    return {
      result: false,
      message: `Error: Invalid URL "${input.url}". The URL provided could not be parsed.`,
      errorCode: 3,
    }
  }
  return { result: true }
}

async function selfVerdict(
  input: WebFetchInput,
  _context: ToolCallContext,
): Promise<ToolPermissionResult> {
  // Preapproved-host fast path — auto-allow without a UI prompt.
  try {
    const parsed = new URL(input.url)
    if (isAutoAllowedFetch(parsed.hostname, parsed.pathname)) {
      return { behavior: 'allow', updatedInput: input }
    }
  } catch {
    // URL parsing failures fall through to the rule-based path
    // below; the eventual call() will also re-validate and fail.
  }

  // Rules are not looked up here: both callers run the rule gate first
  // (`evaluateRuleGate`, which matches `WebFetch(domain:<host>)` from the same
  // by-source maps) and reach this only on passthrough — no rule applies.
  const ruleContent = webFetchRuleContent(input.url)

  return {
    behavior: 'ask',
    message: `${getProductName()} requested permissions to use ${PAGE_READ_TOOL_ID} on ${ruleContent}, but you haven't granted it yet.`,
  }
}

// Redirect-detected envelope. The string is what the model reads, so the
// wording matters — keep it byte-stable so the model's response
// heuristics don't shift.
function buildRedirectEnvelope(
  info: HopNotice,
  prompt: string,
): string {
  const statusText =
    info.statusCode === 301
      ? 'Moved Permanently'
      : info.statusCode === 308
      ? 'Permanent Redirect'
      : info.statusCode === 307
      ? 'Temporary Redirect'
      : 'Found'

  return `This URL redirects to another host, which was not followed.

Requested: ${info.originalUrl}
Target: ${info.redirectUrl}
HTTP status: ${info.statusCode} ${statusText}

Call WebFetch again with url "${info.redirectUrl}" and the same prompt ("${prompt}") to read the target.`
}

async function call(
  input: WebFetchInput,
  context: ToolCallContext,
): Promise<{ data: WebFetchOutput }> {
  const abortController = new AbortController()
  // The runtime cancels the parent tool-use via its own abort signal;
  // mirror that into our local AbortController so capturePageAsMarkdown
  // can interrupt cleanly.
  if (context.cancelSource?.signal) {
    if (context.cancelSource.signal.aborted) {
      abortController.abort()
    } else {
      context.cancelSource.signal.addEventListener('abort', () => {
        abortController.abort()
      })
    }
  }

  // Scope-bound deps off THIS call's context: the runtime's own
  // `network.httpGet` (host bridge) and project root — never a realm-shared
  // slot (see utils.ts). Throws — as a tool error — when the runtime's host
  // bridge has no network capability.
  const deps = resolveWebFetchDeps(context)
  const response = await capturePageAsMarkdown(
    input.url,
    abortController,
    deps,
  )

  // Cross-host redirect: don't follow. Return the redirect prose so
  // the model re-issues WebFetch with the new URL (open-redirect
  // safety).
  if ('type' in response && response.type === 'redirect') {
    return { data: buildRedirectEnvelope(response, input.prompt) }
  }

  const {
    content,
    bytes: _bytes,
    code: _code,
    codeText: _codeText,
    contentType,
    savedCopyPath,
    savedCopyBytes,
    overflowMarkdownPath,
    overflowMarkdownSize,
  } = response as PageCapture

  const isPreapproved = onTrustedDocsList(input.url)
  const providerId = (context.options as { providerId?: string }).providerId
  if (!providerId) {
    // Defensive: providerId should always be set in a normal session.
    // If it isn't, fall back to returning the truncated raw markdown.
    return {
      data:
        content.length > PAGE_TEXT_CHAR_CAP
          ? content.slice(0, PAGE_TEXT_CHAR_CAP) +
            '\n\n[Content truncated due to length...]'
          : content,
    }
  }

  let result: string
  if (
    isPreapproved &&
    contentType.includes('text/markdown') &&
    content.length < PAGE_TEXT_CHAR_CAP
  ) {
    // Preapproved short markdown: skip the fast-model extraction
    // pass: the content is already in the right form, and re-running it
    // through the fast model just costs tokens and time.
    result = content
  } else {
    try {
      result = await askAboutPage(
        input.prompt,
        content,
        abortController.signal,
        isPreapproved,
        context,
        providerId,
      )
    } catch (err) {
      if (err instanceof AbortError) throw err
      // Defensive fail-soft: return the truncated raw markdown.
      result =
        content.length > PAGE_TEXT_CHAR_CAP
          ? content.slice(0, PAGE_TEXT_CHAR_CAP) +
            '\n\n[Content truncated due to length...]'
          : content
    }
  }

  if (savedCopyPath) {
    const sizeLabel =
      typeof savedCopyBytes === 'number'
        ? `, ${savedCopyBytes.toLocaleString()} bytes`
        : ''
    result += `\n\n[Binary content (${contentType}${sizeLabel}) also saved to ${savedCopyPath}]`
  }

  // V2: text-overflow disk-persistence suffix. When the post-Turndown
  // markdown exceeded PAGE_TEXT_CHAR_CAP (100K chars) we saved the
  // FULL markdown to disk; tell the model so it can use `Read` with
  // offset/limit to inspect the tail when the fast-model summary
  // above isn't sufficient. Distinct phrasing from the binary
  // suffix because the file IS the markdown (readable directly) —
  // not a black-box binary the model has to grep through.
  if (overflowMarkdownPath) {
    const sizeLabel =
      typeof overflowMarkdownSize === 'number'
        ? `, ${overflowMarkdownSize.toLocaleString()} bytes`
        : ''
    const truncMessage =
      `\n\n[Page markdown was longer than ${PAGE_TEXT_CHAR_CAP.toLocaleString()} ` +
      `chars; the summary above is based on the prefix only. The FULL ` +
      `markdown (${sizeLabel.trim().replace(/^,\s*/, '')}) is saved at ` +
      `${overflowMarkdownPath} — use the Read tool with offset/limit to ` +
      `inspect specific sections, or Grep against this path to find ` +
      `content not in the summary.]`
    result += truncMessage
  }

  return { data: result }
}

export const PageReadTool: ToolContract<WebFetchInput, WebFetchOutput> = declareTool({
  name: PAGE_READ_TOOL_ID,
  discoveryHint: 'fetch and extract content from a URL',
  argsSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch content from',
      },
      prompt: {
        type: 'string',
        description: 'The prompt to run on the fetched content',
      },
    },
    required: ['url', 'prompt'],
    additionalProperties: false,
  },
  parallelSafe: () => true,
  readsOnly: () => true,
  // Dynamic per-call description so UI hover/tooltip shows
  // the actual host the model is fetching.
  description: async (input: WebFetchInput) => {
    try {
      return `${getProductName()} wants to fetch content from ${new URL(input.url).hostname}`
    } catch {
      return `${getProductName()} wants to fetch content from this URL`
    }
  },
  checkInput: checkInput,
  selfVerdict: selfVerdict,
  call,
})
