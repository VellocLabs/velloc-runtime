// LLM-facing name of the Skill tool, in a module with NO imports: the skill
// tool and the bundled skills form an import cycle, and reading the name
// elsewhere hit its temporal dead zone at boot. Import this for the name
// only. Guarded by `module-split-boundaries.test.ts`.

export const SKILL_TOOL_NAME = 'Skill'
