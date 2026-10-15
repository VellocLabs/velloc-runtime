// JS-side skill catalogs: per-skill `## X tools` prose, emitted only while the
// skill's tools are visible. A deferrable skill's catalog cannot live in a type's
// static block, which is emitted whole. Process-global, seeded once at boot.

export interface SkillCatalogRegistration {
  /** The skill this catalog belongs to (e.g. 'a2ui'). */
  skillName: string
  /** Tool wire names that gate the section: any present in the visible set ⇒ render.
   *  Ignored when `matchesToolName` is set. */
  toolNames: readonly string[]
  /** Gate by PREDICATE instead of a fixed list — for a skill whose tools are
   *  published by the HOST and therefore cannot be enumerated in this repo
   *  without drifting from it. The browser skill is the case: its `Browser*`
   *  tools come from the C++ catalog per build, and every other site that asks
   *  "is this a browser tool?" uses the same prefix probe. */
  matchesToolName?: (name: string) => boolean
  /** Holder name the section ships under (e.g. 'skill.a2ui.catalog'). */
  holderName: string
  /** The catalog prose — a `## <Skill> tools` markdown section. */
  content: string
}

const registry = new Map<string, SkillCatalogRegistration>()

export function registerSkillCatalog(reg: SkillCatalogRegistration): void {
  registry.set(reg.skillName, reg)
}

/**
 * Catalogs for skills whose tools are in `visibleToolNames` — i.e. active (or
 * always-loaded). Returns `{ holderName, content }` in registration order so
 * `loadSystemPromptHolders` emits one holder per visible skill catalog,
 * positioned right after the type's `# Tools` block.
 */
export function getVisibleSkillCatalogs(
  visibleToolNames: ReadonlySet<string>,
): Array<{ holderName: string; content: string }> {
  const out: Array<{ holderName: string; content: string }> = []
  for (const reg of registry.values()) {
    const visible = reg.matchesToolName
      ? [...visibleToolNames].some(reg.matchesToolName)
      : reg.toolNames.some(name => visibleToolNames.has(name))
    if (visible) {
      out.push({ holderName: reg.holderName, content: reg.content })
    }
  }
  return out
}

/** Test-only: clear the registry between cases. */
export function __resetSkillCatalogsForTest(): void {
  registry.clear()
}
