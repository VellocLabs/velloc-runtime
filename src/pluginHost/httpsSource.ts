/**
 * The `https` install source: one `.tar.gz` at an https URL, unpacked into a
 * local version directory that the loader reads; nothing runs from a URL.
 *
 * Security: https only (every redirect hop too), no credentials in the URL,
 * download / inflate / file-count / per-file caps, `extract.ts` path rules, and
 * an optional digest pin.
 */

import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  decompressGzip,
  parseTar,
  stripTopLevelDir,
  type ExtractedFile,
} from './extract'
import { recordPluginSetup } from './installedRegistry'
import { holdProviderPluginForConsent } from './providerPluginConsent'
import { getPluginVersionCacheDir, type PluginInstallPathContext } from './pluginDirs'
import { joinPluginRef } from './pluginRef'
import type { PluginSetupRecord } from './registryFormats'
import { writeExtractedFiles } from './writeExtracted'

/** The catalog key under which a plugin installed straight from a URL is filed. */
export const DIRECT_CATALOG_KEY = 'direct'

export type HttpsLimits = {
  /** Largest download, in bytes. */
  maxArchiveBytes: number
  /** Largest inflated tar, in bytes. */
  maxInflatedBytes: number
  /** Most files in the archive. */
  maxFiles: number
  /** Largest single file, in bytes. */
  maxFileBytes: number
}

export const DEFAULT_HTTPS_LIMITS: Readonly<HttpsLimits> = Object.freeze({
  maxArchiveBytes: 25 * 1024 * 1024,
  maxInflatedBytes: 64 * 1024 * 1024,
  maxFiles: 2000,
  maxFileBytes: 16 * 1024 * 1024,
})

/** A reason the https source refused something; `code` is data for callers. */
export class HttpsSourceError extends Error {
  constructor(
    readonly code:
      | 'not-https'
      | 'bad-url'
      | 'network'
      | 'http-status'
      | 'too-large'
      | 'too-many-files'
      | 'file-too-large'
      | 'digest-mismatch'
      | 'bad-archive'
      | 'no-manifest'
      | 'bad-manifest'
      | 'bad-name'
      | 'bad-version'
      | 'write-failed',
    message: string,
  ) {
    super(message)
    this.name = 'HttpsSourceError'
  }
}

/** Parses `url`; only a plain https URL passes (no credentials, a host). */
export function assertHttpsUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new HttpsSourceError('bad-url', `[https] not a URL: ${url.slice(0, 120)}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new HttpsSourceError('not-https', `[https] only https is accepted, got ${parsed.protocol} for ${parsed.host || url.slice(0, 60)}`)
  }
  if (parsed.username || parsed.password) {
    throw new HttpsSourceError('bad-url', '[https] a URL with credentials is refused')
  }
  if (!parsed.hostname) throw new HttpsSourceError('bad-url', '[https] the URL has no host')
  return parsed
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function sha256Of(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer))
}

/** Downloads `url` (https only) into memory, never past `maxBytes`. */
export async function downloadHttps(
  url: string,
  fetchImpl: typeof fetch,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; url: string; contentType: string }> {
  assertHttpsUrl(url)
  let response: Response
  try {
    response = await fetchImpl(url, { redirect: 'follow', credentials: 'omit' })
  } catch (error) {
    throw new HttpsSourceError('network', `[https] network error fetching ${url}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    throw new HttpsSourceError('http-status', `[https] HTTP ${response.status} fetching ${url}`)
  }
  // The URL the bytes came from, after redirects, must be https too.
  if (response.url) assertHttpsUrl(response.url)
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpsSourceError('too-large', `[https] ${url} is ${declared} bytes; the most is ${maxBytes}`)
  }
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body?.getReader()
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > maxBytes) {
          throw new HttpsSourceError('too-large', `[https] ${url} is larger than ${maxBytes} bytes`)
        }
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
  } else {
    const buf = new Uint8Array(await response.arrayBuffer())
    if (buf.byteLength > maxBytes) {
      throw new HttpsSourceError('too-large', `[https] ${url} is larger than ${maxBytes} bytes`)
    }
    chunks.push(buf)
    total = buf.byteLength
  }
  const bytes = new Uint8Array(total)
  let pos = 0
  for (const chunk of chunks) {
    bytes.set(chunk, pos)
    pos += chunk.byteLength
  }
  return { bytes, url: response.url || url, contentType: response.headers.get('content-type') ?? '' }
}

/**
 * Archive bytes -> files, under the limits. The paths are already confined
 * (`parseTar` drops `..`, absolute paths, links). A manifest at the archive
 * root is kept as is; otherwise one uniform wrapper directory is peeled.
 */
export async function extractPluginArchive(
  bytes: Uint8Array,
  limits: HttpsLimits = DEFAULT_HTTPS_LIMITS,
): Promise<ExtractedFile[]> {
  let files: ExtractedFile[]
  try {
    files = parseTar(await decompressGzip(bytes, limits.maxInflatedBytes))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/limit|bomb/i.test(message)) throw new HttpsSourceError('too-large', message)
    throw new HttpsSourceError('bad-archive', `[https] the archive could not be read: ${message}`)
  }
  if (files.length > limits.maxFiles) {
    throw new HttpsSourceError('too-many-files', `[https] the archive has ${files.length} files; the most is ${limits.maxFiles}`)
  }
  if (!files.some(file => file.path === '.claude-plugin/plugin.json')) files = stripTopLevelDir(files)
  for (const file of files) {
    if (file.content.byteLength > limits.maxFileBytes) {
      throw new HttpsSourceError('file-too-large', `[https] ${file.path} is ${file.content.byteLength} bytes; the most is ${limits.maxFileBytes}`)
    }
  }
  if (files.length === 0) throw new HttpsSourceError('bad-archive', '[https] the archive holds no files')
  return files
}

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/

/** A version is used as a directory name, so it must be a plain token. */
export function isSafeVersion(version: string): boolean {
  return VERSION_RE.test(version) && !version.includes('..')
}

/** The `name` and `version` of the archive's `.claude-plugin/plugin.json`. */
export function readArchiveIdentity(files: readonly ExtractedFile[]): { name: string; version: string } {
  const entry = files.find(file => file.path === '.claude-plugin/plugin.json')
  if (!entry) throw new HttpsSourceError('no-manifest', '[https] the archive has no .claude-plugin/plugin.json')
  let json: { name?: unknown; version?: unknown }
  try {
    json = JSON.parse(new TextDecoder('utf-8').decode(entry.content)) as typeof json
  } catch (error) {
    throw new HttpsSourceError('bad-manifest', `[https] plugin.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof json.name !== 'string' || !NAME_RE.test(json.name)) {
    throw new HttpsSourceError('bad-name', '[https] plugin.json "name" must be 1-64 characters of letters, digits, "_" and "-"')
  }
  if (typeof json.version !== 'string' || !isSafeVersion(json.version)) {
    throw new HttpsSourceError('bad-version', '[https] plugin.json "version" is required, and must be a plain token (letters, digits, ".", "_", "+", "-")')
  }
  return { name: json.name, version: json.version }
}

/** Writes `files` into the version directory of `<name>@<catalogKey>`. */
export async function writeVersionDir(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  catalogKey: string,
  name: string,
  version: string,
  files: readonly ExtractedFile[],
): Promise<string> {
  const installPath = getPluginVersionCacheDir(ctx, catalogKey, name, version)
  const outcome = await writeExtractedFiles(fs, installPath, files)
  if (outcome.firstFailureIndex !== null) {
    const failing = files[outcome.firstFailureIndex]?.path ?? '<unknown>'
    throw new HttpsSourceError('write-failed', `[https] wrote ${outcome.written}/${files.length} files before failing at '${failing}' under ${installPath}`)
  }
  return installPath
}

export type HttpsInstallOptions = {
  fetchImpl?: typeof fetch
  nowIso?: string
  limits?: HttpsLimits
}

export type HttpsInstallOutcome = {
  identifier: string
  name: string
  version: string
  installPath: string
  fileCount: number
  sha256: string
  entry: PluginSetupRecord
}

/**
 * Installs a plugin from an https archive: fetch, check, unpack into
 * `cache/direct/<name>/<version>/`, record it in `installed_plugins.json` with
 * its source and version. It does not enable or consent; those are the
 * caller's.
 */
export async function installFromHttps(
  ctx: PluginInstallPathContext,
  fs: RuntimeFs,
  input: { url: string; sha256?: string },
  options: HttpsInstallOptions = {},
): Promise<HttpsInstallOutcome> {
  const limits = options.limits ?? DEFAULT_HTTPS_LIMITS
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const downloaded = await downloadHttps(input.url, fetchImpl, limits.maxArchiveBytes)
  const sha256 = await sha256Of(downloaded.bytes)
  if (input.sha256 && input.sha256.toLowerCase() !== sha256) {
    throw new HttpsSourceError('digest-mismatch', `[https] the archive's SHA-256 is ${sha256}, not the pinned ${input.sha256.toLowerCase()}`)
  }
  const files = await extractPluginArchive(downloaded.bytes, limits)
  const { name, version } = readArchiveIdentity(files)
  const installPath = await writeVersionDir(ctx, fs, DIRECT_CATALOG_KEY, name, version, files)
  const nowIso = options.nowIso ?? new Date().toISOString()
  const entry: PluginSetupRecord = {
    scope: 'user',
    installPath,
    version,
    installedAt: nowIso,
    origin: { source: 'https', url: input.url, sha256 },
  }
  const identifier = joinPluginRef(name, DIRECT_CATALOG_KEY)
  await recordPluginSetup(ctx, fs, identifier, entry)
  // A plugin that adds model providers starts OFF until the person approves it.
  const manifestFile = files.find(file => file.path === '.claude-plugin/plugin.json')
  if (manifestFile) {
    await holdProviderPluginForConsent(ctx, fs, identifier, JSON.parse(new TextDecoder('utf-8').decode(manifestFile.content)))
  }
  return { identifier, name, version, installPath, fileCount: files.length, sha256, entry }
}
