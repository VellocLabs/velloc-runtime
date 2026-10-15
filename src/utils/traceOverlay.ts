/**
 * Floating Gantt overlay for the session tracer (vanilla DOM): streams local and
 * SharedWorker records, grouped by `traceId`. Loaded lazily only when the trace
 * flag is on; `installTraceOverlay()` returns `dispose()`.
 */

import { getProductName } from '../branding/productName'
import {
  getSessionTracer,
  type TraceRecord,
  type TraceListener,
} from './sessionTrace'
import {
  getModelUploadHistory,
  subscribeModelUpload,
  clearModelUploadHistory,
  type ModelUploadEntry,
} from './modelUploadBus'
import type { WorkerLogEntry } from './workerLogBuffer'
import { writeClipboard } from './clipboard'

export type TraceOverlayOptions = {
  /**
   * Optional SharedWorker port to subscribe to manager-realm spans. If
   * omitted, the overlay only shows UI-realm records.
   */
  port?: MessagePort
}

type TraceGroup = {
  traceId: string
  records: TraceRecord[]
  startMs: number
  endMs: number
}

const COLOR_UI = '#4a90d9'
const COLOR_WORKER = '#e07a3a'
const COLOR_EVENT = '#888'
const MAX_TRACES = 32 // keep recent N traces in memory; evict oldest
const MAX_WORKER_LOGS = 500 // matches the worker-realm ring buffer
const ROW_HEIGHT = 18

type ActiveTab = 'timeline' | 'json' | 'worker'

export const NEXUS_ACTIVE_SESSION_CHANGED_EVENT = 'nexus:activeSessionChanged'

type ActiveSessionChangedDetail = {
  sessionId?: string | null
}

function normalizeSessionId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : null
}

function readCurrentModelUploadSessionId(): string | null {
  return normalizeSessionId(
    (globalThis as { __nexusActiveSessionId?: unknown }).__nexusActiveSessionId,
  )
}

function isModelUploadVisibleForSession(
  entry: ModelUploadEntry,
  sessionId: string | null | undefined,
): boolean {
  const normalized = normalizeSessionId(sessionId)
  return !normalized || entry.sessionId === normalized
}

export function filterModelUploadsForSession(
  uploads: readonly ModelUploadEntry[],
  sessionId: string | null | undefined,
): ModelUploadEntry[] {
  const normalized = normalizeSessionId(sessionId)
  if (!normalized) return uploads.slice()
  return uploads.filter(entry => entry.sessionId === normalized)
}

export function resolveModelUploadSelection(
  uploads: readonly ModelUploadEntry[],
  activeUploadIndex: number | null,
  sessionId: string | null | undefined,
  selectionPinned: boolean,
): number | null {
  const visibleUploads = filterModelUploadsForSession(uploads, sessionId)
  if (visibleUploads.length === 0) return null
  if (
    selectionPinned
    && activeUploadIndex !== null
    && visibleUploads.some(entry => entry.index === activeUploadIndex)
  ) {
    return activeUploadIndex
  }
  return visibleUploads.reduce((newest, entry) =>
    entry.index > newest.index ? entry : newest,
  ).index
}

function formatSessionIdForOverlay(sessionId: string | null | undefined): string {
  const normalized = normalizeSessionId(sessionId)
  if (!normalized) return '—'
  return normalized.length > 18
    ? `${normalized.slice(0, 8)}…${normalized.slice(-6)}`
    : normalized
}
export function installTraceOverlay(opts: TraceOverlayOptions = {}): () => void {
  const traces = new Map<string, TraceGroup>()
  const uploads: ModelUploadEntry[] = []
  const workerLogs: WorkerLogEntry[] = []
  let activeTraceId: string | null = null
  let activeUploadIndex: number | null = null
  let uploadSelectionPinned = false
  let currentSessionId: string | null = readCurrentModelUploadSessionId()
  let activeTab: ActiveTab = 'timeline'
  let renderScheduled = false
  let disposed = false
  // Timeline rows whose attrs detail panel is expanded. Keyed by spanId
  // so the expansion survives the full-body re-render that every new
  // record schedules. Never pruned — stale ids of evicted traces are
  // harmless (they simply stop matching) and the set stays tiny.
  const expandedAttrSpanIds = new Set<string>()
  // Default to minimized. Showing a 560px panel by default is too
  // intrusive — most sessions never need to look at it. The expanded
  // state is one click away via the floating pill in the bottom-left.
  let minimized = true

  // -- DOM ------------------------------------------------------------------

  const root = document.createElement('div')
  root.setAttribute('data-nexus-trace-overlay', 'true')
  Object.assign(root.style, {
    position: 'fixed',
    bottom: '12px',
    left: '12px',
    width: '560px',
    maxHeight: '60vh',
    zIndex: '2147483646',
    display: 'flex',
    flexDirection: 'column',
    background: 'rgba(15, 23, 42, 0.94)',
    color: '#e2e8f0',
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: '11px',
    lineHeight: '1.4',
    border: '1px solid rgba(148, 163, 184, 0.35)',
    borderRadius: '8px',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
    overflow: 'hidden',
    backdropFilter: 'blur(8px)',
  } as CSSStyleDeclaration)

  // Header --------------------------------------------------------------------
  const header = document.createElement('div')
  Object.assign(header.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 10px',
    background: 'rgba(30, 41, 59, 0.7)',
    borderBottom: '1px solid rgba(148, 163, 184, 0.2)',
    flexShrink: '0',
  } as CSSStyleDeclaration)

  const title = document.createElement('span')
  title.textContent = `${getProductName()} trace`
  title.style.fontWeight = '600'
  title.style.color = '#f1f5f9'
  header.appendChild(title)

  // Tab strip — switches between the Gantt timeline and the JSON view
  // of the model-upload payloads (messages[] + tools[] sent on every
  // callModel request).
  const tabStrip = document.createElement('div')
  Object.assign(tabStrip.style, {
    display: 'flex',
    gap: '2px',
  } as CSSStyleDeclaration)
  const timelineTabBtn = makeTabButton('Timeline', () => setTab('timeline'))
  const jsonTabBtn = makeTabButton('Model-JSON', () => setTab('json'))
  const workerTabBtn = makeTabButton('SharedWorker', () => setTab('worker'))
  tabStrip.appendChild(timelineTabBtn)
  tabStrip.appendChild(jsonTabBtn)
  tabStrip.appendChild(workerTabBtn)
  header.appendChild(tabStrip)

  // Timeline-tab selector (active trace dropdown).
  const traceSelect = document.createElement('select')
  Object.assign(traceSelect.style, {
    flex: '1',
    minWidth: '0',
    background: 'rgba(0, 0, 0, 0.3)',
    color: '#e2e8f0',
    border: '1px solid rgba(148, 163, 184, 0.3)',
    borderRadius: '4px',
    padding: '2px 6px',
    fontSize: '11px',
    fontFamily: 'inherit',
  } as CSSStyleDeclaration)
  traceSelect.addEventListener('change', () => {
    activeTraceId = traceSelect.value || null
    scheduleRender()
  })
  header.appendChild(traceSelect)

  // JSON-tab selector (active upload dropdown).
  const uploadSelect = document.createElement('select')
  Object.assign(uploadSelect.style, {
    flex: '1',
    minWidth: '0',
    background: 'rgba(0, 0, 0, 0.3)',
    color: '#e2e8f0',
    border: '1px solid rgba(148, 163, 184, 0.3)',
    borderRadius: '4px',
    padding: '2px 6px',
    fontSize: '11px',
    fontFamily: 'inherit',
    display: 'none',
  } as CSSStyleDeclaration)
  uploadSelect.addEventListener('change', () => {
    const idx = Number.parseInt(uploadSelect.value, 10)
    activeUploadIndex = Number.isNaN(idx) ? null : idx
    uploadSelectionPinned = activeUploadIndex !== null
    scheduleRender()
  })
  header.appendChild(uploadSelect)

  const copyBtn = makeButton('Copy', () => copyActive())
  copyBtn.title = 'Copy active item (timeline → Markdown, JSON → raw JSON)'
  header.appendChild(copyBtn)

  const copyAllBtn = makeButton('Copy All', () => copyAll())
  copyAllBtn.title =
    'Copy every captured item from the active tab (Markdown for traces, JSON array for uploads)'
  header.appendChild(copyAllBtn)

  const clearBtn = makeButton('Clear', () => {
    if (activeTab === 'timeline') {
      traces.clear()
      activeTraceId = null
    } else if (activeTab === 'json') {
      uploads.length = 0
      activeUploadIndex = null
      clearModelUploadHistory()
    } else {
      // Clears the overlay's local copy only; the worker-realm ring
      // buffer keeps its history (re-seeded on the next flush).
      workerLogs.length = 0
    }
    scheduleRender()
  })
  clearBtn.title = 'Drop every captured item in the active tab'
  header.appendChild(clearBtn)

  const closeBtn = makeButton('✕', () => {
    setMinimized(true)
  })
  closeBtn.title = 'Minimize to the bottom-left pill'
  header.appendChild(closeBtn)

  root.appendChild(header)

  // Body ---------------------------------------------------------------------
  const body = document.createElement('div')
  Object.assign(body.style, {
    flex: '1',
    overflow: 'auto',
    padding: '8px 10px',
  } as CSSStyleDeclaration)
  root.appendChild(body)

  // Toast --------------------------------------------------------------------
  const toast = document.createElement('div')
  Object.assign(toast.style, {
    position: 'absolute',
    top: '8px',
    right: '8px',
    background: 'rgba(34, 197, 94, 0.9)',
    color: '#0f172a',
    padding: '4px 8px',
    borderRadius: '4px',
    fontSize: '10px',
    fontWeight: '600',
    pointerEvents: 'none',
    opacity: '0',
    transition: 'opacity 200ms',
  } as CSSStyleDeclaration)
  root.appendChild(toast)

  document.body.appendChild(root)

  // Minimized-state pill — small clickable bar at bottom-left that
  // expands the full panel on click. Visible whenever `minimized`
  // is true; hidden when expanded. Kept as a separate DOM element
  // (rather than transforming `root`) so each state stays simple to
  // style and reason about.
  const minBar = document.createElement('div')
  minBar.setAttribute('data-nexus-trace-overlay-min', 'true')
  Object.assign(minBar.style, {
    position: 'fixed',
    bottom: '12px',
    left: '12px',
    zIndex: '2147483646',
    background: 'rgba(15, 23, 42, 0.94)',
    color: '#e2e8f0',
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: '11px',
    padding: '4px 10px',
    border: '1px solid rgba(148, 163, 184, 0.35)',
    borderRadius: '999px',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)',
    cursor: 'pointer',
    userSelect: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    backdropFilter: 'blur(8px)',
  } as CSSStyleDeclaration)
  minBar.title = `Click to expand the ${getProductName()} trace panel`
  minBar.addEventListener('click', () => {
    setMinimized(false)
  })
  document.body.appendChild(minBar)

  // -- Subscriptions --------------------------------------------------------

  const onLocalRecord: TraceListener = record => ingest(record)
  const localUnsubscribe = getSessionTracer().subscribe(onLocalRecord)

  let portUnsubscribe: (() => void) | null = null
  if (opts.port) {
    const port = opts.port
    const portHandler = (event: MessageEvent): void => {
      const data = event.data as Record<string, unknown> | null
      if (data?.type === 'trace.record') {
        const record = (data.payload as { record: TraceRecord }).record
        ingest(record)
      } else if (data?.type === 'worker.log') {
        const entry = (data.payload as { entry: WorkerLogEntry }).entry
        ingestWorkerLog(entry)
      }
    }
    port.addEventListener('message', portHandler)
    port.start()
    port.postMessage({ type: 'trace.subscribe' })

    // Pull whatever's already in the manager's ring so the overlay
    // doesn't start blank — useful when the user opens the overlay
    // mid-session and there's history to inspect.
    port.postMessage({ type: 'trace.flush' })
    const snapshotHandler = (event: MessageEvent): void => {
      const data = event.data as Record<string, unknown> | null
      if (data?.type === 'trace.snapshot') {
        const records = (data.payload as { records: TraceRecord[] }).records
        for (const r of records) ingest(r)
      } else if (data?.type === 'worker.log.snapshot') {
        const entries = (data.payload as { entries: WorkerLogEntry[] }).entries
        for (const e of entries) ingestWorkerLog(e)
      }
    }
    port.addEventListener('message', snapshotHandler)

    portUnsubscribe = () => {
      port.postMessage({ type: 'trace.unsubscribe' })
      port.removeEventListener('message', portHandler)
      port.removeEventListener('message', snapshotHandler)
    }
  }

  // Seed with whatever's already in the local ring buffer.
  for (const record of getSessionTracer().drain()) ingest(record)

  // Seed + subscribe to the model-upload bus (populated by the worker's
  // pre-`callModel` trace; see engine/turn/turnDependencies.ts → logModelRequestTrace).
  // The history holds the most recent N entries so opening the overlay
  // mid-session still shows what's been sent so far.
  for (const entry of getModelUploadHistory()) ingestUpload(entry)
  const uploadUnsubscribe = subscribeModelUpload(ingestUpload)

  const activeSessionHandler = (event: Event): void => {
    const detail = (event as CustomEvent<ActiveSessionChangedDetail>).detail
    currentSessionId = normalizeSessionId(detail?.sessionId ?? (globalThis as { __nexusActiveSessionId?: unknown }).__nexusActiveSessionId)
    uploadSelectionPinned = false
    activeUploadIndex = resolveModelUploadSelection(
      uploads,
      activeUploadIndex,
      currentSessionId,
      uploadSelectionPinned,
    )
    renderMinBar()
    scheduleRender()
  }
  try {
    globalThis.addEventListener?.(
      NEXUS_ACTIVE_SESSION_CHANGED_EVENT,
      activeSessionHandler as EventListener,
    )
  } catch {
    // Non-browser test contexts may not expose DOM event helpers.
  }
  // Set initial tab state so the tab button highlight is correct.
  setTab(activeTab)
  // Apply the default minimized state. The pill is what the user
  // sees first; clicking it expands the full panel.
  setMinimized(minimized)
  renderMinBar()

  // -- Logic ----------------------------------------------------------------

  function setTab(tab: ActiveTab): void {
    activeTab = tab
    timelineTabBtn.dataset.active = tab === 'timeline' ? 'true' : 'false'
    jsonTabBtn.dataset.active = tab === 'json' ? 'true' : 'false'
    workerTabBtn.dataset.active = tab === 'worker' ? 'true' : 'false'
    styleTabButton(timelineTabBtn, tab === 'timeline')
    styleTabButton(jsonTabBtn, tab === 'json')
    styleTabButton(workerTabBtn, tab === 'worker')
    traceSelect.style.display = tab === 'timeline' ? '' : 'none'
    uploadSelect.style.display = tab === 'json' ? '' : 'none'
    scheduleRender()
  }

  function setMinimized(value: boolean): void {
    minimized = value
    root.style.display = value ? 'none' : 'flex'
    minBar.style.display = value ? 'flex' : 'none'
    if (!value) scheduleRender()
  }

  function renderMinBar(): void {
    // Compact at-a-glance counts so the pill doubles as a status
    // indicator. Hidden numbers are dropped to keep the pill short
    // when nothing has been captured yet.
    const parts: string[] = [`◉ ${getProductName()} trace`]
    if (traces.size > 0) parts.push(`${traces.size}t`)
    const visibleUploads = filterModelUploadsForSession(uploads, currentSessionId)
    if (visibleUploads.length > 0) {
      const responses = visibleUploads.reduce(
        (sum, u) => sum + (u.responses?.length ?? 0),
        0,
      )
      const count = currentSessionId && visibleUploads.length !== uploads.length
        ? `${visibleUploads.length}/${uploads.length}u`
        : `${visibleUploads.length}u`
      const tag = responses > 0 ? `${count}↩${responses}` : count
      parts.push(tag)
    }
    if (workerLogs.length > 0) {
      const errors = workerLogs.reduce(
        (sum, e) => sum + (e.level === 'error' ? 1 : 0),
        0,
      )
      parts.push(errors > 0 ? `${workerLogs.length}w⚠${errors}` : `${workerLogs.length}w`)
    }
    minBar.textContent = parts.join(' · ')
  }

  function ingestUpload(entry: ModelUploadEntry): void {
    if (disposed) return
    // The bus notifies us on every state change of a request entry,
    // including when a response arrives and the entry is mutated in
    // place. De-duplicate by `index` so a re-emit of the same entry
    // doesn't push a new row to the dropdown — re-render only.
    const existingIdx = uploads.findIndex(u => u.index === entry.index)
    if (existingIdx >= 0) {
      uploads[existingIdx] = entry
      renderMinBar()
      scheduleRender()
      return
    }
    uploads.push(entry)
    if (uploads.length > MAX_TRACES) {
      uploads.splice(0, uploads.length - MAX_TRACES)
    }
    if (
      !uploadSelectionPinned
      && isModelUploadVisibleForSession(entry, currentSessionId)
    ) {
      activeUploadIndex = entry.index
    }
    renderMinBar()
    scheduleRender()
  }

  function ingestWorkerLog(entry: WorkerLogEntry): void {
    if (disposed) return
    // De-dupe by id: a live `worker.log` can race the `worker.log.snapshot`
    // (subscribe fires before flush), so the same entry may arrive twice.
    if (workerLogs.some(e => e.id === entry.id)) return
    workerLogs.push(entry)
    if (workerLogs.length > MAX_WORKER_LOGS) {
      workerLogs.splice(0, workerLogs.length - MAX_WORKER_LOGS)
    }
    renderMinBar()
    scheduleRender()
  }

  function ingest(record: TraceRecord): void {
    if (disposed) return
    let group = traces.get(record.traceId)
    if (!group) {
      group = {
        traceId: record.traceId,
        records: [],
        startMs: record.startMs,
        endMs: record.startMs,
      }
      traces.set(record.traceId, group)
      evictOldTraces()
      // Always switch to the newest trace — that's the click the user
      // most likely just made and is investigating.
      activeTraceId = record.traceId
    }
    group.records.push(record)
    if (record.startMs < group.startMs) group.startMs = record.startMs
    const recordEnd = record.startMs + (record.durationMs ?? 0)
    if (recordEnd > group.endMs) group.endMs = recordEnd

    renderMinBar()
    scheduleRender()
  }

  function evictOldTraces(): void {
    if (traces.size <= MAX_TRACES) return
    const sorted = Array.from(traces.values()).sort(
      (a, b) => a.startMs - b.startMs,
    )
    const toEvict = sorted.length - MAX_TRACES
    for (let i = 0; i < toEvict; i++) {
      traces.delete(sorted[i]!.traceId)
    }
  }

  function scheduleRender(): void {
    if (renderScheduled) return
    renderScheduled = true
    requestAnimationFrame(() => {
      renderScheduled = false
      render()
    })
  }

  function render(): void {
    if (activeTab === 'timeline') {
      renderTraceSelect()
      renderBody()
    } else if (activeTab === 'json') {
      renderUploadSelect()
      renderUploadBody()
    } else {
      renderWorkerLogs()
    }
  }

  function renderTraceSelect(): void {
    const sortedTraces = Array.from(traces.values()).sort(
      (a, b) => b.startMs - a.startMs,
    )
    const previousValue = traceSelect.value
    traceSelect.innerHTML = ''
    for (const group of sortedTraces) {
      const opt = document.createElement('option')
      opt.value = group.traceId
      const total = (group.endMs - group.startMs).toFixed(1)
      const ago = ((Date.now() - group.startMs) / 1000).toFixed(0)
      opt.textContent = `${group.traceId.slice(0, 8)} · ${group.records.length} spans · ${total} ms · ${ago}s ago`
      traceSelect.appendChild(opt)
    }
    if (activeTraceId && traces.has(activeTraceId)) {
      traceSelect.value = activeTraceId
    } else if (previousValue && traces.has(previousValue)) {
      traceSelect.value = previousValue
      activeTraceId = previousValue
    } else if (sortedTraces.length > 0) {
      traceSelect.value = sortedTraces[0]!.traceId
      activeTraceId = sortedTraces[0]!.traceId
    }
  }

  function renderBody(): void {
    body.innerHTML = ''
    const group = activeTraceId ? traces.get(activeTraceId) : null
    if (!group) {
      const empty = document.createElement('div')
      empty.textContent =
        traces.size === 0
          ? 'No traces yet. Click a session in the sidebar to record one.'
          : 'Select a trace from the dropdown.'
      empty.style.color = '#94a3b8'
      empty.style.padding = '12px 4px'
      body.appendChild(empty)
      return
    }

    // Sort by startMs ascending so the layout reads top-down.
    const records = group.records.slice().sort((a, b) => a.startMs - b.startMs)
    const t0 = group.startMs
    const totalMs = Math.max(group.endMs - group.startMs, 1)

    // Compute parent depth for indentation.
    const depthBySpanId = new Map<string, number>()
    for (const r of records) {
      const parentDepth =
        r.parentSpanId !== undefined
          ? depthBySpanId.get(r.parentSpanId)
          : undefined
      depthBySpanId.set(r.spanId, parentDepth !== undefined ? parentDepth + 1 : 0)
    }

    const list = document.createElement('div')
    Object.assign(list.style, {
      display: 'grid',
      gridTemplateColumns: '220px 1fr 70px',
      columnGap: '8px',
      rowGap: '2px',
      alignItems: 'center',
    } as CSSStyleDeclaration)

    for (const r of records) {
      const depth = depthBySpanId.get(r.spanId) ?? 0
      const offset = ((r.startMs - t0) / totalMs) * 100
      const width = ((r.durationMs ?? 0) / totalMs) * 100
      const hasAttrs = !!r.attrs && Object.keys(r.attrs).length > 0
      const attrsExpanded = hasAttrs && expandedAttrSpanIds.has(r.spanId)

      // Name cell. Rows that carry attrs are click-to-expand: the
      // tooltip alone is useless for anything non-trivial (one line,
      // not selectable, gone on mouse-out), so clicking toggles a
      // full-width detail panel with the pretty-printed attrs and a
      // Copy button (see below, after the duration cell).
      const nameCell = document.createElement('div')
      nameCell.style.paddingLeft = `${depth * 12}px`
      nameCell.style.color = r.context === 'ui' ? COLOR_UI : COLOR_WORKER
      nameCell.style.overflow = 'hidden'
      nameCell.style.textOverflow = 'ellipsis'
      nameCell.style.whiteSpace = 'nowrap'
      nameCell.title = hasAttrs
        ? `${r.name}\nClick to ${attrsExpanded ? 'collapse' : 'expand'} attrs`
        : r.name
      nameCell.textContent = hasAttrs
        ? `${attrsExpanded ? '▾' : '▸'} ${r.name}`
        : r.name
      if (hasAttrs) {
        nameCell.style.cursor = 'pointer'
        nameCell.addEventListener('click', () => {
          if (expandedAttrSpanIds.has(r.spanId)) {
            expandedAttrSpanIds.delete(r.spanId)
          } else {
            expandedAttrSpanIds.add(r.spanId)
          }
          scheduleRender()
        })
      }
      list.appendChild(nameCell)

      // Bar cell
      const barCell = document.createElement('div')
      Object.assign(barCell.style, {
        position: 'relative',
        height: `${ROW_HEIGHT}px`,
        background: 'rgba(148, 163, 184, 0.12)',
        borderRadius: '2px',
      } as CSSStyleDeclaration)
      const bar = document.createElement('div')
      const isEvent = r.durationMs === undefined
      const color = isEvent
        ? COLOR_EVENT
        : r.context === 'ui'
        ? COLOR_UI
        : COLOR_WORKER
      Object.assign(bar.style, {
        position: 'absolute',
        top: '4px',
        bottom: '4px',
        left: `${offset}%`,
        width: isEvent ? '2px' : `${Math.max(width, 0.4)}%`,
        background: color,
        borderRadius: '2px',
      } as CSSStyleDeclaration)
      barCell.appendChild(bar)
      list.appendChild(barCell)

      // Duration cell
      const durCell = document.createElement('div')
      durCell.style.color = '#94a3b8'
      durCell.style.textAlign = 'right'
      durCell.textContent = isEvent
        ? '·'
        : `${(r.durationMs as number).toFixed(1)} ms`
      list.appendChild(durCell)

      // Attrs detail panel — spans all three grid columns beneath the
      // row. Pretty-printed and text-selectable (unlike the tooltip),
      // with a Copy button for grabbing the attrs JSON, e.g. the
      // per-provider model-name lists on `worker.model.catalogModels`.
      if (attrsExpanded) {
        const detail = document.createElement('div')
        Object.assign(detail.style, {
          gridColumn: '1 / -1',
          margin: '2px 0 6px',
          padding: '6px 8px',
          background: 'rgba(30, 41, 59, 0.5)',
          borderLeft: `3px solid ${r.context === 'ui' ? COLOR_UI : COLOR_WORKER}`,
          borderRadius: '4px',
        } as CSSStyleDeclaration)

        const detailHeader = document.createElement('div')
        Object.assign(detailHeader.style, {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          marginBottom: '4px',
        } as CSSStyleDeclaration)
        const detailTitle = document.createElement('span')
        detailTitle.textContent = `${r.name} · attrs`
        detailTitle.style.color = '#94a3b8'
        detailHeader.appendChild(detailTitle)
        const copyAttrsBtn = makeButton('Copy', () => {
          const json = JSON.stringify(r.attrs, null, 2)
          void writeClipboard(json).then(ok => {
            flashToast(ok ? 'Copied attrs!' : 'Copy failed')
          })
        })
        copyAttrsBtn.title = `Copy the "${r.name}" attrs as formatted JSON`
        detailHeader.appendChild(copyAttrsBtn)
        detail.appendChild(detailHeader)

        const pre = document.createElement('pre')
        pre.textContent = JSON.stringify(r.attrs, null, 2)
        Object.assign(pre.style, {
          margin: '0',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          userSelect: 'text',
          maxHeight: '240px',
          overflow: 'auto',
          color: '#e2e8f0',
        } as CSSStyleDeclaration)
        detail.appendChild(pre)
        list.appendChild(detail)
      }
    }

    body.appendChild(list)

    // Footer summary --------------------------------------------------------
    const footer = document.createElement('div')
    Object.assign(footer.style, {
      marginTop: '8px',
      paddingTop: '6px',
      borderTop: '1px solid rgba(148, 163, 184, 0.2)',
      color: '#94a3b8',
      display: 'flex',
      justifyContent: 'space-between',
    } as CSSStyleDeclaration)
    footer.innerHTML = `
      <span>${records.length} spans · total ${totalMs.toFixed(1)} ms</span>
      <span>traceId: ${group.traceId}</span>
    `
    body.appendChild(footer)
  }

  function renderUploadSelect(): void {
    const sortedUploads = filterModelUploadsForSession(uploads, currentSessionId)
      .sort((a, b) => b.index - a.index)
    activeUploadIndex = resolveModelUploadSelection(
      uploads,
      activeUploadIndex,
      currentSessionId,
      uploadSelectionPinned,
    )
    uploadSelect.innerHTML = ''
    for (const entry of sortedUploads) {
      const opt = document.createElement('option')
      opt.value = String(entry.index)
      const ts = entry.timestamp.slice(11, 23) // HH:MM:SS.mmm
      const sizeKb = (entry.payloadLength / 1024).toFixed(1)
      const drop =
        entry.inputMessageCount !== undefined
        && entry.inputMessageCount !== entry.messageCount
          ? ` ⚠ -${entry.inputMessageCount - entry.messageCount}`
          : ''
      const respCount = entry.responses?.length ?? 0
      const respTag = respCount > 0 ? ` · ${respCount}↩` : ''
      opt.textContent = `#${entry.index} · ${entry.messageCount} msgs${drop}${respTag} · ${entry.toolCount} tools · ${sizeKb} KB · ${ts}`
      uploadSelect.appendChild(opt)
    }
    if (activeUploadIndex !== null) {
      uploadSelect.value = String(activeUploadIndex)
    }
  }

  function renderUploadBody(): void {
    body.innerHTML = ''
    const visibleUploads = filterModelUploadsForSession(uploads, currentSessionId)
    const entry =
      activeUploadIndex !== null
        ? visibleUploads.find(u => u.index === activeUploadIndex)
        : null
    if (!entry) {
      const empty = document.createElement('div')
      empty.textContent =
        uploads.length === 0
          ? 'No model uploads yet. Send a prompt to record one.'
          : currentSessionId
            ? `No model uploads for current session ${formatSessionIdForOverlay(currentSessionId)} yet.`
            : 'Select an upload from the dropdown.'
      empty.style.color = '#94a3b8'
      empty.style.padding = '12px 4px'
      body.appendChild(empty)
      return
    }

    // Summary panel — the most important fields, plus a callout when
    // serialization dropped messages (the suspected "last 2 missing"
    // case). The full entry is below as a collapsible JSON tree.
    const summary = document.createElement('div')
    Object.assign(summary.style, {
      display: 'grid',
      gridTemplateColumns: 'auto 1fr',
      columnGap: '8px',
      rowGap: '2px',
      marginBottom: '8px',
      padding: '6px 8px',
      background: 'rgba(30, 41, 59, 0.5)',
      borderRadius: '4px',
    } as CSSStyleDeclaration)
    const rows: Array<[string, string]> = [
      ['index', `#${entry.index}`],
      ['timestamp', entry.timestamp],
      ['current session', formatSessionIdForOverlay(currentSessionId)],
      ['request session', formatSessionIdForOverlay(entry.sessionId)],
      ['querySource', entry.querySource],
      ['provider', entry.providerId ?? '—'],
      ['model', entry.model ?? '—'],
      ['messages (wire)', String(entry.messageCount)],
    ]
    if (entry.inputMessageCount !== undefined) {
      rows.push(['messages (input)', String(entry.inputMessageCount)])
      if (entry.inputMessageCount !== entry.messageCount) {
        rows.push([
          'dropped',
          `${entry.inputMessageCount - entry.messageCount} (see serializeMessagesForBridge warning)`,
        ])
      }
    }
    rows.push(['tools', String(entry.toolCount)])
    rows.push(['payload size', `${(entry.payloadLength / 1024).toFixed(2)} KB`])
    rows.push([
      'responses',
      entry.responses && entry.responses.length > 0
        ? String(entry.responses.length)
        : '0 (pending or none)',
    ])
    for (const [key, value] of rows) {
      const k = document.createElement('div')
      k.textContent = key
      k.style.color = '#94a3b8'
      const v = document.createElement('div')
      v.textContent = value
      v.style.color =
        key === 'dropped' && entry.inputMessageCount !== entry.messageCount
          ? '#fbbf24'
          : '#e2e8f0'
      v.style.fontWeight =
        key === 'dropped' && entry.inputMessageCount !== entry.messageCount
          ? '600'
          : 'normal'
      summary.appendChild(k)
      summary.appendChild(v)
    }
    body.appendChild(summary)

    // Build a combined view object that interleaves the request
    // payload with the model's response(s). Showing both in the same
    // tree is the load-bearing fix for "the last assistant text
    // response is missing from the log" — when the agent loop ends
    // on a text-only response, that response only appears here (no
    // subsequent request carries it).
    const responseMessages =
      entry.responses && entry.responses.length > 0
        ? entry.responses.map(r => r.message)
        : []
    const combinedView: Record<string, unknown> = {
      request:
        typeof entry.payload === 'object' && entry.payload !== null
          ? entry.payload
          : { value: entry.payload },
      response: {
        messageCount: responseMessages.length,
        messages: responseMessages,
      },
    }

    // Body-level "Copy All" — copies the combined view (request +
    // response) as formatted JSON. Sits inside the tab body in
    // addition to the header buttons because the JSON tree is what
    // the user is looking at, and a copy button next to it is the
    // obvious place to find it.
    const bodyActions = document.createElement('div')
    Object.assign(bodyActions.style, {
      display: 'flex',
      gap: '6px',
      marginBottom: '6px',
    } as CSSStyleDeclaration)
    const copyAllBodyBtn = makeButton('Copy All', () => {
      const json = JSON.stringify(combinedView, null, 2)
      void writeClipboard(json).then(ok => {
        flashToast(ok ? 'Copied request + response!' : 'Copy failed')
      })
    })
    copyAllBodyBtn.title =
      'Copy the request payload and the model response as one formatted JSON document'
    bodyActions.appendChild(copyAllBodyBtn)
    body.appendChild(bodyActions)

    // JSON tree of the combined view. `details`/`summary` give us
    // collapsibility for free. Only the root opens by default — its
    // two top-level keys (`request` and `response`) stay collapsed so
    // opening a large upload doesn't dump a 200-message transcript
    // into the viewport. `copyButtonDepth: 1` injects a per-node Copy
    // button on each top-level key so the user can grab just the
    // request payload or just the response.
    const treeRoot = renderJsonTree(combinedView, 'upload', {
      defaultOpen: true,
      openDepth: 0,
      copyButtonDepth: 1,
      onCopyNode: (key, value) => {
        const json = JSON.stringify(value, null, 2)
        void writeClipboard(json).then(ok => {
          flashToast(ok ? `Copied ${key}!` : 'Copy failed')
        })
      },
    })
    body.appendChild(treeRoot)

    // Footer note clarifying the source of each section — the
    // request payload is what got sent, the response is what came
    // back. When a turn ends with a text-only assistant reply
    // (no tool calls), `response.messages[]` is the only place that
    // text shows up; the next request never gets logged because the
    // loop exits.
    const footer = document.createElement('div')
    Object.assign(footer.style, {
      marginTop: '8px',
      paddingTop: '6px',
      borderTop: '1px solid rgba(148, 163, 184, 0.2)',
      color: '#64748b',
      fontStyle: 'italic',
      lineHeight: '1.5',
    } as CSSStyleDeclaration)
    footer.textContent =
      'request = the payload sent on this callModel invocation. response = assistant messages yielded back from that same call. Tool results from tool calls appear in the next upload’s request.messages, not here. If you see a yellow "dropped" warning above, serializeMessagesForBridge filtered messages out before they reached the wire.'
    body.appendChild(footer)
  }

  function renderWorkerLogs(): void {
    body.innerHTML = ''
    if (workerLogs.length === 0) {
      const empty = document.createElement('div')
      empty.textContent =
        'No SharedWorker warnings or errors captured yet. ' +
        'console.warn / console.error from the worker realm (e.g. ' +
        '"[mcp] … connect failed") shows up here.'
      empty.style.color = '#94a3b8'
      empty.style.padding = '12px 4px'
      empty.style.lineHeight = '1.5'
      body.appendChild(empty)
      return
    }

    const list = document.createElement('div')
    Object.assign(list.style, {
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
    } as CSSStyleDeclaration)

    // Newest first — the most recent warning/error is what the developer
    // most likely opened the panel to read.
    for (const entry of workerLogs.slice().reverse()) {
      const isError = entry.level === 'error'
      const row = document.createElement('div')
      Object.assign(row.style, {
        display: 'grid',
        gridTemplateColumns: 'auto auto 1fr',
        columnGap: '8px',
        alignItems: 'baseline',
        padding: '4px 8px',
        borderRadius: '4px',
        background: 'rgba(30, 41, 59, 0.5)',
        borderLeft: `3px solid ${isError ? '#ef4444' : '#fbbf24'}`,
      } as CSSStyleDeclaration)

      const time = document.createElement('span')
      time.textContent = new Date(entry.timeMs).toISOString().slice(11, 23)
      time.style.color = '#64748b'
      time.style.whiteSpace = 'nowrap'

      const level = document.createElement('span')
      level.textContent = entry.source
        ? `${entry.level}·${entry.source}`
        : entry.level
      level.style.color = isError ? '#fca5a5' : '#fcd34d'
      level.style.fontWeight = '600'
      level.style.whiteSpace = 'nowrap'

      const text = document.createElement('span')
      text.textContent = entry.text
      text.style.color = '#e2e8f0'
      text.style.whiteSpace = 'pre-wrap'
      text.style.wordBreak = 'break-word'

      row.appendChild(time)
      row.appendChild(level)
      row.appendChild(text)
      list.appendChild(row)
    }

    body.appendChild(list)
  }

  function makeButton(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = label
    Object.assign(btn.style, {
      background: 'rgba(0, 0, 0, 0.3)',
      color: '#e2e8f0',
      border: '1px solid rgba(148, 163, 184, 0.3)',
      borderRadius: '4px',
      padding: '2px 8px',
      fontSize: '11px',
      fontFamily: 'inherit',
      cursor: 'pointer',
    } as CSSStyleDeclaration)
    btn.addEventListener('click', onClick)
    return btn
  }

  function makeTabButton(label: string, onClick: () => void): HTMLButtonElement {
    const btn = makeButton(label, onClick)
    styleTabButton(btn, false)
    return btn
  }

  function styleTabButton(btn: HTMLButtonElement, active: boolean): void {
    btn.style.background = active
      ? 'rgba(74, 144, 217, 0.25)'
      : 'rgba(0, 0, 0, 0.3)'
    btn.style.borderColor = active
      ? 'rgba(74, 144, 217, 0.6)'
      : 'rgba(148, 163, 184, 0.3)'
    btn.style.color = active ? '#f1f5f9' : '#e2e8f0'
  }

  function copyActive(): void {
    if (activeTab === 'timeline') {
      copyActiveTraceMarkdown()
    } else if (activeTab === 'json') {
      copyActiveUploadJson()
    } else {
      copyWorkerLogs()
    }
  }

  function copyAll(): void {
    if (activeTab === 'timeline') {
      copyAllTracesMarkdown()
    } else if (activeTab === 'json') {
      copyAllUploadsJson()
    } else {
      copyWorkerLogs()
    }
  }

  function copyWorkerLogs(): void {
    if (workerLogs.length === 0) {
      flashToast('No worker logs to copy')
      return
    }
    const text = workerLogs
      .map(
        e =>
          `${new Date(e.timeMs).toISOString()} [${e.level}] ${e.text}`,
      )
      .join('\n')
    void writeClipboard(text).then(ok => {
      flashToast(ok ? `Copied ${workerLogs.length} logs!` : 'Copy failed')
    })
  }

  function copyActiveTraceMarkdown(): void {
    const group = activeTraceId ? traces.get(activeTraceId) : null
    if (!group) return
    const md = formatTraceAsMarkdown(group)
    void writeClipboard(md).then(ok => {
      flashToast(ok ? 'Copied!' : 'Copy failed')
    })
  }

  function copyAllTracesMarkdown(): void {
    if (traces.size === 0) {
      flashToast('No traces to copy')
      return
    }
    // Sort newest-first so the most recent (and usually most relevant)
    // trace lands at the top of the pasted document.
    const sorted = Array.from(traces.values()).sort(
      (a, b) => b.startMs - a.startMs,
    )
    const sections = sorted.map(group => formatTraceAsMarkdown(group))
    const header = `# All captured traces (${sorted.length})\n\nNewest first.\n\n---\n\n`
    const md = header + sections.join('\n---\n\n')
    void writeClipboard(md).then(ok => {
      flashToast(ok ? `Copied ${sorted.length} traces!` : 'Copy failed')
    })
  }

  function copyActiveUploadJson(): void {
    const visibleUploads = filterModelUploadsForSession(uploads, currentSessionId)
    const entry =
      activeUploadIndex !== null
        ? visibleUploads.find(u => u.index === activeUploadIndex)
        : null
    if (!entry) {
      flashToast('No upload selected')
      return
    }
    const json = JSON.stringify(entry, null, 2)
    void writeClipboard(json).then(ok => {
      flashToast(ok ? 'Copied JSON!' : 'Copy failed')
    })
  }

  function copyAllUploadsJson(): void {
    const visibleUploads = filterModelUploadsForSession(uploads, currentSessionId)
    if (visibleUploads.length === 0) {
      flashToast(currentSessionId ? 'No current-session uploads to copy' : 'No uploads to copy')
      return
    }
    const json = JSON.stringify(visibleUploads, null, 2)
    void writeClipboard(json).then(ok => {
      flashToast(ok ? `Copied ${visibleUploads.length} uploads!` : 'Copy failed')
    })
  }

  function flashToast(text: string): void {
    toast.textContent = text
    toast.style.opacity = '1'
    setTimeout(() => {
      toast.style.opacity = '0'
    }, 1200)
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    localUnsubscribe()
    portUnsubscribe?.()
    uploadUnsubscribe()
    try {
      globalThis.removeEventListener?.(
        NEXUS_ACTIVE_SESSION_CHANGED_EVENT,
        activeSessionHandler as EventListener,
      )
    } catch {
      // See install-time guard above.
    }
    root.remove()
    minBar.remove()
  }

  return dispose
}

// -- JSON tree renderer -----------------------------------------------------

/**
 * Render a JS value as a collapsible `<details>` tree; cycles show as
 * `[Circular]`.
 */
type JsonTreeOptions = {
  defaultOpen?: boolean
  /**
   * Auto-expand nodes whose `depth < openDepth + 1`. With `openDepth:
   * 0` only the root is open; children must be clicked to expand.
   */
  openDepth?: number
  /**
   * Depth at which to inject a "Copy" button on each node's summary
   * line. The button copies that subtree's JSON via `onCopyNode`.
   * Typically `1` so the user gets per-top-level-key copy buttons
   * (one for `messages`, one for `tools`, etc.).
   */
  copyButtonDepth?: number
  onCopyNode?: (key: string, value: unknown) => void
}

function renderJsonTree(
  value: unknown,
  rootKey: string,
  opts: JsonTreeOptions = {},
): HTMLElement {
  const root = document.createElement('div')
  Object.assign(root.style, {
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: '11px',
    lineHeight: '1.5',
  } as CSSStyleDeclaration)
  const seen = new WeakSet<object>()
  const node = renderJsonNode(value, rootKey, 0, opts, seen)
  root.appendChild(node)
  return root
}

const JSON_COLORS = {
  key: '#93c5fd',
  string: '#86efac',
  number: '#fcd34d',
  boolean: '#f9a8d4',
  null: '#94a3b8',
  meta: '#64748b',
} as const

function renderJsonNode(
  value: unknown,
  key: string,
  depth: number,
  opts: JsonTreeOptions,
  seen: WeakSet<object>,
): HTMLElement {
  const isObj = value !== null && typeof value === 'object'

  if (!isObj) {
    return renderJsonLeaf(value, key)
  }

  if (seen.has(value)) {
    const row = document.createElement('div')
    row.style.paddingLeft = `${depth * 12}px`
    row.innerHTML =
      `<span style="color:${JSON_COLORS.key}">${escapeHtml(key)}</span>` +
      `<span style="color:${JSON_COLORS.meta}">: [Circular]</span>`
    return row
  }
  seen.add(value)

  const details = document.createElement('details')
  details.style.paddingLeft = `${depth * 12}px`
  const isArray = Array.isArray(value)
  const entries = isArray
    ? (value as unknown[]).map(
        (v, i) => [String(i), v] as [string, unknown],
      )
    : Object.entries(value as Record<string, unknown>)

  const shouldOpen =
    opts.defaultOpen === true && depth < (opts.openDepth ?? 0) + 1
  if (shouldOpen) details.open = true

  const summary = document.createElement('summary')
  Object.assign(summary.style, {
    cursor: 'pointer',
    userSelect: 'none',
    listStyle: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  } as CSSStyleDeclaration)
  const preview = isArray
    ? `Array(${entries.length})`
    : `{${entries
        .slice(0, 3)
        .map(([k]) => k)
        .join(', ')}${entries.length > 3 ? ', …' : ''}}`

  // Label span carries the chevron + key + preview. Kept as one
  // child so the per-node Copy button can sit next to it without
  // interfering with the chevron-flip on toggle.
  const labelSpan = document.createElement('span')
  labelSpan.innerHTML =
    `<span style="color:${JSON_COLORS.meta}">${details.open ? '▾' : '▸'}</span> ` +
    `<span style="color:${JSON_COLORS.key}">${escapeHtml(key)}</span>` +
    `<span style="color:${JSON_COLORS.meta}">: ${escapeHtml(preview)}</span>`
  summary.appendChild(labelSpan)

  // Per-node Copy button — injected at `copyButtonDepth` (typically 1
  // so each top-level field under `payload` gets one). Click is
  // captured before the details toggle so the user can copy without
  // the side effect of expanding/collapsing the node.
  if (
    opts.copyButtonDepth !== undefined
    && depth === opts.copyButtonDepth
    && opts.onCopyNode
  ) {
    const copyBtn = document.createElement('button')
    copyBtn.type = 'button'
    copyBtn.textContent = 'Copy'
    copyBtn.title = `Copy "${key}" as JSON`
    Object.assign(copyBtn.style, {
      background: 'rgba(0, 0, 0, 0.3)',
      color: '#e2e8f0',
      border: '1px solid rgba(148, 163, 184, 0.3)',
      borderRadius: '3px',
      padding: '0 6px',
      fontSize: '10px',
      fontFamily: 'inherit',
      cursor: 'pointer',
      marginLeft: 'auto',
    } as CSSStyleDeclaration)
    const onCopy = opts.onCopyNode
    copyBtn.addEventListener('click', event => {
      event.stopPropagation()
      event.preventDefault()
      onCopy(key, value)
    })
    summary.appendChild(copyBtn)
  }
  details.appendChild(summary)

  // Flip the chevron when the details element toggles open/closed.
  details.addEventListener('toggle', () => {
    const chevronSpan = labelSpan.firstElementChild as HTMLElement | null
    if (chevronSpan) chevronSpan.textContent = details.open ? '▾' : '▸'
  })

  // Lazy-render children only on first expand to keep large payloads
  // (200-message transcripts, 30-tool definitions) cheap to display.
  let expanded = false
  const expand = (): void => {
    if (expanded) return
    expanded = true
    for (const [childKey, childValue] of entries) {
      details.appendChild(
        renderJsonNode(childValue, childKey, depth + 1, opts, seen),
      )
    }
  }
  if (details.open) expand()
  details.addEventListener('toggle', () => {
    if (details.open) expand()
  })

  return details
}

function renderJsonLeaf(value: unknown, key: string): HTMLElement {
  const row = document.createElement('div')
  row.style.paddingLeft = '12px'
  let valueHtml: string
  if (value === null) {
    valueHtml = `<span style="color:${JSON_COLORS.null}">null</span>`
  } else if (value === undefined) {
    valueHtml = `<span style="color:${JSON_COLORS.null}">undefined</span>`
  } else if (typeof value === 'string') {
    const truncated = value.length > 500 ? value.slice(0, 500) + '…' : value
    valueHtml = `<span style="color:${JSON_COLORS.string}">${escapeHtml(JSON.stringify(truncated))}</span>`
  } else if (typeof value === 'number') {
    valueHtml = `<span style="color:${JSON_COLORS.number}">${value}</span>`
  } else if (typeof value === 'boolean') {
    valueHtml = `<span style="color:${JSON_COLORS.boolean}">${value}</span>`
  } else {
    valueHtml = `<span style="color:${JSON_COLORS.meta}">${escapeHtml(String(value))}</span>`
  }
  row.innerHTML =
    `<span style="color:${JSON_COLORS.key}">${escapeHtml(key)}</span>` +
    `<span style="color:${JSON_COLORS.meta}">: </span>` +
    valueHtml
  return row
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// -- Markdown formatter -----------------------------------------------------

/**
 * Render a trace as a Markdown table the user can paste back into chat.
 * Columns mirror `formatTraceTable` so it's the same shape as the
 * `__nexusTrace.dumpAll()` console.table output.
 */
export function formatTraceAsMarkdown(group: TraceGroup): string {
  const records = group.records.slice().sort((a, b) => a.startMs - b.startMs)
  const t0 = group.startMs
  const totalMs = group.endMs - group.startMs

  const headerLines = [
    `# ${getProductName()} trace ${group.traceId}`,
    `${records.length} spans · total ${totalMs.toFixed(1)} ms`,
    '',
    '| ctx | name | offset (ms) | duration (ms) | parent | attrs |',
    '|-----|------|-------------|---------------|--------|-------|',
  ]
  const rowLines = records.map(r => {
    const offset = (r.startMs - t0).toFixed(2)
    const dur = r.durationMs === undefined ? '·' : r.durationMs.toFixed(2)
    const attrs = r.attrs
      ? '`' + escapePipes(JSON.stringify(r.attrs)) + '`'
      : ''
    const parent = r.parentSpanId?.slice(0, 8) ?? ''
    return `| ${r.context} | \`${escapePipes(r.name)}\` | ${offset} | ${dur} | ${parent} | ${attrs} |`
  })
  return [...headerLines, ...rowLines, ''].join('\n')
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, '\\|')
}
