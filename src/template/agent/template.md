---
type: agent
description: Full-autonomy agent — file + shell + browser + planning + sub-agents; a2ui/teams deferred.
# Launcher name/title/icon for this type live in `src/template/index.md`.
# EAGER-visible by GROUP or SKILL (tools:); DEFERRED by group/skill
# (deferredTools:). Unified: a name in `tools:` loads, in `deferredTools:`
# defers (hidden until Skill()/ToolSearch). Here `browser` is LOADED (listed in
# tools:); a2ui / agent-teams defer.
tools:
  - read
  - edit
  - shell
  - browser
  - subagent
  - plan
  - todo
  - webfetch
  - ask
  - schedule
  - skills
  - misc
deferredTools: [a2ui, agent-teams]
---

## prompt

# legend: !holder | $dynamic | literal. `$environment`/`$memory` are

# appended downstream in v1.

# AGENT owns its full browser-agent prose under `agent_`-prefixed holders (moved

# out of shared_includes/; the shared holders it uses are `system` and

# `delivering_work`):

# !agent_intro          = identity, data-not-instructions, URLs, credentials

# !system               = the SHARED harness block — `# How this session works` under the

# standard profile, `# Harness` under lean

# !agent_doing_tasks    = doing_tasks + executing_actions (browser task rules)

# !agent_tone_and_style = tone_and_style + output_efficiency


# !agent_using_your_tools = the `# Tools` block (file/shell + task tracking +

# skills). The browser

# one-call-per-turn rule is NOT here: it follows the browser CAPABILITY, in

# the catalog below, so every type that can drive the browser gets it exactly

# when it can. The 89-line `## Browser tools` catalog

# is NOT inlined here either — no template inlines it; it arrives via

# `$skill_catalogs` (tools/glic/browserSkillCatalog.ts), always visible for

# this type since its browser tools are eager.

# `!agent_autonomy` (chatgpt-agent-style: "go as far as you can", plan→act→

# verify, clarify only when blocked) sits right after `!agent_intro` so its

# "executing actions with care" back-reference resolves to the section folded

# into agent_intro. The `agent_` prefix keeps every holder globally unique in

# the type-blind C++ registry.

# `!delivering_work` (shared_includes/) follows `!agent_autonomy` with the

# shared `# Long conversations` / `# Delivering work` / `# Correcting yourself` prose —

# the same block `code` / `safe_code` carry, so all three task-running types

# share one persistence contract.

# `!executing_with_care =standard`: this type drives the browser, so it keeps

# the FULL `# Acting carefully` section (the confirm-before list:

# payments, sending, unsaved tabs) under BOTH profiles — the shared holder's

# one-paragraph `-lean` rendering is the coding caution `code` uses, and `agent_autonomy`

# below refers back to "the executing actions with care rules above".

!agent_intro
!system
!agent_doing_tasks
!executing_with_care =standard
!agent_autonomy
!delivering_work
!agent_using_your_tools
!tool_call_parallelism @standard
$skill_catalogs
$session_guidance
!agent_tone_and_style
$environment
$memory

## begin

$skill_listing
