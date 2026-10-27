/**
 * Built-in sub-agents (Explore / Plan / general-purpose). None sets `model` (it
 * inherits the parent's); general-purpose omits `tools` to inherit the full set
 * (`toolMatchesName` has no wildcard).
 */

import {
  EDIT_TOOL_ID,
  READ_TOOL_ID,
  WRITE_TOOL_ID,
} from '../prompting/fileToolNames'
import {
  SHELL_TOOL_ID,
  FIND_FILES_TOOL_ID,
  SEARCH_TEXT_TOOL_ID,
} from '../prompting/processToolNames'
import type { AgentProfile } from '../runtime/RuntimeTypes'
import { SPAWN_TOOL_ID } from '../toolkit/builtin/subagentLaunch'
import { FORK_NESTED_ERROR, FORK_ROUTE_KIND } from '../toolkit/builtin/subagentFork'
import { PLAN_OFF_TOOL_ID } from '../toolkit/builtin/planExit'
import { NOTEBOOK_TOOL_ID } from '../toolkit/builtin/notebookEdit'
import { findAgentDefinition, type AgentDefinitionFull } from './agentRegistry'

/**
 * Tools the read-only agents (Explore / Plan) must never see, applied as
 * `disallowedTools`: drop the mutating + recursion + plan-exit tools
 * while still inheriting the dynamic C++/MCP read tools an allowlist can't name.
 */
const READ_ONLY_DENYLIST = [
  SPAWN_TOOL_ID,
  PLAN_OFF_TOOL_ID,
  EDIT_TOOL_ID,
  WRITE_TOOL_ID,
  NOTEBOOK_TOOL_ID,
]

const EXPLORE_SYSTEM_PROMPT = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from:
- Creating new files (no ${WRITE_TOOL_ID}, touch, or file creation of any kind)
- Modifying existing files (no ${EDIT_TOOL_ID} operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools - attempting to edit files will fail.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use ${FIND_FILES_TOOL_ID} for broad file pattern matching
- Use ${SEARCH_TEXT_TOOL_ID} for searching file contents with regex
- Use ${READ_TOOL_ID} when you know the specific file path you need to read
- Use ${SHELL_TOOL_ID} ONLY for read-only operations (ls, git status, git log, git diff, find, cat, head, tail)
- NEVER use ${SHELL_TOOL_ID} for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification
- Adapt your search approach based on the thoroughness level specified by the caller
- Communicate your final report directly as a regular message - do NOT attempt to create files

NOTE: You are meant to be a fast agent that returns output as quickly as possible. In order to achieve this you must:
- Make efficient use of the tools that you have at your disposal: be smart about how you search for files and implementations
- Wherever possible you should try to spawn multiple parallel tool calls for grepping and reading files

Complete the user's search request efficiently and report your findings clearly.`

const PLAN_SYSTEM_PROMPT = `You are a software architect and planning specialist. Your role is to explore the codebase and design implementation plans.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY planning task. You are STRICTLY PROHIBITED from:
- Creating new files (no ${WRITE_TOOL_ID}, touch, or file creation of any kind)
- Modifying existing files (no ${EDIT_TOOL_ID} operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Your role is EXCLUSIVELY to explore the codebase and design implementation plans. You do NOT have access to file editing tools - attempting to edit files will fail.

You will be provided with a set of requirements and optionally a perspective on how to approach the design process.

## Your Process

1. **Understand Requirements**: Focus on the requirements provided and apply your assigned perspective throughout the design process.

2. **Explore Thoroughly**:
   - Read any files provided to you in the initial prompt
   - Find existing patterns and conventions using ${FIND_FILES_TOOL_ID}, ${SEARCH_TEXT_TOOL_ID}, and ${READ_TOOL_ID}
   - Understand the current architecture
   - Identify similar features as reference
   - Trace through relevant code paths
   - Use ${SHELL_TOOL_ID} ONLY for read-only operations (ls, git status, git log, git diff, find, cat, head, tail)
   - NEVER use ${SHELL_TOOL_ID} for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification

3. **Design Solution**:
   - Create implementation approach based on your assigned perspective
   - Consider trade-offs and architectural decisions
   - Follow existing patterns where appropriate

4. **Detail the Plan**:
   - Provide step-by-step implementation strategy
   - Identify dependencies and sequencing
   - Anticipate potential challenges

## Required Output

End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- path/to/file1.ts
- path/to/file2.ts
- path/to/file3.ts

REMEMBER: You can ONLY explore and plan. You CANNOT and MUST NOT write, edit, or modify any files. You do NOT have access to file editing tools.`

const GENERAL_PURPOSE_SYSTEM_PROMPT = `You are a general-purpose agent. Given the user's message, you should use the tools available to complete the task. Complete the task fully—don't gold-plate, but don't leave it half-done. When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.

Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives. Use ${READ_TOOL_ID} when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.`

export const READONLY_SEARCH_AGENT: AgentDefinitionFull = {
  name: 'Explore',
  description:
    'Read-only scout for a codebase: finds files by pattern ("src/components/**/*.tsx"), locates code by keyword ("rate limiter"), and answers questions about how something is wired together. Say how far it should dig: "quick" for a direct lookup, "medium" for a bounded survey, "very thorough" when the answer may be spread over several places or spellings.',
  systemPrompt: EXPLORE_SYSTEM_PROMPT,
  disallowedTools: READ_ONLY_DENYLIST,
  source: 'built-in',
}

export const PLAN_AGENT: AgentDefinitionFull = {
  name: 'Plan',
  description:
    'Designs how to implement a change before any code is written: reads the relevant code, proposes an ordered sequence of steps, names the files that matter, and weighs the structural trade-offs. Returns the plan, not the implementation.',
  systemPrompt: PLAN_SYSTEM_PROMPT,
  disallowedTools: READ_ONLY_DENYLIST,
  source: 'built-in',
}

export const DEFAULT_WORKER_AGENT: AgentDefinitionFull = {
  name: 'general-purpose',
  description:
    'The default worker for anything that takes many steps or many searches: investigating a question across the codebase, hunting for a symbol or file whose name you only half know, or carrying out a self-contained multi-step task. Use it when the first few lookups are unlikely to land.',
  systemPrompt: GENERAL_PURPOSE_SYSTEM_PROMPT,
  // No `tools` allowlist → inherits the full tool set.
  source: 'built-in',
}

/** The agents seeded into every session's registry. */
export const BUILT_IN_AGENTS: AgentDefinitionFull[] = [
  READONLY_SEARCH_AGENT,
  PLAN_AGENT,
  DEFAULT_WORKER_AGENT,
]

/**
 * Append the built-in agents to a caller/plugin-supplied list, de-duplicated by
 * name with the supplied agents winning. This lets a user/project/plugin
 * `agents/*.md` override a built-in (e.g. ship a stricter "Explore") while the
 * remaining built-ins always stay available.
 */
export function withBuiltInAgents(
  custom: readonly AgentProfile[] | undefined,
): AgentProfile[] {
  const byName = new Map<string, AgentProfile>()
  for (const agent of [...(custom ?? []), ...BUILT_IN_AGENTS]) {
    const name = typeof agent.name === 'string' ? agent.name : undefined
    // `fork` is reserved for the Agent tool's fork route — a custom agent named
    // `fork` must never shadow it or show up in the `subagent_type` listing.
    if (name === FORK_ROUTE_KIND) continue
    if (name && !byName.has(name)) {
      byName.set(name, agent)
    }
  }
  return [...byName.values()]
}

/**
 * The route an `Agent` tool `subagent_type` resolves to: `fork` (inherits the
 * parent's context; never nested), `named` (isolated specialist; the default,
 * general-purpose), or `error` (a user-facing message).
 */
export type SubagentRoute =
  | { kind: 'fork' }
  | { kind: 'named'; agent: AgentDefinitionFull }
  | { kind: 'error'; message: string }

/**
 * Resolve a `subagent_type`: omitted → general-purpose; `"fork"` → the fork
 * route, rejected at `opts.depth` ≥ 1; any other name → `activeAgents`, falling
 * back to the static built-ins.
 */
export function resolveSubagentRoute(
  requestedKind: string | undefined,
  activeAgents: readonly AgentProfile[],
  opts?: {
    depth?: number
    /** `activeAgents` is the whole offer (a type's `agents:` list): no
     *  built-in fallback. */
    rosterOnly?: boolean
  },
): SubagentRoute {
  const requestedType = requestedKind ?? DEFAULT_WORKER_AGENT.name
  if (requestedType === FORK_ROUTE_KIND) {
    if ((opts?.depth ?? 0) >= 1) {
      return { kind: 'error', message: FORK_NESTED_ERROR }
    }
    return { kind: 'fork' }
  }
  const agent =
    findAgentDefinition(activeAgents, requestedType) ??
    (opts?.rosterOnly ? undefined : BUILT_IN_AGENTS.find(a => a.name === requestedType))
  if (!agent) {
    const available = activeAgents
      .map(a => a.name)
      .filter(
        (name): name is string =>
          typeof name === 'string' && name !== FORK_ROUTE_KIND,
      )
    // Names are matched exactly, never case-folded: an `Agent(<type>)`
    // permission rule compares the requested string, so resolving `explore`
    // to `Explore` would slip past a rule written for `Explore`.
    const sameButCase = available.filter(
      name => name.toLowerCase() === requestedType.toLowerCase(),
    )
    const suggestion =
      sameButCase.length === 1 ? `Did you mean "${sameButCase[0]}"? Names are case-sensitive. ` : ''
    return {
      kind: 'error',
      message:
        `Agent could not start: unknown subagent_type "${requestedType}". ` +
        suggestion +
        (available.length > 0
          ? `Available agents: ${available.join(', ')}.`
          : 'No custom agents are registered.'),
    }
  }
  return { kind: 'named', agent }
}
