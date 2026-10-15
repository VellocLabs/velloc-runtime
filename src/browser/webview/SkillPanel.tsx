import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { FileTextIcon, LoaderIcon, SparklesIcon } from 'lucide-react'
import { StaticMarkdown } from '@/components/assistant-ui/static-markdown'
import { cn } from '@/lib/utils'
import type { RightPanelSkillTarget } from '@/components/assistant-ui/right-panel-content-context'
import type { BrowserToolCallDetailRecord } from '@/utils/toolCallDetails'
import type { BundledSkillBodyResult } from '@/skillLibrary/builtinSkillBody'
import { isBundledSkillPath } from '@/skillLibrary/builtinSkills'
import type { NexusSessionSkillStatus } from '../bridge/protocol/ui'
import type { SkillPanelListRow } from './sessionSkills'
import { useT } from './i18n'

/**
 * Right-panel Skill view, the one shared Skills tab: the skills invoked in THIS session
 * (recovered view-only from the transcript after a restart), and the selected skill's body,
 * resolved from `target.path` → `target.inlineBody` → the `skill:<uuid>` sidecar → the
 * worker's bundled-skill registry (`loadBundledSkillBody`).
 */
export function SkillPanel({
  target,
  loadedSkills,
  onSelectSkill,
  readFileText,
  loadToolCallDetail,
  loadBundledSkillBody,
}: {
  target: RightPanelSkillTarget | null
  loadedSkills?: readonly SkillPanelListRow[]
  /** Receives the clicked row as-is — the shell decides whether its body
   *  comes from the on-disk `path` or the `detailId` sidecar. */
  onSelectSkill?: (skill: SkillPanelListRow) => void
  readFileText?: (path: string) => Promise<string | null>
  loadToolCallDetail?: (
    toolCallId: string,
  ) => Promise<BrowserToolCallDetailRecord | null>
  /** Worker-registry body lookup for bundled skills (the last-resort body
   *  source above). Omitted → the panel keeps the pre-existing error state. */
  loadBundledSkillBody?: (
    name: string,
  ) => Promise<BundledSkillBodyResult | null>
}): ReactElement {
  const t = useT()
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ready'; text: string; note?: 'invoked' }
    | { kind: 'dynamic' }
    | { kind: 'failed'; error?: string }
    | { kind: 'error' }
  >({ kind: 'idle' })

  const name = target?.name ?? null
  // A bundled skill's `path` is the synthetic `bundled:<name>` — nothing to
  // read from disk, so it never enters the readFileText branch.
  const rawPath = target?.path ?? null
  const path = rawPath !== null && isBundledSkillPath(rawPath) ? null : rawPath
  const detailId = target?.detailId ?? null
  const inlineBody = target?.inlineBody ?? null
  const targetStatus = target?.status ?? null
  const targetError = target?.error ?? null

  useEffect(() => {
    let cancelled = false

    // A failed invocation has no body to resolve — show its error directly.
    if (targetStatus === 'failed') {
      setState({ kind: 'failed', error: targetError ?? undefined })
      return
    }

    // Last-resort body source: ask the worker's bundled-skill registry.
    // Returns false (caller keeps its own error/idle state) when the lookup
    // isn't wired or the target has no name; a non-bundled skill resolves
    // `not_found` and lands on the same error state as before.
    const fallbackToBundled = (): boolean => {
      if (!name || !loadBundledSkillBody) return false
      loadBundledSkillBody(name)
        .then(result => {
          if (cancelled) return
          if (result?.kind === 'static') {
            setState({ kind: 'ready', text: stripFrontmatter(result.body) })
          } else if (result?.kind === 'invoked') {
            setState({
              kind: 'ready',
              text: stripSkillTagHeader(result.body),
              note: 'invoked',
            })
          } else if (result?.kind === 'dynamic') {
            setState({ kind: 'dynamic' })
          } else {
            setState({ kind: 'error' })
          }
        })
        .catch(() => {
          if (!cancelled) setState({ kind: 'error' })
        })
      return true
    }

    // 1) The on-disk SKILL.md (preferred) — read live and render as markdown.
    if (path !== null) {
      if (!readFileText) {
        setState({ kind: 'error' })
        return
      }
      setState({ kind: 'loading' })
      readFileText(path)
        .then(text => {
          if (cancelled) return
          if (text !== null) {
            setState({ kind: 'ready', text: stripFrontmatter(text) })
          } else if (!fallbackToBundled()) {
            setState({ kind: 'error' })
          }
        })
        .catch(() => {
          if (!cancelled && !fallbackToBundled()) setState({ kind: 'error' })
        })
      return () => {
        cancelled = true
      }
    }
    // 2) An inline body (pre-sidecar transcript).
    if (inlineBody !== null) {
      setState({ kind: 'ready', text: stripSkillTagHeader(inlineBody) })
      return
    }
    // 3) The lazy `skill:<uuid>` sidecar.
    if (!detailId || !loadToolCallDetail) {
      // 4) No sidecar at all (legacy pre-sidecar invocation, or a bundled row
      //    that was never invoked here) — the bundled registry is the only
      //    remaining source.
      setState(fallbackToBundled() ? { kind: 'loading' } : { kind: 'idle' })
      return () => {
        cancelled = true
      }
    }
    setState({ kind: 'loading' })
    loadToolCallDetail(detailId)
      .then(detail => {
        if (cancelled) return
        const text = typeof detail?.result === 'string' ? detail.result : null
        if (text) {
          setState({ kind: 'ready', text: stripSkillTagHeader(text) })
        } else if (!fallbackToBundled()) {
          setState({ kind: 'error' })
        }
      })
      .catch(() => {
        if (!cancelled && !fallbackToBundled()) setState({ kind: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [
    name,
    path,
    detailId,
    inlineBody,
    targetStatus,
    targetError,
    readFileText,
    loadToolCallDetail,
    loadBundledSkillBody,
  ])

  const skills = loadedSkills ?? []
  // Header count is DISTINCT skills (the list itself is one row per
  // invocation), and the size sums only `loaded` rows — the bodies actually in
  // context. A `failed` row has none. A row can still lack a size when an older
  // worker bundle emits none AND the registry backfill has none (dynamic-content
  // bundled skills).
  const distinctSkillCount = new Set(skills.map(skill => skill.name)).size
  const totalSize = skills.reduce(
    (sum, skill) =>
      sum + ((skill.status ?? 'loaded') === 'loaded' ? skill.size ?? 0 : 0),
    0,
  )
  // The row to highlight. A target from the list carries the row's event id
  // (rows can share a name). A target opened from a transcript skill card
  // carries none, so it falls back to the invocation's sidecar (`detailId`),
  // then to the newest row of that name (the list is newest-invocation first)
  // — never to every row of the name, and never to none.
  const activeIndex = (() => {
    if (!target) return -1
    if (target.eventId != null) {
      return skills.findIndex(skill => skill.id === target.eventId)
    }
    if (target.detailId) {
      const byDetail = skills.findIndex(
        skill => skill.detailId === target.detailId,
      )
      if (byDetail !== -1) return byDetail
    }
    return skills.findIndex(skill => skill.name === target.name)
  })()
  const list =
    skills.length > 0 ? (
      <div
        className="flex shrink-0 flex-col border-b"
        data-testid="skill-panel-loaded-list"
      >
        <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <span>{t('skillPanel.loadedListHeader')}</span>
          <span
            className="shrink-0 normal-case tracking-normal text-muted-foreground/80"
            data-testid="skill-panel-list-stats"
          >
            {t('skillPanel.listStats', {
              count: distinctSkillCount,
              size: formatBytes(totalSize),
            })}
          </span>
        </div>
        {/* Capped so a long skill list can never crowd out the instructions
         *  view below it — the whole point of this list is to pick a skill,
         *  not to fill the panel. */}
        <ul className="flex max-h-[40vh] flex-col overflow-y-auto pb-1">
          {skills.map((skill, index) => {
            const active = index === activeIndex
            const status: NexusSessionSkillStatus = skill.status ?? 'loaded'
            return (
              <li key={skill.id ?? `${skill.name}:${skill.path}:${index}`}>
                <button
                  type="button"
                  data-testid="skill-panel-loaded-item"
                  data-status={status}
                  onClick={() => onSelectSkill?.(skill)}
                  title={skill.description ?? skill.path}
                  disabled={!onSelectSkill}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-start text-body outline-none transition-colors hover:bg-muted focus-visible:bg-muted disabled:cursor-default',
                    active && 'bg-muted/60',
                  )}
                >
                  <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">
                    {skill.name}
                  </span>
                  <SkillStatusBadge status={status} t={t} />
                  {typeof skill.invokedAt === 'number' ? (
                    <span
                      className="shrink-0 tabular-nums text-[10px] text-muted-foreground/80"
                      data-testid="skill-panel-item-time"
                    >
                      {formatClockTime(skill.invokedAt)}
                    </span>
                  ) : null}
                  {status === 'loaded' && typeof skill.size === 'number' ? (
                    <span
                      className="shrink-0 tabular-nums text-[10px] text-muted-foreground"
                      data-testid="skill-panel-item-size"
                    >
                      {formatBytes(skill.size)}
                    </span>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    ) : null

  // Neither a loaded-skills list nor an opened skill → the original empty state.
  if (!target && !list) {
    return (
      <div
        data-testid="skill-panel-empty"
        className="flex h-full items-center justify-center p-4 text-body text-muted-foreground"
      >
        {t('skillPanel.empty')}
      </div>
    )
  }

  return (
    <div data-testid="skill-panel" className="flex h-full min-h-0 flex-col">
      {list}
      {target ? (
        <>
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <SparklesIcon className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="truncate text-body font-medium" title={target.name}>
                {target.name}
              </div>
              {target.args ? (
                <div className="truncate text-caption text-muted-foreground">
                  {t('skill.argsLine', { args: target.args })}
                </div>
              ) : null}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
            {state.kind === 'loading' ? (
              <div className="flex items-center gap-2 text-body text-muted-foreground">
                <LoaderIcon className="size-3 animate-spin" />
                <span>{t('skillPanel.loading')}</span>
              </div>
            ) : null}
            {state.kind === 'error' || state.kind === 'idle' ? (
              <div className="text-body text-destructive">{t('skillPanel.loadFailed')}</div>
            ) : null}
            {state.kind === 'failed' ? (
              // A failed invocation: no body to render — show why it failed.
              <div data-testid="skill-panel-failed" className="space-y-1.5">
                <div className="text-body font-medium text-destructive">
                  {t('skillPanel.invocationFailed')}
                </div>
                {state.error ? (
                  <pre className="whitespace-pre-wrap break-words rounded bg-destructive/10 px-2 py-1.5 text-code text-destructive">
                    {state.error}
                  </pre>
                ) : null}
              </div>
            ) : null}
            {state.kind === 'dynamic' ? (
              // A dynamic-content bundled skill that hasn't run in this
              // session: there IS no body yet — an informative notice, not an
              // error.
              <div
                data-testid="skill-panel-dynamic-note"
                className="text-body text-muted-foreground"
              >
                {t('skillPanel.dynamicBody')}
              </div>
            ) : null}
            {state.kind === 'ready' ? (
              <>
                {state.note === 'invoked' ? (
                  // Bundled dynamic skill: the body below is the snapshot
                  // injected at its last invocation, not a static file.
                  <div
                    data-testid="skill-panel-invoked-note"
                    className="mb-2 text-caption italic text-muted-foreground"
                  >
                    {t('skillPanel.invokedBodyNote')}
                  </div>
                ) : null}
                <StaticMarkdown content={state.text} />
              </>
            ) : null}
          </div>
        </>
      ) : (
        // A loaded-skills list with no skill opened yet — invite a pick.
        <div className="flex flex-1 items-center justify-center p-4 text-center text-body text-muted-foreground">
          {t('skillPanel.pickFromList')}
        </div>
      )}
    </div>
  )
}

/** Compact byte-size formatter for the loaded-skills list (no i18n — units
 *  are universal short forms). Mirrors the same helper in MemorySection's
 *  saved-memory list and InstructionsSection's file list. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Locale-aware clock time (a formatted value, not UI chrome — like
 *  `formatBytes`). Empty string if the timestamp is unusable. */
function formatClockTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

/** The per-invocation outcome pill (loaded / failed). */
function SkillStatusBadge({
  status,
  t,
}: {
  status: NexusSessionSkillStatus
  t: ReturnType<typeof useT>
}): ReactElement {
  const label =
    status === 'failed'
      ? t('skillPanel.statusFailed')
      : t('skillPanel.statusLoaded')
  const cls =
    status === 'failed'
      ? 'bg-destructive/15 text-destructive'
      : 'bg-success/15 text-success'
  return (
    <span
      data-testid="skill-panel-item-status"
      data-status={status}
      className={cn(
        'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        cls,
      )}
    >
      {label}
    </span>
  )
}

/** The sidecar / inline body holds the whole message text — the
 *  loading-metadata tags and then the SKILL.md body after the first blank line.
 *  Show only the body; the header above already names the skill and its args. */
export function stripSkillTagHeader(text: string): string {
  if (!text.startsWith('<command-message>')) return text
  const at = text.indexOf('\n\n')
  return at < 0 ? text : text.slice(at + 2)
}

/** A `SKILL.md` file opens with a YAML `---` frontmatter block (name /
 *  description / useWhen …). Drop it so the panel shows the skill's prose, not
 *  the raw metadata. Only a frontmatter block at the very start is stripped; a
 *  file without one is returned unchanged. */
export function stripFrontmatter(text: string): string {
  if (!text.startsWith('---')) return text
  // The opening fence is `---` on its own first line, and the line right after
  // it must be NON-blank: real frontmatter starts straight into `key: value`,
  // whereas a leading Markdown thematic break (`---`) is followed by a blank
  // line — the `(?=[^\r\n])` lookahead keeps us from mistaking that horizontal
  // rule for frontmatter and deleting the body between it and the next `---`.
  const match = text.match(/^---\r?\n(?=[^\r\n])[\s\S]*?\r?\n---\r?\n?/)
  return match ? text.slice(match[0].length) : text
}
