/**
 * The on-disk `.<brand>` directory name, from `VITE_BRANDING_PATH_COMPONENT`;
 * dev and unit tests fall back to the default brand.
 */
export const BRANDING_PATH_COMPONENT =
  import.meta.env.VITE_BRANDING_PATH_COMPONENT ?? 'Velloc'

/**
 * The hidden runtime/data directory name, e.g. `.velloc`. Lowercased dotfile,
 * mirroring the `.claude` convention. Derive every `<cwd|home>/.<brand>/…` path
 * from this rather than hardcoding the brand string.
 */
export const RUNTIME_DIR_NAME = `.${BRANDING_PATH_COMPONENT.toLowerCase()}`

/**
 * The instruction file: `AGENTS.md`, the open standard every coding agent
 * reads — deliberately NOT brand-derived. The `CLAUDE.md` names other tools
 * write are its fallbacks, read in place (the slots are in
 * `memory/instructionFiles.ts`).
 */
export const INSTRUCTION_FILE = 'AGENTS.md'

/**
 * The brand instruction file Velloc used to read. No longer an
 * instruction file's name: it is only the LAST candidate of its slot, so a
 * file written then still loads where nothing newer exists (read in place —
 * never written, never copied). See `memory/instructionFiles.ts`.
 */
export const LEGACY_INSTRUCTION_FILE = 'VELLOC.md'
