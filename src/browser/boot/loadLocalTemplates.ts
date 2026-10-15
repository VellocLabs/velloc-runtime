// Local on-disk template folder loader (`<install root>/.velloc/template`). No fs request at all
// unless the host signals `template=local` on the guest URL; the relative path resolves against the host cwd.

// `templateRegistry` is imported DYNAMICALLY below, to keep it out of the boot entry chunk.
import {
  createBridgeRoute,
  type BrowserBridgeTransport,
} from '../bridge/browserBridgeProtocol'
import { RUNTIME_DIR_NAME } from '../../branding/runtimeDir'
import { currentTemplateChannel } from '../../branding/updateChannels'

// Same literals as `templateParsing.ts` (`BETA_INDEX_FILE` …). Not imported:
// that module carries `yaml`, and this file is on the boot-critical entry chunk
// (see the NOTE above).
const INDEX_FILE = 'index.md'
const BETA_INDEX_FILE = 'index-beta.md'
const TEMPLATE_FILE = 'template.md'
const BETA_TEMPLATE_FILE = 'template-beta.md'

/** The local template folder, relative to the install-root cwd. */
export const LOCAL_TEMPLATE_ROOT = `${RUNTIME_DIR_NAME}/template`

let requestSeq = 0

/**
 * A bridge request id that is unique within this realm. `Date.now()` alone is
 * millisecond-resolution: several sessions restoring at once (each lazy-loading
 * its local type) issued the same id, the worker threw 'Duplicate bridge
 * request id', and the loser read as "file absent". A monotonic counter makes
 * the id unique here; the random tail keeps two realms (page and worker) that
 * share a bridge apart too.
 */
export function nextLocalTemplateRequestId(prefix: string): string {
  requestSeq += 1
  const random = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${Date.now().toString(36)}-${requestSeq.toString(36)}-${random}`
}

/**
 * Read one file under the local template folder (`<root>/<relPath>`) over the fs
 * bridge, decoded to UTF-8 text. Returns undefined when the file is absent /
 * denied / there is no fs capability, so callers degrade to the bundled set.
 */
export async function readLocalTemplateFile(
  transport: BrowserBridgeTransport,
  relPath: string,
): Promise<string | undefined> {
  try {
    const response = await transport.request({
      id: nextLocalTemplateRequestId('local-tmpl'),
      route: createBridgeRoute('fs', 'readFile'),
      payload: { path: `${LOCAL_TEMPLATE_ROOT}/${relPath}` },
    })
    if (response.ok && response.result) {
      return new TextDecoder().decode(response.result)
    }
  } catch {
    // absent / denied / no fs capability → undefined (callers fall back).
  }
  return undefined
}

/**
 * The local-template gate + launcher-catalog overlay. Without `?template=local` it returns at once with
 * no fs request. Otherwise a non-empty local catalog replaces the bundled one (on beta `index-beta.md`
 * first, then `index.md`); per-type files load lazily.
 */
export async function loadLocalCatalogIfRequested(
  transport: BrowserBridgeTransport,
  search: string,
): Promise<void> {
  if (new URLSearchParams(search).get('template') !== 'local') return
  const indexMd =
    (currentTemplateChannel() === 'beta'
      ? await readLocalTemplateFile(transport, BETA_INDEX_FILE)
      : undefined) ?? (await readLocalTemplateFile(transport, INDEX_FILE))
  if (!indexMd) return
  const { applyLocalCatalog, applyLocalWelcome, getLauncherCatalog } =
    await import('../../prompting/templateRegistry')
  try {
    await applyLocalCatalog(indexMd)
  } catch (error) {
    // Defensive: nothing in the catalog parse throws today (malformed YAML
    // degrades to an empty `types:` list, which `applyLocalCatalog` ignores),
    // but a local catalog is hand-written and boot must survive whatever a
    // future catalog key decides to reject. Without this catch a throw reaches
    // `nexusBootAndRender`, the guest never answers `nexus-init`, and a typo in
    // a template file costs the user a blank panel until the 30 s recovery
    // overlay appears. The bundled catalog is already loaded, so degrade to it,
    // say why, and skip the welcome overlay for a catalog that was not applied.
    console.error(
      '[nexus] local template index.md rejected; keeping the bundled launcher catalog',
      error,
    )
    return
  }
  // Load each local type's default `welcome.md` (small) so the empty-thread
  // welcome chips render for local types. `getWelcome` is page-side + sync, and
  // the worker (which lazy-loads `template.md`) can't populate the PAGE registry,
  // so the page loads welcomes here. Still gated on `template=local`, so the
  // "no param, no local I/O" invariant holds. Locale variants fall back to this.
  for (const meta of getLauncherCatalog()) {
    const welcomeMd = await readLocalTemplateFile(transport, `${meta.type}/welcome.md`)
    if (welcomeMd) await applyLocalWelcome(meta.type, '', welcomeMd)
  }
}

/** List the file names directly under `<root>/<relPath>` via the fs bridge.
 *  Non-recursive; returns [] when the directory is absent / there's no fs. */
export async function listLocalTemplateDir(
  transport: BrowserBridgeTransport,
  relPath: string,
): Promise<string[]> {
  try {
    const response = await transport.request({
      id: nextLocalTemplateRequestId('local-tmpl-ls'),
      route: createBridgeRoute('fs', 'readdir'),
      payload: { path: `${LOCAL_TEMPLATE_ROOT}/${relPath}` },
    })
    if (response.ok && response.result) {
      return response.result.filter(d => d.isFile).map(d => d.name)
    }
  } catch {
    // absent / denied / no fs → [].
  }
  return []
}

/**
 * Lazy-load one LOCAL type (worker side): both template manifests and the `includes/*.md` holders,
 * then `registerLocalType`. No manifest → no-op. The caller gates on `templateSource === 'local'`.
 */
export async function loadLocalTypeFiles(
  transport: BrowserBridgeTransport,
  type: string,
): Promise<void> {
  const files: Array<[string, string]> = []
  for (const name of [TEMPLATE_FILE, BETA_TEMPLATE_FILE]) {
    const content = await readLocalTemplateFile(transport, `${type}/${name}`)
    if (content !== undefined) files.push([`${type}/${name}`, content])
  }
  if (files.length === 0) return
  const { registerLocalType } = await import('../../prompting/templateRegistry')
  for (const name of await listLocalTemplateDir(transport, `${type}/includes`)) {
    if (!name.endsWith('.md')) continue
    const content = await readLocalTemplateFile(transport, `${type}/includes/${name}`)
    if (content !== undefined) files.push([`${type}/includes/${name}`, content])
  }
  await registerLocalType(type, files)
}

/**
 * Security: a malformed overlay falls back to the bundled type (logged), but for a LOCAL-ONLY type the
 * error propagates and the session fails: an `undefined` config would grant every tool.
 */
export async function loadLocalTypeFilesOrFallBack(
  transport: BrowserBridgeTransport,
  type: string,
): Promise<void> {
  try {
    await loadLocalTypeFiles(transport, type)
  } catch (error) {
    const { hasTemplate } = await import('../../prompting/templateRegistry')
    if (!hasTemplate(type)) {
      throw new Error(
        `local template overlay for "${type}" is invalid and no bundled ` +
          `definition of that type exists to fall back to: ${
            error instanceof Error ? error.message : String(error)
          }`,
        { cause: error },
      )
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[loadLocalTemplates] local template overlay for "${type}" is invalid; ` +
        'using the bundled definition.',
      error,
    )
  }
}
