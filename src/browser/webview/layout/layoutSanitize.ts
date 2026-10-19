/**
 * Security: validation for the persisted layout blob (F-9). `localStorage` is
 * never trusted: each field is checked on its own, a field that does not
 * sanitize is its default and the rest is kept; every tree is rebuilt node by
 * node; records past the cap are dropped least recently used first.
 */
import { defaultFilesEditorPrefs, sanitizeFilesEditorPrefs, type FilesEditorPrefs } from './filesEditor'
import { sanitizeFilesPane } from './filesPane'
import { clampFilesTreeWidth, defaultFilesTreePrefs } from './filesTreeDock'
import {
  CHAT_WEIGHT,
  groupById,
  isPaneId,
  isSidePaneKind,
  normalise,
  ROOT_GROUP_ID,
  type PaneGroup,
  type PaneLayout,
  type PaneNode,
  type PaneSlot,
  type PaneWeightByKind,
  type SessionPaneRecord,
  type SidePaneKind,
} from './paneLayout'
import {
  defaultSessionCardPrefs,
  sanitizeSessionCardPrefs,
  type SessionCardPrefs,
} from './sessionCards'
import { ASKED_MEMORY_CAP, modPaneOfKey } from './modsPane'

/** Per-session records kept; the least recently used go first. */
export const SESSION_RECORD_CAP = 100

const WEIGHT_MIN = 0.05
const WEIGHT_MAX = 50

export interface NexusLayoutStorage {
  /** Pane weights relative to the chat's 2, remembered per kind across sessions. */
  paneWeightByKind: PaneWeightByKind
  sessions: Record<string, SessionPaneRecord>
  sessionCards: SessionCardPrefs
  /** The mod panes the person asked for and has not closed by hand (`modsPane.ts` keys). */
  modPanesAsked: readonly string[]
  /** The Files pane's Show file tree toggle, for every session. */
  filesTreeVisible: boolean
  /** The Files pane's docked tree width, px. */
  filesTreeWidth: number
  /** The Files pane's editor: word wrap and tab size, for every file. */
  filesEditor: FilesEditorPrefs
}

export function defaultLayoutStorage(): NexusLayoutStorage {
  const tree = defaultFilesTreePrefs()
  return {
    paneWeightByKind: {},
    sessions: {},
    sessionCards: defaultSessionCardPrefs(),
    modPanesAsked: [],
    filesTreeVisible: tree.visible,
    filesTreeWidth: tree.width,
    filesEditor: defaultFilesEditorPrefs(),
  }
}

/** Remembered asked panes: well-formed keys, each once, the newest `ASKED_MEMORY_CAP`. */
export function sanitizeModPanesAsked(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return []
  const keys = raw.filter(
    (key): key is string => typeof key === 'string' && key.length <= 200 && modPaneOfKey(key) !== null,
  )
  const unique = keys.filter((key, index) => keys.lastIndexOf(key) === index)
  return unique.length > ASKED_MEMORY_CAP ? unique.slice(unique.length - ASKED_MEMORY_CAP) : unique
}

function sanitizeWeight(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 1
}

/** A stored weight for a kind: finite, positive, within a sane range, else absent. */
export function sanitizePaneWeightByKind(raw: unknown): PaneWeightByKind {
  if (typeof raw !== 'object' || raw === null) return {}
  const obj = raw as Record<string, unknown>
  const out: PaneWeightByKind = {}
  for (const key of Object.keys(obj)) {
    if (!isSidePaneKind(key)) continue
    const value = obj[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
    out[key] = Math.round(Math.min(Math.max(value, WEIGHT_MIN), WEIGHT_MAX) * 10_000) / 10_000
  }
  return out
}

function isAxis(value: unknown): value is 'row' | 'column' {
  return value === 'row' || value === 'column'
}

function sanitizeNode(raw: unknown, ids: Set<string>): PaneNode | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  if (Array.isArray(obj.children)) {
    if (!isAxis(obj.axis)) return null
    const children: PaneNode[] = []
    for (const child of obj.children) {
      const node = sanitizeNode(child, ids)
      if (node) children.push(node)
    }
    let id = typeof obj.id === 'string' && obj.id.length > 0 && obj.id.length <= 32 ? obj.id : ''
    if (!id || ids.has(id)) {
      for (let n = 1; ; n++) {
        const candidate = `g${n}`
        if (!ids.has(candidate)) {
          id = candidate
          break
        }
      }
    }
    ids.add(id)
    return { id, axis: obj.axis, weight: sanitizeWeight(obj.weight), children }
  }
  if (!isPaneId(obj.pane)) return null
  return { pane: obj.pane, weight: sanitizeWeight(obj.weight) }
}

/** A stored tree rebuilt node by node and normalised; anything unusable is the default. */
export function sanitizePaneLayout(raw: unknown): PaneLayout {
  const fallback = normalise({ root: { id: ROOT_GROUP_ID, axis: 'row', weight: 1, children: [] } })
  if (typeof raw !== 'object' || raw === null) return fallback
  const rootRaw = (raw as Record<string, unknown>).root
  const ids = new Set<string>([ROOT_GROUP_ID])
  if (typeof rootRaw !== 'object' || rootRaw === null) return fallback
  const children = (rootRaw as Record<string, unknown>).children
  if (!Array.isArray(children)) return fallback
  const nodes: PaneNode[] = []
  for (const child of children) {
    const node = sanitizeNode(child, ids)
    if (node) nodes.push(node)
  }
  const root: PaneGroup = { id: ROOT_GROUP_ID, axis: 'row', weight: 1, children: nodes }
  const layout = normalise({ root })
  const chat = layout.root.children.find(node => !('children' in node) && node.pane === 'chat')
  if (chat && chat.weight !== CHAT_WEIGHT && layout.root.children.length === 1) {
    return normalise({ root: { ...layout.root, children: [{ pane: 'chat', weight: CHAT_WEIGHT }] } })
  }
  return layout
}

function sanitizeSlot(raw: unknown, layout: PaneLayout): PaneSlot | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.groupId !== 'string' || !groupById(layout, obj.groupId)) return null
  if (!isAxis(obj.axis)) return null
  const index =
    typeof obj.index === 'number' && Number.isInteger(obj.index) && obj.index >= 0 ? obj.index : 0
  return { groupId: obj.groupId, index, axis: obj.axis, weight: sanitizeWeight(obj.weight) }
}

export function sanitizeSessionPaneRecord(raw: unknown): SessionPaneRecord {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const layout = sanitizePaneLayout(obj.layout)
  const present = new Set<SidePaneKind>()
  const walk = (node: PaneNode): void => {
    if ('children' in node) node.children.forEach(walk)
    else if (node.pane !== 'chat') present.add(node.pane)
  }
  walk(layout.root)
  const maximized = isSidePaneKind(obj.maximized) && present.has(obj.maximized) ? obj.maximized : null
  const closedSlots: Partial<Record<SidePaneKind, PaneSlot>> = {}
  if (typeof obj.closedSlots === 'object' && obj.closedSlots !== null) {
    for (const [kind, slot] of Object.entries(obj.closedSlots as Record<string, unknown>)) {
      if (!isSidePaneKind(kind) || present.has(kind)) continue
      const clean = sanitizeSlot(slot, layout)
      if (clean) closedSlots[kind] = clean
    }
  }
  const files = sanitizeFilesPane(obj.files)
  const usedAt = typeof obj.usedAt === 'number' && Number.isFinite(obj.usedAt) && obj.usedAt >= 0 ? obj.usedAt : 0
  return files ? { layout, maximized, closedSlots, files, usedAt } : { layout, maximized, closedSlots, usedAt }
}

/** The records, each sanitized, the least recently used dropped past the cap. */
export function sanitizeSessionRecords(raw: unknown, cap = SESSION_RECORD_CAP): Record<string, SessionPaneRecord> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const entries: [string, SessionPaneRecord][] = []
  for (const [id, record] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || typeof record !== 'object' || record === null) continue
    entries.push([id, sanitizeSessionPaneRecord(record)])
  }
  return Object.fromEntries(trimSessionRecords(entries, cap))
}

/** Keep the `cap` most recently used entries, in their given order. */
export function trimSessionRecords(
  entries: readonly [string, SessionPaneRecord][],
  cap = SESSION_RECORD_CAP,
): [string, SessionPaneRecord][] {
  if (entries.length <= cap) return [...entries]
  const kept = new Set(
    [...entries]
      .sort((a, b) => b[1].usedAt - a[1].usedAt)
      .slice(0, cap)
      .map(([id]) => id),
  )
  return entries.filter(([id]) => kept.has(id))
}

/** Coerce an arbitrary parsed value into a valid blob, field by field. */
export function sanitizeLayoutStorage(raw: unknown): NexusLayoutStorage {
  if (typeof raw !== 'object' || raw === null) return defaultLayoutStorage()
  const obj = raw as Record<string, unknown>
  return {
    paneWeightByKind: sanitizePaneWeightByKind(obj.paneWeightByKind),
    sessions: sanitizeSessionRecords(obj.sessions),
    sessionCards: sanitizeSessionCardPrefs(obj.sessionCards),
    modPanesAsked: sanitizeModPanesAsked(obj.modPanesAsked),
    filesTreeVisible: obj.filesTreeVisible === true,
    filesTreeWidth: clampFilesTreeWidth(obj.filesTreeWidth),
    filesEditor: sanitizeFilesEditorPrefs(obj.filesEditor),
  }
}
