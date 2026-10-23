/**
 * Security: the manifest's `providers` component, which the consented grant is read
 * from, so every rule errs on refusing: a provider with ANY bad field is dropped
 * whole, and an unknown value is a refusal with a reason, never a silent downgrade.
 * Pure.
 */

import { isLocalizedText, resolveLocalizedText, whyNotLocalizedText, type LocalizedText } from '../../config/localizedText'
import type { PluginUserConfigField } from '../../pluginHost/pluginModel'
import { readUserConfigFields } from '../../pluginHost/userConfigFields'
import { joinRuntimePath } from '../../utils/runtimePaths'
import {
  CHAIN_FIELDS,
  ID_ALPHABETS,
  ID_DERIVES,
  ID_KINDS,
  validateIdRule,
  type IdKind,
  type IdRuleShape,
} from './ids/idRules'

/** The `providerApi` values this Velloc serves. A manifest naming another is
 *  refused with a message that names it. */
export const SUPPORTED_PROVIDER_APIS: readonly number[] = Object.freeze([1])

/** The codec ids a provider may speak by default (`models/drivers`), and the
 *  two short spellings the plan uses for them. */
const WIRE_FORMATS = ['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini'] as const
export type ProviderWireFormat = (typeof WIRE_FORMATS)[number]
const FORMAT_ALIASES: Readonly<Record<string, ProviderWireFormat>> = Object.freeze({
  anthropic: 'anthropic-messages',
  google: 'gemini',
})

export const PROVIDER_CREDENTIAL_METHODS = ['apiKey', 'anonymous', 'login'] as const
export type ProviderCredentialMethod = (typeof PROVIDER_CREDENTIAL_METHODS)[number]

export const PROVIDER_REQUEST_NEEDS = ['system', 'tools', 'body', 'cwd'] as const
export type ProviderRequestNeed = (typeof PROVIDER_REQUEST_NEEDS)[number]
export type ProviderSignNeed = 'digest' | 'body'

/** One credential the provider stores beyond the API key — a host secret
 *  (`settings.json` `secrets.<name>`), referenced by requests as
 *  `{{secret:<name>}}`. */
export type ProviderSecretDecl = {
  name: string
  label?: LocalizedText
  hint?: LocalizedText
}

export type CredentialRule = { key: string; op: 'eq' | 'neq'; value: string }
export type CredentialPrompt =
  | {
      type: 'text'
      key: string
      message: LocalizedText
      placeholder?: LocalizedText
      secret?: boolean
      pattern?: string
      when?: CredentialRule
    }
  | {
      type: 'select'
      key: string
      message: LocalizedText
      options: Array<{ label: LocalizedText; value: string; hint?: LocalizedText }>
      when?: CredentialRule
    }

export type ProviderCredentials = {
  methods: ProviderCredentialMethod[]
  secrets?: ProviderSecretDecl[]
  prompts?: CredentialPrompt[]
  readsSecrets?: boolean
}

/** A settings field: `PluginUserConfigField` with text a vendor may localize. */
export type ProviderSettingField = Omit<PluginUserConfigField, 'title' | 'description'> & {
  title: LocalizedText
  description?: LocalizedText
}

/** A link on the aggregated "Add models" page (https only). */
export type ProviderModelsLink = { label: LocalizedText; url: string }

/**
 * How the provider's aggregated "Add models" page is drawn. All declarative:
 * the page renders it, no plugin code runs there. `groups` / `tags` are the
 * names a listing row may use in its own `group` / `tags` fields; a name not
 * declared here is shown as its raw text. `customModels` (present) lets the
 * person add models of their own, in the listed wire formats.
 */
export type ProviderModelsUi = {
  intro?: LocalizedText
  empty?: LocalizedText
  links?: ProviderModelsLink[]
  groups?: Record<string, { label: LocalizedText; order?: number }>
  tags?: Record<string, { label: LocalizedText }>
  /** Tag names the page offers as filter chips (labelled by `tags`). */
  filters?: string[]
  /**
   * Model ids picked for the person on the first verified connection, when
   * none are picked yet (a built-in gateway's `starterModels`). Ids the listing
   * does not have are skipped.
   */
  starterModels?: string[]
  /**
   * The provider's own tier ladder: the model id each sub-session tier
   * (`best` / `balanced` / `fast`) runs on, as the listing states it. Becomes
   * the provider's `bestModel` / `balancedModel` / `fastModel`; an unset tier
   * keeps the borrowed-ladder fallback.
   */
  tierModels?: Partial<Record<ProviderModelTier, string>>
  customModels?: {
    formats: ProviderWireFormat[]
    /**
     * What a hand-added model of a format needs on the wire (the same shape a
     * listing row's `wire` has: `baseUrl`, `path`, `headers`, `compat`), as a
     * listed model of that format would get it. Read defensively where it is
     * applied; the format itself comes from the model.
     */
    wires?: Partial<Record<ProviderWireFormat, Record<string, unknown>>>
  }
}

export const PROVIDER_ID_KINDS = ID_KINDS
export type ProviderIdKind = IdKind
const ID_DERIVES_LIST: readonly string[] = ID_DERIVES
const ID_ALPHABET_LIST: readonly string[] = ID_ALPHABETS
const CHAIN_FIELD_LIST: readonly string[] = CHAIN_FIELDS
/** The shape of an id rule; the id mapper (ids/idMapper.ts) runs it. */
export type ProviderIdRule = IdRuleShape

export type ProviderManifest = {
  providerApi: number
  displayName: LocalizedText
  /** Package-relative `.svg`, `./`-prefixed. */
  icon?: string
  defaultBaseUrl: string
  /** Every host the provider's requests reach (lower case). */
  domains: string[]
  format: ProviderWireFormat
  credentials: ProviderCredentials
  settings?: Record<string, ProviderSettingField>
  modelsUi?: ProviderModelsUi
  requestNeeds?: ProviderRequestNeed[]
  signNeeds?: ProviderSignNeed
  ids?: Partial<Record<ProviderIdKind, ProviderIdRule>>
  updates?: { marketplace?: string; url?: string }
  /** Package-relative module path, `./`-prefixed. */
  module: string
}

/** One provider of an active plugin: the manifest, its registered id, and its
 *  module / icon as absolute paths inside the plugin directory. */
export type ResolvedProvider = {
  key: string
  /** `mod.<plugin>.<key>` */
  id: string
  manifest: ProviderManifest
  modulePath: string
  iconPath?: string
}

// ── ids ──

export const MOD_PROVIDER_ID_PREFIX = 'mod.'
/** The host's secret-name charset (`IsValidSecretName`); a provider id is also
 *  a secret scope, so it keeps to it. */
export const PROVIDER_ID_MAX_LENGTH = 64
const ID_CHARS = /^[A-Za-z0-9_.-]+$/
const PLUGIN_PART = /^[A-Za-z0-9_-]+$/
const KEY_PART = /^[A-Za-z0-9_-]{1,32}$/

/** The registered id of a plugin's provider. */
export function modProviderId(plugin: string, key: string): string {
  return `${MOD_PROVIDER_ID_PREFIX}${plugin}.${key}`
}

export function isModProviderId(id: string | undefined): boolean {
  return !!id && id.startsWith(MOD_PROVIDER_ID_PREFIX) && id.length <= PROVIDER_ID_MAX_LENGTH && ID_CHARS.test(id)
}

// ── validation ──

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')

const insidePlugin = (p: string): boolean => p.startsWith('./') && !p.includes('..') && !p.includes('\\')
const MODULE_PATH = /\.[cm]?[jt]sx?$/i
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/
const SECRET_NAME = /^[A-Za-z0-9_.-]{1,64}$/
const PROMPT_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/
const PREFIX = /^[A-Za-z0-9_-]{0,32}$/
const PATTERN_MAX = 200
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

type Problems = (message: string) => void

function localized(value: unknown, label: string, bad: Problems): LocalizedText | undefined {
  if (isLocalizedText(value)) return value
  bad(`${label} ${whyNotLocalizedText(value)}`)
  return undefined
}

function optionalLocalized(raw: Record<string, unknown>, field: string, label: string, bad: Problems): LocalizedText | undefined {
  return raw[field] === undefined ? undefined : localized(raw[field], `${label}.${field}`, bad)
}

function unknownKeys(raw: Record<string, unknown>, allowed: readonly string[], label: string, bad: Problems): void {
  const extra = Object.keys(raw).filter(key => !allowed.includes(key))
  if (extra.length > 0) bad(`${label}: unknown ${extra.length === 1 ? 'property' : 'properties'} ${extra.map(k => `"${k}"`).join(', ')}`)
}

function checkDomains(value: unknown, bad: Problems): string[] | undefined {
  if (!isStringList(value) || value.length === 0) {
    bad('domains: expected a non-empty list of host names')
    return undefined
  }
  if (value.length > 16) {
    bad('domains: at most 16 host names')
    return undefined
  }
  const out: string[] = []
  for (const entry of value) {
    const host = entry.trim().toLowerCase()
    if (!HOSTNAME.test(host)) {
      bad(`domains: "${entry}" is not a plain host name (no scheme, port, path or wildcard)`)
      return undefined
    }
    if (!out.includes(host)) out.push(host)
  }
  return out
}

/** The host of `url` is one of `domains`, or a sub-domain of one. */
function coveredBy(host: string, domains: readonly string[]): boolean {
  return domains.some(domain => host === domain || host.endsWith(`.${domain}`))
}

function checkBaseUrl(value: unknown, domains: readonly string[] | undefined, bad: Problems): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    bad('defaultBaseUrl: required and must be a URL')
    return undefined
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    bad(`defaultBaseUrl: "${value}" is not a URL`)
    return undefined
  }
  const loopback = LOOPBACK.has(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    bad('defaultBaseUrl: must be https (plain http only for a loopback host)')
    return undefined
  }
  if (url.username || url.password) {
    bad('defaultBaseUrl: must not carry credentials')
    return undefined
  }
  if (url.search || url.hash) {
    bad('defaultBaseUrl: must not carry a query or a fragment')
    return undefined
  }
  if (domains && !coveredBy(url.hostname.toLowerCase(), domains)) {
    bad(`defaultBaseUrl: host "${url.hostname}" is not among the declared domains — domains must include the base URL's host`)
    return undefined
  }
  return value.replace(/\/+$/, '')
}

function checkFormat(value: unknown, bad: Problems): ProviderWireFormat | undefined {
  if (typeof value === 'string') {
    if ((WIRE_FORMATS as readonly string[]).includes(value)) return value as ProviderWireFormat
    const aliased = FORMAT_ALIASES[value]
    if (aliased) return aliased
  }
  bad(`format: expected one of ${[...WIRE_FORMATS, ...Object.keys(FORMAT_ALIASES)].join(' / ')}`)
  return undefined
}

function checkRule(value: unknown, at: string, bad: Problems): CredentialRule | undefined {
  if (!isRecord(value)) {
    bad(`${at}: expected { key, op, value }`)
    return undefined
  }
  unknownKeys(value, ['key', 'op', 'value'], at, bad)
  if (typeof value.key !== 'string' || !PROMPT_KEY.test(value.key)) {
    bad(`${at}.key: expected a prompt key`)
    return undefined
  }
  if (value.op !== 'eq' && value.op !== 'neq') {
    bad(`${at}.op: expected "eq" or "neq"`)
    return undefined
  }
  if (typeof value.value !== 'string') {
    bad(`${at}.value: expected text`)
    return undefined
  }
  return { key: value.key, op: value.op, value: value.value }
}

function checkSecrets(value: unknown, bad: Problems): ProviderSecretDecl[] | undefined {
  if (!Array.isArray(value)) {
    bad('credentials.secrets: expected a list')
    return undefined
  }
  const out: ProviderSecretDecl[] = []
  const seen = new Set<string>()
  for (const [index, raw] of value.entries()) {
    const at = `credentials.secrets[${index}]`
    if (!isRecord(raw)) {
      bad(`${at}: expected an object with a "name"`)
      return undefined
    }
    unknownKeys(raw, ['name', 'label', 'hint'], at, bad)
    if (typeof raw.name !== 'string' || !SECRET_NAME.test(raw.name)) {
      bad(`${at}.name: must be 1-64 characters of letters, digits, "_", "." and "-"`)
      return undefined
    }
    if (raw.name === 'api_key') {
      bad(`${at}.name: "api_key" is the API key itself — declare only credentials beyond it`)
      return undefined
    }
    if (seen.has(raw.name)) {
      bad(`${at}.name: "${raw.name}" is declared twice`)
      return undefined
    }
    seen.add(raw.name)
    const label = optionalLocalized(raw, 'label', at, bad)
    const hint = optionalLocalized(raw, 'hint', at, bad)
    if ((raw.label !== undefined && label === undefined) || (raw.hint !== undefined && hint === undefined)) return undefined
    out.push({ name: raw.name, ...(label !== undefined ? { label } : {}), ...(hint !== undefined ? { hint } : {}) })
  }
  return out
}

function checkPrompts(value: unknown, secretNames: ReadonlySet<string>, bad: Problems): CredentialPrompt[] | undefined {
  if (!Array.isArray(value)) {
    bad('credentials.prompts: expected a list')
    return undefined
  }
  const keys = new Set<string>()
  for (const raw of value) if (isRecord(raw) && typeof raw.key === 'string') keys.add(raw.key)
  const out: CredentialPrompt[] = []
  const seen = new Set<string>()
  for (const [index, raw] of value.entries()) {
    const at = `credentials.prompts[${index}]`
    if (!isRecord(raw)) {
      bad(`${at}: expected an object`)
      return undefined
    }
    if (raw.type !== 'text' && raw.type !== 'select') {
      bad(`${at}.type: expected "text" or "select"`)
      return undefined
    }
    if (typeof raw.key !== 'string' || !PROMPT_KEY.test(raw.key)) {
      bad(`${at}.key: expected letters, digits, "_", "." or "-", not starting with a digit`)
      return undefined
    }
    if (seen.has(raw.key)) {
      bad(`${at}.key: "${raw.key}" is used by two prompts`)
      return undefined
    }
    seen.add(raw.key)
    const message = localized(raw.message, `${at}.message`, bad)
    if (message === undefined) return undefined
    let when: CredentialRule | undefined
    if (raw.when !== undefined) {
      when = checkRule(raw.when, `${at}.when`, bad)
      if (!when) return undefined
      if (when.key === raw.key || !keys.has(when.key)) {
        bad(`${at}.when.key: "${when.key}" must be another prompt's key`)
        return undefined
      }
    }
    if (raw.type === 'text') {
      unknownKeys(raw, ['type', 'key', 'message', 'placeholder', 'secret', 'pattern', 'when'], at, bad)
      const placeholder = optionalLocalized(raw, 'placeholder', at, bad)
      if (raw.placeholder !== undefined && placeholder === undefined) return undefined
      if (raw.secret !== undefined && typeof raw.secret !== 'boolean') {
        bad(`${at}.secret: expected true or false`)
        return undefined
      }
      // "A secret answer goes straight to the named secrets": the key IS that name.
      if (raw.secret === true && raw.key !== 'api_key' && !secretNames.has(raw.key)) {
        bad(`${at}.key: a secret prompt answers a credential, so "${raw.key}" must be "api_key" or a declared credentials.secrets name`)
        return undefined
      }
      if (raw.pattern !== undefined) {
        if (typeof raw.pattern !== 'string' || raw.pattern === '' || raw.pattern.length > PATTERN_MAX) {
          bad(`${at}.pattern: expected a regular expression of at most ${PATTERN_MAX} characters`)
          return undefined
        }
        try {
          new RegExp(raw.pattern)
        } catch {
          bad(`${at}.pattern: "${raw.pattern}" is not a valid regular expression`)
          return undefined
        }
      }
      out.push({
        type: 'text',
        key: raw.key,
        message,
        ...(placeholder !== undefined ? { placeholder } : {}),
        ...(raw.secret === true ? { secret: true } : {}),
        ...(typeof raw.pattern === 'string' ? { pattern: raw.pattern } : {}),
        ...(when ? { when } : {}),
      })
      continue
    }
    unknownKeys(raw, ['type', 'key', 'message', 'options', 'when'], at, bad)
    if (!Array.isArray(raw.options) || raw.options.length === 0) {
      bad(`${at}.options: expected a non-empty list`)
      return undefined
    }
    const options: Array<{ label: LocalizedText; value: string; hint?: LocalizedText }> = []
    const values = new Set<string>()
    for (const [o, option] of raw.options.entries()) {
      const oat = `${at}.options[${o}]`
      if (!isRecord(option)) {
        bad(`${oat}: expected { label, value }`)
        return undefined
      }
      unknownKeys(option, ['label', 'value', 'hint'], oat, bad)
      const label = localized(option.label, `${oat}.label`, bad)
      if (label === undefined) return undefined
      if (typeof option.value !== 'string' || option.value === '') {
        bad(`${oat}.value: expected non-empty text`)
        return undefined
      }
      if (values.has(option.value)) {
        bad(`${oat}.value: "${option.value}" is listed twice`)
        return undefined
      }
      values.add(option.value)
      const hint = optionalLocalized(option, 'hint', oat, bad)
      if (option.hint !== undefined && hint === undefined) return undefined
      options.push({ label, value: option.value, ...(hint !== undefined ? { hint } : {}) })
    }
    out.push({ type: 'select', key: raw.key, message, options, ...(when ? { when } : {}) })
  }
  // A rule names a select's value: it must be one the select can answer.
  for (const prompt of out) {
    if (!prompt.when) continue
    const target = out.find(p => p.key === prompt.when!.key)
    if (target?.type === 'select' && !target.options.some(o => o.value === prompt.when!.value)) {
      bad(`credentials.prompts "${prompt.key}".when.value: "${prompt.when.value}" is not one of "${target.key}"'s options`)
      return undefined
    }
  }
  return out
}

function checkCredentials(value: unknown, bad: Problems): ProviderCredentials | undefined {
  if (!isRecord(value)) {
    bad('credentials: required and must be an object')
    return undefined
  }
  unknownKeys(value, ['methods', 'secrets', 'prompts', 'readsSecrets'], 'credentials', bad)
  const { methods } = value
  if (!Array.isArray(methods) || methods.length === 0) {
    bad(`credentials.methods: expected a non-empty list of ${PROVIDER_CREDENTIAL_METHODS.join(' / ')}`)
    return undefined
  }
  const kept: ProviderCredentialMethod[] = []
  for (const method of methods) {
    if (!(PROVIDER_CREDENTIAL_METHODS as readonly unknown[]).includes(method)) {
      bad(`credentials.methods: "${String(method)}" is not one of ${PROVIDER_CREDENTIAL_METHODS.join(' / ')}`)
      return undefined
    }
    if (!kept.includes(method as ProviderCredentialMethod)) kept.push(method as ProviderCredentialMethod)
  }
  const out: ProviderCredentials = { methods: kept }
  let secrets: ProviderSecretDecl[] = []
  if (value.secrets !== undefined) {
    const checked = checkSecrets(value.secrets, bad)
    if (!checked) return undefined
    secrets = checked
    if (secrets.length > 0) out.secrets = secrets
  }
  if (value.prompts !== undefined) {
    const prompts = checkPrompts(value.prompts, new Set(secrets.map(s => s.name)), bad)
    if (!prompts) return undefined
    if (prompts.length > 0) out.prompts = prompts
  }
  if (value.readsSecrets !== undefined) {
    if (typeof value.readsSecrets !== 'boolean') {
      bad('credentials.readsSecrets: expected true or false')
      return undefined
    }
    if (value.readsSecrets) out.readsSecrets = true
  }
  return out
}

const MODELS_UI_NAME = /^[A-Za-z0-9_.-]{1,40}$/
/** A name the page already owns: a free model wears the platform's Free mark
 *  and is offered by "Add free models", so a manifest's own `free` tag label or
 *  filter chip would show the same thing twice. Dropped, not refused. */
export const PLATFORM_FREE_TAG = 'free'
const STARTER_MODEL_ID = /^\S{1,256}$/
const STARTER_MODELS_MAX = 8
const MODEL_TIERS = ['best', 'balanced', 'fast'] as const
export type ProviderModelTier = (typeof MODEL_TIERS)[number]
const MODELS_UI_MAX_ENTRIES = 32

function checkModelsUi(value: unknown, bad: Problems): ProviderModelsUi | undefined {
  if (!isRecord(value)) {
    bad('modelsUi: expected an object')
    return undefined
  }
  unknownKeys(value, ['intro', 'empty', 'links', 'groups', 'tags', 'filters', 'starterModels', 'tierModels', 'customModels'], 'modelsUi', bad)
  const out: ProviderModelsUi = {}
  const intro = optionalLocalized(value, 'intro', 'modelsUi', bad)
  if (intro !== undefined) out.intro = intro
  const empty = optionalLocalized(value, 'empty', 'modelsUi', bad)
  if (empty !== undefined) out.empty = empty
  if (value.links !== undefined) {
    if (!Array.isArray(value.links) || value.links.length > 8) {
      bad('modelsUi.links: expected a list of at most 8 links')
    } else {
      const links: ProviderModelsLink[] = []
      value.links.forEach((raw: unknown, index: number) => {
        const at = `modelsUi.links[${index}]`
        if (!isRecord(raw)) return bad(`${at}: expected an object`)
        const label = localized(raw.label, `${at}.label`, bad)
        let https = false
        try {
          https = typeof raw.url === 'string' && new URL(raw.url).protocol === 'https:'
        } catch {
          https = false
        }
        if (!https) return bad(`${at}.url: expected an https URL`)
        if (label !== undefined) links.push({ label, url: raw.url as string })
      })
      if (links.length > 0) out.links = links
    }
  }
  for (const field of ['groups', 'tags'] as const) {
    const raw = value[field]
    if (raw === undefined) continue
    if (!isRecord(raw) || Object.keys(raw).length > MODELS_UI_MAX_ENTRIES) {
      bad(`modelsUi.${field}: expected an object of at most ${MODELS_UI_MAX_ENTRIES} names`)
      continue
    }
    const named: Record<string, { label: LocalizedText; order?: number }> = {}
    for (const [name, entry] of Object.entries(raw)) {
      const at = `modelsUi.${field}.${name}`
      if (!MODELS_UI_NAME.test(name)) {
        bad(`${at}: a name is letters, digits, "_", "-" or "." (at most 40)`)
        continue
      }
      if (!isRecord(entry)) {
        bad(`${at}: expected an object`)
        continue
      }
      if (field === 'tags' && name === PLATFORM_FREE_TAG) continue
      const label = localized(entry.label, `${at}.label`, bad)
      if (label === undefined) continue
      if (field === 'groups' && entry.order !== undefined && !(typeof entry.order === 'number' && Number.isFinite(entry.order))) {
        bad(`${at}.order: expected a number`)
        continue
      }
      named[name] = { label, ...(field === 'groups' && typeof entry.order === 'number' ? { order: entry.order } : {}) }
    }
    if (Object.keys(named).length > 0) {
      if (field === 'groups') out.groups = named
      else out.tags = Object.fromEntries(Object.entries(named).map(([k, v]) => [k, { label: v.label }]))
    }
  }
  if (value.filters !== undefined) {
    if (!isStringList(value.filters) || value.filters.length > 8 || !value.filters.every(name => MODELS_UI_NAME.test(name))) {
      bad('modelsUi.filters: expected a list of at most 8 tag names')
    } else {
      const filters = [...new Set(value.filters)].filter(name => name !== PLATFORM_FREE_TAG)
      if (filters.length > 0) out.filters = filters
    }
  }
  if (value.starterModels !== undefined) {
    if (
      !isStringList(value.starterModels)
      || value.starterModels.length > STARTER_MODELS_MAX
      || !value.starterModels.every(id => STARTER_MODEL_ID.test(id))
    ) {
      bad(`modelsUi.starterModels: expected a list of at most ${STARTER_MODELS_MAX} model ids`)
    } else if (value.starterModels.length > 0) out.starterModels = [...new Set(value.starterModels)]
  }
  if (value.tierModels !== undefined) {
    const raw = value.tierModels
    if (!isRecord(raw)) bad('modelsUi.tierModels: expected an object keyed by best / balanced / fast')
    else {
      unknownKeys(raw, MODEL_TIERS, 'modelsUi.tierModels', bad)
      const tiers: Partial<Record<ProviderModelTier, string>> = {}
      for (const tier of MODEL_TIERS) {
        const id = raw[tier]
        if (id === undefined) continue
        // A mod has no family rows, so a family key (`*`) would name nothing.
        if (typeof id !== 'string' || !STARTER_MODEL_ID.test(id) || id.includes('*')) {
          bad(`modelsUi.tierModels.${tier}: expected a model id`)
        } else tiers[tier] = id
      }
      if (Object.keys(tiers).length > 0) out.tierModels = tiers
    }
  }
  if (value.customModels !== undefined) {
    const raw = value.customModels
    if (!isRecord(raw)) bad('modelsUi.customModels: expected an object')
    else {
      unknownKeys(raw, ['formats', 'wires'], 'modelsUi.customModels', bad)
      const formats = raw.formats === undefined ? [...WIRE_FORMATS] : raw.formats
      if (!isStringList(formats) || formats.length === 0 || !formats.every(f => (WIRE_FORMATS as readonly string[]).includes(f))) {
        bad(`modelsUi.customModels.formats: expected a non-empty list of ${WIRE_FORMATS.join(' / ')}`)
      } else {
        out.customModels = { formats: [...new Set(formats)] as ProviderWireFormat[] }
        if (raw.wires !== undefined) {
          if (!isRecord(raw.wires)) bad('modelsUi.customModels.wires: expected an object keyed by wire format')
          else {
            const wires: Record<string, Record<string, unknown>> = {}
            for (const [format, wire] of Object.entries(raw.wires)) {
              const at = `modelsUi.customModels.wires.${format}`
              if (!(WIRE_FORMATS as readonly string[]).includes(format)) bad(`${at}: not a wire format`)
              else if (!isRecord(wire)) bad(`${at}: expected an object`)
              else {
                unknownKeys(wire, ['baseUrl', 'baseUrlTrim', 'path', 'headers', 'compat'], at, bad)
                if (wire.baseUrlTrim !== undefined && (typeof wire.baseUrlTrim !== 'string' || !wire.baseUrlTrim.startsWith('/'))) {
                  bad(`${at}.baseUrlTrim: expected a path suffix starting with '/'`)
                } else if (wire.baseUrlTrim !== undefined && wire.baseUrl !== undefined) {
                  bad(`${at}: baseUrl and baseUrlTrim cannot both be set`)
                } else {
                  wires[format] = wire
                }
              }
            }
            if (Object.keys(wires).length > 0) out.customModels.wires = wires
          }
        }
      }
    }
  }
  return out
}

function checkSettings(value: unknown, bad: Problems): Record<string, ProviderSettingField> | undefined {
  if (!isRecord(value)) {
    bad('settings: expected an object of fields')
    return undefined
  }
  // The field rules are plugin `userConfig`'s own: check each field through
  // them with the vendor's localized text standing in as plain text, then put
  // the text back.
  const shadow: Record<string, unknown> = {}
  const texts: Record<string, { title: LocalizedText; description?: LocalizedText }> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw)) {
      shadow[key] = raw
      continue
    }
    const title = localized(raw.title, `settings.${key}.title`, bad)
    const description = raw.description === undefined ? undefined : localized(raw.description, `settings.${key}.description`, bad)
    if (title === undefined || (raw.description !== undefined && description === undefined)) return undefined
    texts[key] = { title, ...(description !== undefined ? { description } : {}) }
    shadow[key] = {
      ...raw,
      title: resolveLocalizedText(title, 'en'),
      description: description !== undefined ? resolveLocalizedText(description, 'en') : '',
    }
  }
  const problems: string[] = []
  const fields = readUserConfigFields(shadow, problems)
  if (problems.length > 0) {
    for (const problem of problems) bad(problem.replace(/^userConfig\./, 'settings.'))
    return undefined
  }
  const out: Record<string, ProviderSettingField> = {}
  for (const [key, field] of Object.entries(fields)) {
    const { title: _title, description: _description, ...rest } = field
    out[key] = { ...rest, ...texts[key]! }
  }
  return out
}

function checkIds(value: unknown, bad: Problems): ProviderManifest['ids'] | undefined {
  if (!isRecord(value)) {
    bad('ids: expected an object keyed by id kind')
    return undefined
  }
  const out: NonNullable<ProviderManifest['ids']> = {}
  for (const [kind, raw] of Object.entries(value)) {
    const at = `ids.${kind}`
    if (!(PROVIDER_ID_KINDS as readonly string[]).includes(kind)) {
      bad(`${at}: unknown id kind (expected ${PROVIDER_ID_KINDS.join(' / ')})`)
      return undefined
    }
    if (!isRecord(raw)) {
      bad(`${at}: expected a rule object`)
      return undefined
    }
    unknownKeys(raw, ['derive', 'prefix', 'alphabet', 'length', 'template', 'over'], at, bad)
    if (!ID_DERIVES_LIST.includes(raw.derive as string)) {
      bad(`${at}.derive: expected one of ${ID_DERIVES_LIST.join(' / ')}`)
      return undefined
    }
    const derive = raw.derive as ProviderIdRule['derive']
    if (derive === 'random' && kind !== 'request') {
      bad(`${at}.derive: "random" is for the request kind only — the other kinds must repeat on a re-sent history`)
      return undefined
    }
    const rule: ProviderIdRule = { derive }
    if (raw.prefix !== undefined) {
      if (typeof raw.prefix !== 'string' || !PREFIX.test(raw.prefix)) {
        bad(`${at}.prefix: expected up to 32 characters of letters, digits, "_" and "-"`)
        return undefined
      }
      rule.prefix = raw.prefix
    }
    if (raw.alphabet !== undefined) {
      if (!ID_ALPHABET_LIST.includes(raw.alphabet as string)) {
        bad(`${at}.alphabet: expected one of ${ID_ALPHABET_LIST.join(' / ')}`)
        return undefined
      }
      rule.alphabet = raw.alphabet as ProviderIdRule['alphabet']
    }
    if (raw.length !== undefined) {
      if (typeof raw.length !== 'number' || !Number.isInteger(raw.length) || raw.length < 1 || raw.length > 256) {
        bad(`${at}.length: expected a whole number from 1 to 256`)
        return undefined
      }
      rule.length = raw.length
    }
    if (raw.template !== undefined) {
      if (typeof raw.template !== 'string' || raw.template === '' || raw.template.length > 200) {
        bad(`${at}.template: expected text of at most 200 characters`)
        return undefined
      }
      rule.template = raw.template
    }
    if (derive === 'chain') {
      if (!Array.isArray(raw.over) || raw.over.length === 0 || !raw.over.every(f => CHAIN_FIELD_LIST.includes(f as string))) {
        bad(`${at}.over: a chain rule needs a non-empty list of ${CHAIN_FIELD_LIST.join(' / ')}`)
        return undefined
      }
      rule.over = [...new Set(raw.over as NonNullable<IdRuleShape['over']>)]
    } else if (raw.over !== undefined) {
      bad(`${at}.over: only a chain rule has one`)
      return undefined
    }
    const problem = validateIdRule(kind as IdKind, rule)
    if (problem) {
      bad(`${at}: ${problem}`)
      return undefined
    }
    out[kind as ProviderIdKind] = rule
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function checkUpdates(value: unknown, bad: Problems): ProviderManifest['updates'] | undefined {
  if (!isRecord(value)) {
    bad('updates: expected an object with a "marketplace" or a "url"')
    return undefined
  }
  unknownKeys(value, ['marketplace', 'url'], 'updates', bad)
  const out: NonNullable<ProviderManifest['updates']> = {}
  if (value.marketplace !== undefined) {
    if (typeof value.marketplace !== 'string' || value.marketplace.trim() === '') {
      bad('updates.marketplace: expected text')
      return undefined
    }
    out.marketplace = value.marketplace
  }
  if (value.url !== undefined) {
    let ok = false
    try {
      ok = typeof value.url === 'string' && new URL(value.url).protocol === 'https:'
    } catch {
      ok = false
    }
    if (!ok) {
      bad('updates.url: expected an https URL')
      return undefined
    }
    out.url = value.url as string
  }
  return out
}

/** The provider-level fields; anything not listed is ignored, as a newer
 *  manifest may carry fields an older Velloc does not know. */
function checkProvider(key: string, raw: unknown, errors: string[]): ProviderManifest | undefined {
  const label = `providers.${key}`
  let failed = false
  const bad: Problems = message => {
    failed = true
    errors.push(`${label}.${message}`)
  }
  if (!isRecord(raw)) {
    errors.push(`${label}: expected an object`)
    return undefined
  }

  const api = raw.providerApi
  if (typeof api !== 'number' || !Number.isInteger(api)) {
    bad('providerApi: required and must be a whole number')
    return undefined
  }
  if (!SUPPORTED_PROVIDER_APIS.includes(api)) {
    bad(`providerApi: ${api} is not supported by this Velloc (it supports ${SUPPORTED_PROVIDER_APIS.join(', ')})`)
    return undefined
  }

  const displayName = localized(raw.displayName, 'displayName', bad)
  const domains = checkDomains(raw.domains, bad)
  const defaultBaseUrl = checkBaseUrl(raw.defaultBaseUrl, domains, bad)
  const format = checkFormat(raw.format, bad)
  const credentials = checkCredentials(raw.credentials, bad)

  let icon: string | undefined
  if (raw.icon !== undefined) {
    if (typeof raw.icon !== 'string' || !insidePlugin(raw.icon) || !raw.icon.toLowerCase().endsWith('.svg')) {
      bad('icon: must be a relative path to an .svg file, starting with "./" and without ".."')
    } else icon = raw.icon
  }
  let moduleRef: string | undefined
  if (typeof raw.module !== 'string' || !insidePlugin(raw.module) || !MODULE_PATH.test(raw.module)) {
    bad('module: required; a relative path to a script, starting with "./" and without ".."')
  } else moduleRef = raw.module

  let settings: Record<string, ProviderSettingField> | undefined
  if (raw.settings !== undefined) settings = checkSettings(raw.settings, bad)

  const modelsUi = raw.modelsUi === undefined ? undefined : checkModelsUi(raw.modelsUi, bad)

  let requestNeeds: ProviderRequestNeed[] | undefined
  if (raw.requestNeeds !== undefined) {
    if (!Array.isArray(raw.requestNeeds)) bad('requestNeeds: expected a list')
    else {
      const unknown = raw.requestNeeds.filter(n => !(PROVIDER_REQUEST_NEEDS as readonly unknown[]).includes(n))
      // A need this Velloc does not know is a refusal, never less data.
      if (unknown.length > 0) {
        bad(`requestNeeds: "${unknown.map(String).join('", "')}" ${unknown.length === 1 ? 'is' : 'are'} not known to this Velloc (it knows ${PROVIDER_REQUEST_NEEDS.join(' / ')}), so the provider is not loaded`)
      } else requestNeeds = [...new Set(raw.requestNeeds as ProviderRequestNeed[])]
    }
  }
  let signNeeds: ProviderSignNeed | undefined
  if (raw.signNeeds !== undefined) {
    if (raw.signNeeds !== 'digest' && raw.signNeeds !== 'body') {
      bad(`signNeeds: "${String(raw.signNeeds)}" is not known to this Velloc (it knows digest / body), so the provider is not loaded`)
    } else signNeeds = raw.signNeeds
  }
  const ids = raw.ids === undefined ? undefined : checkIds(raw.ids, bad)
  const updates = raw.updates === undefined ? undefined : checkUpdates(raw.updates, bad)

  if (failed || displayName === undefined || defaultBaseUrl === undefined || domains === undefined || format === undefined || credentials === undefined || moduleRef === undefined) {
    return undefined
  }
  return {
    providerApi: api,
    displayName,
    ...(icon !== undefined ? { icon } : {}),
    defaultBaseUrl,
    domains,
    format,
    credentials,
    ...(settings && Object.keys(settings).length > 0 ? { settings } : {}),
    ...(modelsUi && Object.keys(modelsUi).length > 0 ? { modelsUi } : {}),
    ...(requestNeeds && requestNeeds.length > 0 ? { requestNeeds } : {}),
    ...(signNeeds !== undefined ? { signNeeds } : {}),
    ...(ids ? { ids } : {}),
    ...(updates ? { updates } : {}),
    module: moduleRef,
  }
}

/**
 * Validate a manifest's `providers` map. A provider with any problem is left
 * out and each problem is appended to `errors`; the others are kept. The
 * plugin's own name must be able to form a provider id (`[A-Za-z0-9_-]`): no
 * provider is registered under a name that cannot.
 */
export function checkProviderManifests(
  pluginName: string,
  value: unknown,
  errors: string[],
): Record<string, ProviderManifest> | undefined {
  if (!isRecord(value)) {
    errors.push('providers: expected an object keyed by provider key')
    return undefined
  }
  if (!PLUGIN_PART.test(pluginName)) {
    errors.push(`providers: the plugin name "${pluginName}" cannot form a provider id — use letters, digits, "_" and "-" only`)
    return undefined
  }
  const out: Record<string, ProviderManifest> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!KEY_PART.test(key)) {
      errors.push(`providers.${key}: the key must be 1-32 characters of letters, digits, "_" and "-"`)
      continue
    }
    const id = modProviderId(pluginName, key)
    if (id.length > PROVIDER_ID_MAX_LENGTH) {
      errors.push(`providers.${key}: the provider id "${id}" is ${id.length} characters; the most is ${PROVIDER_ID_MAX_LENGTH}`)
      continue
    }
    const checked = checkProvider(key, raw, errors)
    if (checked) out[key] = checked
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** A plugin's validated providers with their ids and absolute module paths. */
export function resolveProviders(
  pluginName: string,
  pluginPath: string,
  providers: Readonly<Record<string, ProviderManifest>>,
): ResolvedProvider[] {
  const inside = (relative: string): string => joinRuntimePath(pluginPath, ...relative.replace(/^\.\//, '').split('/'))
  return Object.entries(providers).map(([key, manifest]) => ({
    key,
    id: modProviderId(pluginName, key),
    manifest,
    modulePath: inside(manifest.module),
    ...(manifest.icon !== undefined ? { iconPath: inside(manifest.icon) } : {}),
  }))
}
