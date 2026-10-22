/**
 * The pure half of the provider-mod form: which sign-in prompts show, whether
 * the answers fit, the rows of the one form and where each changed row goes on
 * Save, and the config an upsert writes. Driven by the catalog row's `mod`
 * field alone; renders nothing.
 */

import { resolveLocalizedText } from '../../../config/localizedText'
import type { BrowserLlmModProvider } from '../../bridge/protocol/nexus_llm'
import type {
  CredentialPrompt,
  CredentialRule,
  ProviderCredentialMethod,
} from '../../../mods/provider/providerManifest'
import type { NexusProviderConfig } from '../../../settings/settingsTypes'
import type { ModsOptionValue, ModsUserConfig, ModsUserConfigField } from '../../runtimeProtocol'
import { draftChanged, valuesOf, type OptionsDraft } from './modOptionsDraft'
import { hasUserProviderSetup } from './providerFormHelpers'
import { holdsModSignIn } from '../../../settings/providerSignIn'

/** The prompt key whose answer is the provider's API key (stored as `api_key`). */
export const API_KEY_PROMPT_KEY = 'api_key'
/** Non-secret sign-in answers are plugin options under this prefix, so they
 *  never collide with a declared settings field. */
export const SIGNIN_OPTION_PREFIX = 'signin.'
/** What a stored sensitive value shows as in the options form. */
export const MASKED_VALUE = '••••'

const SECRET_NAME = /^[A-Za-z0-9_.-]{1,64}$/

export type PromptAnswers = Readonly<Record<string, string>>

/** The methods a provider offers; a row that states none connects by key. */
export function credentialMethodsOf(mod: BrowserLlmModProvider | undefined): ProviderCredentialMethod[] {
  const methods = mod?.credentialMethods
  return methods && methods.length > 0 ? [...methods] : ['apiKey']
}

/** Whether `rule` holds over the answers given so far. */
export function ruleHolds(rule: CredentialRule, answers: PromptAnswers): boolean {
  const value = answers[rule.key] ?? ''
  return rule.op === 'eq' ? value === rule.value : value !== rule.value
}

/**
 * The prompts to draw, in order. A prompt's `when` reads the answers of the
 * prompts SHOWN before it: an answer to a prompt that is itself hidden does
 * not count, so a chain of rules cannot be satisfied by a stale answer.
 */
export function visiblePrompts(prompts: readonly CredentialPrompt[], answers: PromptAnswers): CredentialPrompt[] {
  const shown: CredentialPrompt[] = []
  const effective: Record<string, string> = {}
  for (const prompt of prompts) {
    if (prompt.when && !ruleHolds(prompt.when, effective)) continue
    shown.push(prompt)
    effective[prompt.key] = answers[prompt.key] ?? ''
  }
  return shown
}

export type PromptProblem = 'required' | 'pattern' | 'option'

/** Whether `value` satisfies a text prompt's `pattern`. A pattern that does
 *  not compile never matches (the form fails closed). */
export function satisfiesPromptPattern(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value)
  } catch {
    return false
  }
}

/**
 * What is wrong with the visible prompts' answers, by prompt key. A prompt
 * whose answer is blank is fine when a value is already stored for it
 * (`stored`): leaving it blank keeps that value.
 */
export function promptProblems(
  prompts: readonly CredentialPrompt[],
  answers: PromptAnswers,
  stored: ReadonlySet<string> = new Set(),
): Record<string, PromptProblem> {
  const problems: Record<string, PromptProblem> = {}
  for (const prompt of visiblePrompts(prompts, answers)) {
    const value = (answers[prompt.key] ?? '').trim()
    if (value === '') {
      if (!stored.has(prompt.key)) problems[prompt.key] = 'required'
      continue
    }
    if (prompt.type === 'select') {
      if (!prompt.options.some(option => option.value === value)) problems[prompt.key] = 'option'
    } else if (prompt.pattern !== undefined && !satisfiesPromptPattern(prompt.pattern, value)) {
      problems[prompt.key] = 'pattern'
    }
  }
  return problems
}

/** The synthetic prompt of an `apiKey` method that declares none: one secret field. */
export function defaultKeyPrompt(message: string): CredentialPrompt {
  return { type: 'text', key: API_KEY_PROMPT_KEY, message, secret: true }
}

export type PromptWrites = {
  /** The answer to the `api_key` prompt. */
  apiKey?: string
  /** `secret: true` answers, by prompt key: stored as named secrets. */
  secrets: Record<string, string>
  /** Non-secret answers as plugin options (`signin.<key>`). */
  options: Record<string, string>
  /** Every option name the prompts own, so a hidden prompt's old answer is cleared. */
  ownedOptions: string[]
}

/**
 * Where each answer goes. Blank answers write nothing (a stored value stays);
 * hidden prompts write nothing. A secret answer is never an option: it goes
 * straight to the named secrets and the page keeps no copy.
 */
export function promptWrites(prompts: readonly CredentialPrompt[], answers: PromptAnswers): PromptWrites {
  const writes: PromptWrites = { secrets: {}, options: {}, ownedOptions: [] }
  for (const prompt of prompts) {
    if (prompt.key !== API_KEY_PROMPT_KEY && !(prompt.type === 'text' && prompt.secret)) {
      writes.ownedOptions.push(SIGNIN_OPTION_PREFIX + prompt.key)
    }
  }
  for (const prompt of visiblePrompts(prompts, answers)) {
    const value = (answers[prompt.key] ?? '').trim()
    if (value === '') continue
    if (prompt.key === API_KEY_PROMPT_KEY) {
      writes.apiKey = value
    } else if (prompt.type === 'text' && prompt.secret) {
      if (SECRET_NAME.test(prompt.key)) writes.secrets[prompt.key] = value
    } else {
      writes.options[SIGNIN_OPTION_PREFIX + prompt.key] = value
    }
  }
  return writes
}

/** The stored non-secret answers, read back from the plugin's options. */
export function storedAnswers(
  prompts: readonly CredentialPrompt[],
  options: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const answers: Record<string, string> = {}
  for (const prompt of prompts) {
    const value = options[SIGNIN_OPTION_PREFIX + prompt.key]
    if (typeof value === 'string') answers[prompt.key] = value
  }
  return answers
}

/** The prompt keys that already hold a stored value (a secret or the API key). */
export function storedPromptKeys(
  prompts: readonly CredentialPrompt[],
  saved: NexusProviderConfig | undefined,
): Set<string> {
  const keys = new Set<string>()
  for (const prompt of prompts) {
    if (prompt.key === API_KEY_PROMPT_KEY ? saved?.hasApiKey === true : (saved?.storedSecrets ?? []).includes(prompt.key)) {
      keys.add(prompt.key)
    }
  }
  return keys
}

/**
 * The config a save writes. `providers.upsert` REPLACES the whole entry, so the
 * stored one is the base; the redacted `hasApiKey` / `storedSecrets` are dropped.
 * `apiKey` / `secrets` are written only when given; a new key drops the old
 * verification stamp.
 */
export function modProviderConfig(
  saved: NexusProviderConfig | undefined,
  change: { apiKey?: string; secrets?: Record<string, string>; credentialMode?: 'anonymous' | null } = {},
): NexusProviderConfig {
  const { hasApiKey: _flag, storedSecrets: _names, apiKey: _key, secrets: _secrets, ...base } = saved ?? {}
  const next: NexusProviderConfig = { ...base, source: 'mod' }
  if (change.apiKey !== undefined && change.apiKey !== '') {
    next.apiKey = change.apiKey
    delete next.lastVerification
  }
  if (change.secrets && Object.keys(change.secrets).length > 0) next.secrets = { ...change.secrets }
  if (change.credentialMode === 'anonymous') next.credentialMode = 'anonymous'
  else if (change.credentialMode === null) delete next.credentialMode
  return next
}

/** Whether a mod provider counts as ADDED (listed on the home page): a key,
 *  a sign-in, or the person's choice of the keyless mode. */
export function isModProviderAdded(saved: NexusProviderConfig | undefined): boolean {
  return hasUserProviderSetup(saved) || saved?.credentialMode === 'anonymous' || holdsModSignIn(saved)
}

/** Whether it reads as connected on its row. Nothing is probed here (the
 *  listing and the key check are the module's, a later package). */
export function isModProviderConnected(saved: NexusProviderConfig | undefined): boolean {
  return saved?.credentialMode === 'anonymous' || saved?.hasApiKey === true || holdsModSignIn(saved)
}

/** The declared settings as the options form takes them: the vendor's text
 *  resolved in the person's language, a stored sensitive value masked. */
export function settingsAsUserConfig(
  mod: BrowserLlmModProvider,
  options: Readonly<Record<string, unknown>>,
  storedSensitive: readonly string[],
  locale: string | undefined,
): ModsUserConfig {
  const fields: Record<string, ModsUserConfigField> = {}
  const values: Record<string, ModsUserConfig['values'][string]> = {}
  for (const [name, field] of Object.entries(mod.settings ?? {})) {
    fields[name] = {
      type: field.type,
      title: resolveLocalizedText(field.title, locale),
      description: resolveLocalizedText(field.description, locale),
      ...(field.default !== undefined ? { default: field.default } : {}),
      ...(field.required !== undefined ? { required: field.required } : {}),
      ...(field.multiple !== undefined ? { multiple: field.multiple } : {}),
      ...(field.sensitive !== undefined ? { sensitive: field.sensitive } : {}),
      ...(field.min !== undefined ? { min: field.min } : {}),
      ...(field.max !== undefined ? { max: field.max } : {}),
      ...(field.options !== undefined ? { options: field.options } : {}),
    }
    if (field.sensitive) {
      if (storedSensitive.includes(name)) values[name] = MASKED_VALUE
      continue
    }
    const value = options[name]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') values[name] = value
    else if (Array.isArray(value) && value.every(entry => typeof entry === 'string')) values[name] = value as string[]
  }
  return { fields, values }
}

/** A named credential as the form draws it: the vendor's text, resolved. */
export type SecretRowView = { name: string; label: string; hint?: string }

/** One row of the provider's form, in the order the form draws them. */
export type ModFormRow =
  | { kind: 'prompt'; prompt: CredentialPrompt }
  | { kind: 'setting'; name: string; field: ModsUserConfigField }
  | { kind: 'secret'; secret: SecretRowView }

/**
 * The rows of the one form: the sign-in prompts (the key among them), then
 * the declared settings, then the declared named credentials. `prompts` are
 * the ones to draw (already filtered by their `when` rules); null when the
 * method in force takes no prompts.
 */
export function modFormRows(
  prompts: readonly CredentialPrompt[] | null,
  settings: ModsUserConfig | null,
  secrets: readonly SecretRowView[],
): ModFormRow[] {
  const rows: ModFormRow[] = []
  for (const prompt of prompts ?? []) rows.push({ kind: 'prompt', prompt })
  for (const [name, field] of Object.entries(settings?.fields ?? {})) rows.push({ kind: 'setting', name, field })
  for (const secret of secrets) rows.push({ kind: 'secret', secret })
  return rows
}

/** What the person changed in the form since it was loaded or last saved. */
export type ModFormEdits = {
  /** The prompt answers typed, by key (the stored plain answers underneath). */
  answers: PromptAnswers
  /** The stored plain answers the prompts opened with. */
  storedAnswers: PromptAnswers
  /** The settings' draft against what they opened with; null without settings. */
  settings: { config: ModsUserConfig; draft: OptionsDraft; baseline: OptionsDraft } | null
  /** A named credential's typed value, or null: remove the stored one. */
  secrets: Readonly<Record<string, string | null>>
}

/** Where one save goes: each changed group to its own writer, nothing for
 *  an untouched one. */
export type ModFormWrites = {
  /** The prompts' answers, when one was typed (`promptWrites`). */
  credentials?: PromptWrites
  /** The declared settings' values, when one changed. */
  settings?: { owned: string[]; values: Record<string, ModsOptionValue>; keep: string[] }
  /** The named credentials to store by name; `''` removes one. */
  secrets: Record<string, string>
  /** Settings whose value is not a number within its bounds: nothing is saved. */
  invalid: string[]
}

/** Whether a prompt answer was typed (a cleared field is not an answer). */
export function promptsTouched(answers: PromptAnswers): boolean {
  return Object.values(answers).some(value => value.trim() !== '')
}

/** Whether a named credential's row holds a change: a typed value or a removal. */
export function secretsTouched(secrets: Readonly<Record<string, string | null>>): boolean {
  return Object.values(secrets).some(value => value === null || value.trim() !== '')
}

/** Whether anything in the form changed: what wakes the Save button. */
export function modFormDirty(edits: ModFormEdits): boolean {
  return (
    promptsTouched(edits.answers) ||
    (edits.settings !== null && draftChanged(edits.settings.draft, edits.settings.baseline)) ||
    secretsTouched(edits.secrets)
  )
}

/**
 * The writes of one save. The prompts write as a whole once any was answered
 * (their rules read every answer); a setting group writes once its draft
 * differs; a named credential writes on its own when typed or removed, and a
 * blank one writes nothing.
 */
export function modFormWrites(prompts: readonly CredentialPrompt[], edits: ModFormEdits): ModFormWrites {
  const writes: ModFormWrites = { secrets: {}, invalid: [] }
  if (promptsTouched(edits.answers)) {
    writes.credentials = promptWrites(prompts, { ...edits.storedAnswers, ...edits.answers })
  }
  if (edits.settings && draftChanged(edits.settings.draft, edits.settings.baseline)) {
    const { values, keep, invalid } = valuesOf(edits.settings.config, edits.settings.draft)
    writes.invalid = invalid
    writes.settings = { owned: Object.keys(edits.settings.config.fields), values, keep }
  }
  for (const [name, value] of Object.entries(edits.secrets)) {
    if (value === null) writes.secrets[name] = ''
    else if (value.trim() !== '' && SECRET_NAME.test(name)) writes.secrets[name] = value.trim()
  }
  return writes
}
