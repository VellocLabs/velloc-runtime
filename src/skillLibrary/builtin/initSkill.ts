/**
 * Bundled `init` skill (slash-only): bootstraps the project-instruction file
 * (`AGENTS.md`, improving whichever of it or `CLAUDE.md` exists) (F-11).
 */

import { addStockSkill } from '../builtinSkills'
import { INSTRUCTION_FILE } from '../../branding/runtimeDir'

const FILE = INSTRUCTION_FILE // AGENTS.md

const INIT_PROMPT = `Study this repository and write a ${FILE} that future Nexus sessions will read before they work here.

## Which file to write

${FILE} is the open-standard instruction file. Nexus reads it first; a project that has no ${FILE} but has a CLAUDE.md gets that file read instead.

Before writing anything, check which of the two exists:

- Neither exists: create ${FILE}.
- ${FILE} exists: improve it in place.
- CLAUDE.md exists and ${FILE} does not: improve CLAUDE.md in place. Never create a ${FILE} next to a CLAUDE.md — the new file would take over from the existing one and its instructions would be silently lost.

## What to capture

1. The commands people actually use here. How to build, how to lint, how to run the test suite, and how to run one single test. Take them from the real configuration — package scripts, Makefiles, task runners, CI definitions — not from memory of how such projects usually work.
2. The architecture a newcomer cannot see from any one file. How the main pieces fit together, which boundaries matter, and anything that takes several files to understand: request flows, state ownership, code generation, plugin or extension points, conventions that the code relies on but does not state.

## What to leave out

- Repetition, padding, and generic engineering advice. If a competent engineer would already do it without being told, do not write it down. Lines such as "write unit tests for new code", "keep functions small", or "handle errors gracefully" say nothing about this repository.
- Lists of files, directories or components that a directory listing already shows. Describe relationships, not inventories.
- Sections no source backs. Do not invent a "tips", "support", "common tasks" or similar section because it seems customary. Every statement in the file must trace back to something you read in the repository.

## What to carry over

Read any existing editor or assistant rule files — \`.cursor/rules/\`, \`.cursorrules\`, \`.github/copilot-instructions.md\` — and the project README.md. Bring their important, repository-specific points into ${FILE}, condensed and deduplicated. Leave behind anything generic.

## Required header

The file begins with this header, exactly, and the body follows it:

\`\`\`markdown
# ${FILE}

Guidance for the Nexus agent working in this repository — read it before changing anything here.
\`\`\`

When improving an existing file, keep its header if it already has one that serves this purpose; otherwise place this header at the top and keep the rest of the content below it.`

export function registerInitSkill(): void {
  addStockSkill({
    name: 'init',
    description: `Creates or improves the ${INSTRUCTION_FILE} instruction file for this repository: the real build, lint and test commands plus the architecture a newcomer cannot see from one file. Use it when starting work in a project that has no such file or whose file is out of date.`,
    modelInvocation: [],
    content: INIT_PROMPT,
  })
}
