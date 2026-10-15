/**
 * Contract: with an `ids.next` hook, the loop's ids are drawn AHEAD into a small per-kind reserve
 * (`RESERVE_DEPTH`) before the loop and each effect; an empty reserve falls back to the engine's id.
 * A hooked id is refused when not usable (`isUsableId`) or colliding; each hook is bounded by
 * `IDS_NEXT_BUDGET_MS`. Without a hook `idReserveFor` answers undefined.
 */
import type { Ambient } from './ambient'
import type { ToolCallMods } from '../mods/toolCallEvent'
import { isUsableId, type IdKind } from '../mods/idsEvent'

type IdMods = Pick<Partial<ToolCallMods>, 'hasIdsNextHooks' | 'idsNext' | 'report'>

/** How many ids of each kind are kept ready. A run draws one turn id and
 *  one run id as it opens, and a few row ids per step. */
export const RESERVE_DEPTH: Readonly<Record<IdKind, number>> = Object.freeze({ message: 4, turn: 1, run: 1 })

const KINDS: readonly IdKind[] = ['turn', 'run', 'message']

export type IdReserveStats = { raised: number; ms: number; refused: number; fellBack: number }

export class IdReserve {
  private readonly pools: Record<IdKind, string[]> = { message: [], turn: [], run: [] }
  private readonly issued = new Set<string>()
  readonly stats: IdReserveStats = { raised: 0, ms: 0, refused: 0, fellBack: 0 }

  private readonly core: Ambient['ids']
  private readonly now: () => number

  constructor(
    private readonly base: Ambient,
    private readonly mods: IdMods,
    /** Ids the conversation already holds. */
    private readonly known: ReadonlySet<string>,
  ) {
    this.core = base.ids
    this.now = () => base.clock.now()
  }

  /** Fill the reserve, and answer the loop's services with their ids drawn
   *  from it. */
  async open(signal?: AbortSignal): Promise<Ambient> {
    await this.fill(signal)
    return {
      ...this.base,
      ids: { message: () => this.draw('message'), turn: () => this.draw('turn'), run: () => this.draw('run') },
    }
  }

  private draw(kind: IdKind): string {
    const id = this.pools[kind].shift()
    if (id !== undefined) return id
    this.stats.fellBack += 1
    const own = this.core[kind]()
    this.issued.add(own)
    return own
  }

  /** Top every kind up to its depth through the chain. Stops early when the
   *  hooks are gone or `signal` aborts; never rejects. */
  async fill(signal?: AbortSignal): Promise<void> {
    for (const kind of KINDS) {
      while (this.pools[kind].length < RESERVE_DEPTH[kind]) {
        if (signal?.aborted || this.mods.hasIdsNextHooks?.() !== true || !this.mods.idsNext) return
        const started = this.now()
        let id: string
        try {
          id = await this.mods.idsNext({ kind }, () => this.core[kind](), signal)
        } catch {
          return
        }
        this.stats.ms += this.now() - started
        this.stats.raised += 1
        if (!isUsableId(id) || this.known.has(id) || this.issued.has(id)) {
          this.stats.refused += 1
          this.mods.report?.(
            `mods: ids.next answered ${JSON.stringify(String(id).slice(0, 40))} for a ${kind} id, ` +
              (isUsableId(id) ? 'which is already in use' : 'which is not a usable id') +
              "; the engine's own id is used",
          )
          id = this.core[kind]()
        }
        this.issued.add(id)
        this.pools[kind].push(id)
      }
    }
  }

  /** The run's diagnostic line. */
  summary(): string {
    const { raised, ms, refused, fellBack } = this.stats
    return `mods: ids.next — ${raised} ids raised in ${Math.round(ms)} ms this run; ${refused} refused, ${fellBack} drawn from the engine with the reserve empty`
  }
}

/** The run's reserve, or undefined when no hook selects `ids.next` (the
 *  engine's ids, no dispatch). */
export function idReserveFor(
  mods: IdMods | undefined,
  base: Ambient,
  messages: readonly { uuid?: unknown }[],
): IdReserve | undefined {
  if (!mods?.idsNext || mods.hasIdsNextHooks?.() !== true) return undefined
  const known = new Set<string>()
  for (const row of messages) if (typeof row.uuid === 'string') known.add(row.uuid)
  return new IdReserve(base, mods, known)
}
