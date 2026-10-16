/**
 * Security: MCP server credentials live in the host `secrets` store (`mcp:`),
 * never in settings.json. Credential headers become
 * `{{secret:mcp:<id>/header/<name>}}`, bound to the server URL's origin and
 * substituted host-side only for that origin; the plaintext never returns.
 * A moved origin needs the credential again. Stdio credential env vars become
 * process-only secrets (`mcp:<id>/env/<NAME>`), never sent over the network.
 * A save never overwrites a referenced secret (new value → fresh `@<rev>`);
 * unreferenced secrets are deleted.
 */
import type {
  BridgeSecretName,
  BridgeSecretNamespace,
} from '../browser/bridge/browserBridgeProtocol'
import type { NexusMcpServerConfig } from '../settings/settingsTypes'

/** The slice of `NativePrimitives['secrets']` the settings adapter uses. */
export type McpSecretsStore = {
  set(
    name: BridgeSecretName,
    value: string,
    origin: string | undefined,
    options?: { processEnv?: boolean },
  ): Promise<void>
  has(name: BridgeSecretName): Promise<{ exists: boolean; origin?: string }>
  delete(name: BridgeSecretName): Promise<boolean>
  listNames(namespace?: BridgeSecretNamespace): Promise<Array<{ name: string; origin: string }>>
}

/** Header names whose values are credentials. */
const SENSITIVE_HEADER =
  /^(authorization|x-api-key|api-key|apikey)$|token|secret|passw|credential|cookie|session|auth|key/i

export function isSensitiveMcpHeader(name: string): boolean {
  return SENSITIVE_HEADER.test(name)
}

/** Env var names whose values are credentials (`GITHUB_TOKEN`,
 *  `OPENAI_API_KEY`, `DB_PASSWORD`, …). */
const SENSITIVE_ENV = /token|secret|passw|credential|cookie|auth|key|pat$/i

export function isSensitiveMcpEnv(name: string): boolean {
  return SENSITIVE_ENV.test(name)
}

/** One name segment in the store's alphabet ([A-Za-z0-9_.:/@-]), injective:
 *  every other character — `_` and `/` included — becomes `_<hex>_`. */
export function secretNameSegment(text: string): string {
  let out = ''
  for (const char of text) {
    out += /[A-Za-z0-9.@-]/.test(char)
      ? char
      : `_${char.codePointAt(0)!.toString(16)}_`
  }
  return out
}

/** The prefix every secret of server `serverId` carries. */
export function mcpServerSecretPrefix(serverId: string): string {
  return `mcp:${secretNameSegment(serverId)}/`
}

/** `mcp:<id>/header/<lower-cased header>` (the store caps a name at 128
 *  characters after the namespace). */
export function mcpHeaderSecretName(serverId: string, header: string): BridgeSecretName {
  const name = `${mcpServerSecretPrefix(serverId)}header/${secretNameSegment(header.toLowerCase())}`
  if (name.length - 'mcp:'.length > 128) {
    throw new Error(
      `The server name "${serverId}" with header "${header}" is too long to store its value securely.`,
    )
  }
  return name as BridgeSecretName
}

/** `mcp:<id>/env/<NAME>` — case kept: env names are case-sensitive. */
export function mcpEnvSecretName(serverId: string, envName: string): BridgeSecretName {
  const name = `${mcpServerSecretPrefix(serverId)}env/${secretNameSegment(envName)}`
  if (name.length - 'mcp:'.length > 128) {
    throw new Error(
      `The server name "${serverId}" with variable "${envName}" is too long to store its value securely.`,
    )
  }
  return name as BridgeSecretName
}

const PLACEHOLDER = /^\{\{secret:(mcp:[A-Za-z0-9_.:/@-]+)\}\}$/

/** The secret a header value stands for, when the value is exactly one
 *  `{{secret:mcp:…}}` placeholder. */
export function mcpSecretPlaceholderName(value: string): BridgeSecretName | null {
  const match = PLACEHOLDER.exec(value.trim())
  return match ? (match[1] as BridgeSecretName) : null
}

export function mcpSecretPlaceholder(name: string): string {
  return `{{secret:${name}}}`
}

function originOf(url: string | undefined): string {
  try {
    return new URL(url ?? '').origin
  } catch {
    throw new Error(`"${url ?? ''}" is not a valid URL.`)
  }
}

/** A name for a NEW value of `base`: `base` itself when nothing is stored
 *  under it, else a fresh revision — never one the saved config may use. */
async function unusedName(base: BridgeSecretName, secrets: McpSecretsStore): Promise<BridgeSecretName> {
  if (!(await secrets.has(base)).exists) return base
  for (;;) {
    const revision = `${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 4).toString(36)}`
    const name = `${base}@${revision}`
    if (name.length - 'mcp:'.length > 128) {
      throw new Error('The server name is too long to store a new value securely; remove the server and add it again.')
    }
    if (!(await secrets.has(name as BridgeSecretName)).exists) return name as BridgeSecretName
  }
}

/** Delete secrets a save wrote. Best-effort, like the prune. */
export async function discardMcpServerSecrets(
  names: ReadonlySet<string>,
  secrets: McpSecretsStore | undefined,
): Promise<void> {
  if (!secrets) return
  for (const name of names) {
    await secrets.delete(name as BridgeSecretName).catch(() => false)
  }
}

/**
 * The config to persist with credentials moved into the store. Returns the
 * referenced names and those stored (`written`). Throws, keeping nothing, when
 * a credential cannot be stored (no store, an origin the store will not bind,
 * a stale placeholder).
 */
export async function sealMcpServerSecrets(
  serverId: string,
  config: NexusMcpServerConfig,
  secrets: McpSecretsStore | undefined,
): Promise<{ config: NexusMcpServerConfig; referenced: Set<string>; written: Set<string> }> {
  const written = new Set<string>()
  try {
    return { ...(await sealInto(serverId, config, secrets, written)), written }
  } catch (error) {
    await discardMcpServerSecrets(written, secrets)
    throw error
  }
}

async function sealInto(
  serverId: string,
  config: NexusMcpServerConfig,
  secrets: McpSecretsStore | undefined,
  written: Set<string>,
): Promise<{ config: NexusMcpServerConfig; referenced: Set<string> }> {
  const referenced = new Set<string>()
  let sealed = config
  if (config.env && Object.keys(config.env).length > 0) {
    sealed = { ...sealed, env: await sealEnv(serverId, config.env, secrets, referenced, written) }
  }
  if (!config.headers || Object.keys(config.headers).length === 0) {
    return { config: sealed, referenced }
  }
  const headers: Record<string, string> = {}
  let origin: string | null = null
  for (const [header, value] of Object.entries(config.headers)) {
    const placeholderName = mcpSecretPlaceholderName(value)
    if (placeholderName) {
      if (!secrets) {
        throw new Error('Secure storage is unavailable on this host.')
      }
      origin ??= originOf(config.url)
      const stored = await secrets.has(placeholderName)
      if (!stored.exists) {
        throw new Error(`The stored value of header "${header}" is gone. Enter it again.`)
      }
      if (stored.origin !== origin) {
        throw new Error(
          `The stored value of header "${header}" belongs to ${stored.origin ?? 'another address'}. Enter it again for ${origin}.`,
        )
      }
      referenced.add(placeholderName)
      headers[header] = mcpSecretPlaceholder(placeholderName)
      continue
    }
    if (!isSensitiveMcpHeader(header)) {
      headers[header] = value
      continue
    }
    if (!secrets) {
      throw new Error(
        `Secure storage is unavailable on this host, so the "${header}" header cannot be saved.`,
      )
    }
    origin ??= originOf(config.url)
    const name = await unusedName(mcpHeaderSecretName(serverId, header), secrets)
    await secrets.set(name, value, origin)
    written.add(name)
    referenced.add(name)
    headers[header] = mcpSecretPlaceholder(name)
  }
  return { config: { ...sealed, headers }, referenced }
}

/** A stdio server's env with its credentials moved into the store as
 *  process-only secrets. */
async function sealEnv(
  serverId: string,
  env: Record<string, string>,
  secrets: McpSecretsStore | undefined,
  referenced: Set<string>,
  written: Set<string>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [envName, value] of Object.entries(env)) {
    const placeholderName = mcpSecretPlaceholderName(value)
    if (placeholderName) {
      if (!secrets) {
        throw new Error('Secure storage is unavailable on this host.')
      }
      const stored = await secrets.has(placeholderName)
      if (!stored.exists) {
        throw new Error(`The stored value of variable "${envName}" is gone. Enter it again.`)
      }
      // A header's secret is bound to an origin and has no process mark.
      if (stored.origin) {
        throw new Error(
          `The stored value of variable "${envName}" belongs to ${stored.origin}. Enter it again.`,
        )
      }
      referenced.add(placeholderName)
      out[envName] = mcpSecretPlaceholder(placeholderName)
      continue
    }
    if (!isSensitiveMcpEnv(envName)) {
      out[envName] = value
      continue
    }
    if (!secrets) {
      throw new Error(
        `Secure storage is unavailable on this host, so the "${envName}" variable cannot be saved.`,
      )
    }
    const name = await unusedName(mcpEnvSecretName(serverId, envName), secrets)
    await secrets.set(name, value, undefined, { processEnv: true })
    written.add(name)
    referenced.add(name)
    out[envName] = mcpSecretPlaceholder(name)
  }
  return out
}

/** Delete the secrets of `serverId` that `keep` does not name. Best-effort:
 *  a failure leaves an orphan in the store, never fails the save. */
export async function pruneMcpServerSecrets(
  serverId: string,
  keep: ReadonlySet<string>,
  secrets: McpSecretsStore | undefined,
): Promise<void> {
  if (!secrets) return
  const prefix = mcpServerSecretPrefix(serverId)
  try {
    const stored = await secrets.listNames('mcp')
    for (const { name } of stored) {
      if (name.startsWith(prefix) && !keep.has(name)) {
        await secrets.delete(name as BridgeSecretName)
      }
    }
  } catch (error) {
    console.warn(
      `[mcp] Could not prune stored secrets of "${serverId}":`,
      error instanceof Error ? error.message : error,
    )
  }
}
