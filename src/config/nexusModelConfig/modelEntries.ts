/**
 * Model ENTRIES (F-28): a family plus `latest` or a pinned version, carried as the
 * virtual id `<family>@<version>` and resolved to a concrete id where a model id
 * leaves the catalog (the transport, the metadata lookups). Pure.
 */
import { getProviderDefinition } from './providers'
import {
  compareVersionsDesc,
  parseModelVersion,
  pickVersionId,
  type ModelVersionInfo,
} from './providers/shared/modelVersions'

/** A provider's id reader: its definition's override, else the shared one. */
export function versionParser(providerId: string): (id: string) => ModelVersionInfo {
  return getProviderDefinition(providerId)?.versions ?? parseModelVersion
}

export type ModelEntry = {
  family: string
  /** `latest`, or a pinned version label (`5.0`, `2.5-preview`). */
  version: string
  /** The concrete id the entry resolved to when it was added — the fallback
   *  while no listing is available (a cold start with no cache). */
  id?: string
}

export const LATEST = 'latest'
const SEPARATOR = '@'

export function entryId(entry: Pick<ModelEntry, 'family' | 'version'>): string {
  return `${entry.family}${SEPARATOR}${entry.version}`
}

/** The entry a virtual id names, or undefined for a concrete model id. */
export function parseEntryId(id: string | undefined): Pick<ModelEntry, 'family' | 'version'> | undefined {
  if (!id) return undefined
  const at = id.lastIndexOf(SEPARATOR)
  if (at <= 0 || at === id.length - 1) return undefined
  return { family: id.slice(0, at), version: id.slice(at + 1) }
}

export const isEntryId = (id: string | undefined): boolean => parseEntryId(id) !== undefined

export function sameEntry(a: Pick<ModelEntry, 'family' | 'version'>, b: Pick<ModelEntry, 'family' | 'version'>): boolean {
  return a.family === b.family && a.version === b.version
}

/** A model a provider offers, as the entry logic reads it. */
export type ModelCandidate = { id: string; label?: string }

export type FamilyVersion = {
  versionLabel: string
  version: number[]
  preview: boolean
  /** The listed ids of this version (its snapshots / undated alias). */
  ids: string[]
}

export type ModelFamily = {
  family: string
  /** A display name without the version (`Claude Opus`), when one can be read. */
  label: string
  /** Newest first; previews after the stable versions. */
  versions: FamilyVersion[]
}

/** `Anthropic: Claude Opus 5.5` → `Anthropic: Claude Opus`, `GPT-5.6 Terra` →
 *  `GPT Terra`; else the key humanized. */
export function familyLabel(family: string, memberLabel: string | undefined, versionLabel: string): string {
  if (memberLabel && versionLabel) {
    const base = versionLabel.replace(/-.*$/, '')
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const stripped = memberLabel
      .replace(new RegExp(`[\\s-]?\\b${escaped}\\b`), '')
      .replace(/\s*\((preview|beta|experimental)\)/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
    if (stripped && stripped !== memberLabel.trim()) return stripped
  }
  if (memberLabel && !versionLabel) return memberLabel
  const name = family.slice(family.lastIndexOf('/') + 1).replace(/:.*$/, '')
  return name
    .split('-')
    .filter(part => part !== '*')
    .map(part => part.replace(/\*$/, ''))
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/** Group a provider's candidates into families. */
export function groupFamilies(
  candidates: readonly ModelCandidate[],
  parse: (id: string) => ModelVersionInfo = parseModelVersion,
): Map<string, ModelFamily> {
  const families = new Map<string, { versions: Map<string, FamilyVersion>; labels: Map<string, string> }>()
  for (const candidate of candidates) {
    const info = parse(candidate.id)
    const family = families.get(info.family) ?? { versions: new Map(), labels: new Map() }
    families.set(info.family, family)
    const version = family.versions.get(info.versionLabel) ?? {
      versionLabel: info.versionLabel,
      version: info.version,
      preview: info.preview,
      ids: [],
    }
    version.ids.push(candidate.id)
    family.versions.set(info.versionLabel, version)
    if (candidate.label && !family.labels.has(info.versionLabel)) family.labels.set(info.versionLabel, candidate.label)
  }
  const out = new Map<string, ModelFamily>()
  for (const [key, family] of families) {
    const versions = [...family.versions.values()].sort((a, b) =>
      a.preview !== b.preview ? (a.preview ? 1 : -1) : compareVersionsDesc(a.version, b.version),
    )
    const newest = versions[0]!
    out.set(key, {
      family: key,
      label: familyLabel(key, family.labels.get(newest.versionLabel), newest.versionLabel),
      versions,
    })
  }
  return out
}

export type EntryResolution = {
  /** The concrete id to send. */
  id: string
  /** The version it resolved to (`5.1` — what "latest" means today). */
  versionLabel: string
  preview: boolean
}

/**
 * The concrete model an entry means among a provider's families. `latest`
 * takes the newest stable version (a family with only previews has no
 * latest); a pinned version takes that version. Either picks the version's
 * undated alias when listed, else its newest snapshot. Undefined when the
 * provider lists nothing that matches.
 */
export function resolveEntry(
  entry: Pick<ModelEntry, 'family' | 'version'>,
  families: ReadonlyMap<string, ModelFamily>,
  parse: (id: string) => ModelVersionInfo = parseModelVersion,
): EntryResolution | undefined {
  const family = families.get(entry.family)
  if (!family) return undefined
  const version = entry.version === LATEST
    ? family.versions.find(v => !v.preview)
    : family.versions.find(v => v.versionLabel === entry.version)
  if (!version) return undefined
  const id = pickVersionId(version.ids, parse)
  return id ? { id, versionLabel: version.versionLabel, preview: version.preview } : undefined
}

/**
 * The entry a concrete id belongs to among `entries` — how a selection saved
 * before entries existed (a raw model id) finds its row: the pinned entry of
 * its version first, else its family's `latest`.
 */
export function entryForModelId(
  modelId: string,
  entries: readonly Pick<ModelEntry, 'family' | 'version'>[],
  parse: (id: string) => ModelVersionInfo = parseModelVersion,
): Pick<ModelEntry, 'family' | 'version'> | undefined {
  const info = parse(modelId)
  return (
    entries.find(e => e.family === info.family && e.version === info.versionLabel)
    ?? entries.find(e => e.family === info.family && e.version === LATEST)
  )
}

/**
 * The entries a page edits: the stored list (`config.modelEntries`), else the
 * ones the provider's catalog rows show — its defaults, before the first
 * edit. Each row carries the concrete id its entry resolved to, kept as the
 * entry's fallback.
 */
export function editableEntries(
  stored: readonly ModelEntry[] | undefined,
  rows: ReadonlyArray<{ entry?: { family: string; version: string; resolvedId?: string } }>,
): ModelEntry[] {
  if (Array.isArray(stored)) return stored.map(e => ({ ...e }))
  const out: ModelEntry[] = []
  for (const row of rows) {
    if (!row.entry) continue
    out.push({
      family: row.entry.family,
      version: row.entry.version,
      ...(row.entry.resolvedId ? { id: row.entry.resolvedId } : {}),
    })
  }
  return out
}

/** The pinned entry for a concrete id (what adding a version writes). */
export function pinnedEntryFor(
  modelId: string,
  parse: (id: string) => ModelVersionInfo = parseModelVersion,
): ModelEntry {
  const info = parse(modelId)
  return { family: info.family, version: info.versionLabel || LATEST, id: modelId }
}
