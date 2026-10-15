/**
 * Contract: TaskRegistry — a pure data container for live and finished tasks (keyed by native id) and
 * the public-to-native id index. Invariants:
 * - eviction is per-type FIFO and cleans the index for evicted records
 * - resolveNative is idempotent (native ids pass through)
 */

export class TaskRegistry<
  TLive extends { type: string },
  TFinished extends { type: string; taskId?: string },
> {
  private readonly live = new Map<string, TLive>()
  private readonly finished = new Map<string, TFinished>()
  private readonly taskIdToNative = new Map<string, string>()

  // --- Registration ---

  registerLive(nativeId: string, state: TLive, publicTaskId?: string): void {
    // A cross-TYPE native-id collision (live or finished) fails loudly; same-type re-registration is
    // allowed (resume flows clean the stale record first).
    const live = this.live.get(nativeId)
    const finished = this.finished.get(nativeId)
    const existingType = live?.type ?? finished?.type
    if (existingType && existingType !== state.type) {
      throw new Error(
        `Task native-id collision: '${nativeId}' is registered as '${existingType}', refusing '${state.type}'`,
      )
    }
    this.live.set(nativeId, state)
    if (publicTaskId) {
      this.taskIdToNative.set(publicTaskId, nativeId)
    }
  }

  recordFinished(nativeId: string, record: TFinished): void {
    this.live.delete(nativeId)
    // Settle any prior finished record for this native id
    // atomically. Deleting before the set (a) refreshes the Map insertion
    // order so the fresh record is not evicted as if it were the OLDEST of
    // its type, and (b) unindexes the prior record's public taskId — a
    // stale public id must never resolve into the new record.
    const prior = this.finished.get(nativeId)
    if (prior) {
      // A cross-type prior must never be silently replaced —
      // with the registerLive guard above this is unreachable in normal
      // flows, so reaching it means an invariant broke upstream.
      if (prior.type !== record.type) {
        throw new Error(
          `Task native-id collision: finished '${nativeId}' is '${prior.type}', refusing '${record.type}'`,
        )
      }
      this.finished.delete(nativeId)
      if (prior.taskId && prior.taskId !== record.taskId) {
        this.taskIdToNative.delete(prior.taskId)
      }
    }
    this.finished.set(nativeId, record)
  }

  // --- Eviction ---

  /**
   * Evict oldest finished records of a given type until count <= cap.
   * Cleans up the taskIdToNative index for evicted records that carry a
   * taskId. Calls onEvict(nativeId) for each evicted entry so the caller
   * can clean up auxiliary state (e.g. acknowledged-result sets). `filter`
   * narrows both the count and the eviction to the records it accepts, so one
   * kind can keep separate caps for separate populations.
   */
  evictFinishedOverCap(
    type: string,
    cap: number,
    onEvict?: (nativeId: string) => void,
    filter?: (record: TFinished) => boolean,
  ): void {
    const counts = (r: TFinished): boolean => r.type === type && (!filter || filter(r))
    let count = 0
    for (const r of this.finished.values()) {
      if (counts(r)) count++
    }
    while (count > cap) {
      // Find the oldest entry of this type (Map preserves insertion order).
      let oldestId: string | undefined
      for (const [id, r] of this.finished) {
        if (counts(r)) {
          oldestId = id
          break
        }
      }
      if (!oldestId) break
      const evicted = this.finished.get(oldestId)
      this.finished.delete(oldestId)
      // Drop the public-taskId index entry so it doesn't linger forever.
      if (evicted?.taskId) {
        this.taskIdToNative.delete(evicted.taskId)
      }
      onEvict?.(oldestId)
      count--
    }
  }

  // --- ID resolution ---

  /**
   * Resolve a public id (a taskId, or a native id) to the native map key.
   * A registered taskId maps to its native id; anything else (a native id
   * passed directly) is returned unchanged.
   */
  resolveNative(publicId: string): string {
    return this.taskIdToNative.get(publicId) ?? publicId
  }

  indexTaskId(publicTaskId: string, nativeId: string): void {
    this.taskIdToNative.set(publicTaskId, nativeId)
  }

  removeTaskIdIndex(publicTaskId: string): void {
    this.taskIdToNative.delete(publicTaskId)
  }

  hasTaskIdIndex(publicTaskId: string): boolean {
    return this.taskIdToNative.has(publicTaskId)
  }

  // --- Live task access ---

  getLive(nativeId: string): TLive | undefined {
    return this.live.get(nativeId)
  }

  /** Type-narrowed live task lookup (returns undefined if wrong type). */
  getLiveByType<T extends TLive['type']>(
    nativeId: string,
    type: T,
  ): Extract<TLive, { type: T }> | undefined {
    const t = this.live.get(nativeId)
    return t?.type === type ? (t as Extract<TLive, { type: T }>) : undefined
  }

  deleteLive(nativeId: string): void {
    this.live.delete(nativeId)
  }

  hasLive(nativeId: string): boolean {
    return this.live.has(nativeId)
  }

  *liveByType<T extends TLive['type']>(
    type: T,
  ): IterableIterator<Extract<TLive, { type: T }>> {
    for (const t of this.live.values()) {
      if (t.type === type) yield t as Extract<TLive, { type: T }>
    }
  }

  // --- Finished task access ---

  getFinished(nativeId: string): TFinished | undefined {
    return this.finished.get(nativeId)
  }

  /** Type-narrowed finished record lookup (returns undefined if wrong type). */
  getFinishedByType<T extends TFinished['type']>(
    nativeId: string,
    type: T,
  ): Extract<TFinished, { type: T }> | undefined {
    const r = this.finished.get(nativeId)
    return r?.type === type ? (r as Extract<TFinished, { type: T }>) : undefined
  }

  deleteFinished(nativeId: string): void {
    this.finished.delete(nativeId)
  }

  hasFinished(nativeId: string): boolean {
    return this.finished.has(nativeId)
  }

  *finishedByType<T extends TFinished['type']>(
    type: T,
  ): IterableIterator<Extract<TFinished, { type: T }>> {
    for (const r of this.finished.values()) {
      if (r.type === type) yield r as Extract<TFinished, { type: T }>
    }
  }

  // --- Queries ---

  get liveSize(): number {
    return this.live.size
  }

  get finishedSize(): number {
    return this.finished.size
  }

  /** Iterate all live tasks (any type). */
  *allLive(): IterableIterator<TLive> {
    yield* this.live.values()
  }

  /** Iterate all live task entries [nativeId, state] (any type). */
  *allLiveEntries(): IterableIterator<[string, TLive]> {
    yield* this.live.entries()
  }

  /** Iterate all finished records (any type). */
  *allFinished(): IterableIterator<TFinished> {
    yield* this.finished.values()
  }

  /** Iterate all finished entries [nativeId, record] (any type). */
  *allFinishedEntries(): IterableIterator<[string, TFinished]> {
    yield* this.finished.entries()
  }
}
