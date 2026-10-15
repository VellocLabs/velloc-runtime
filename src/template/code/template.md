---
type: code
description: Coding agent — read/edit/shell + planning + sub-agents + web docs; no UI or scheduling.
# Launcher name/title/icon for this type live in `src/template/index.md`.
# Full file/shell + plan + tasks + sub-agents + web (docs). Excludes `schedule`
# (routines) — not a coding concern. Browser deferred (test web apps on demand);
# a2ui / agent-teams deferred too.
tools:
  - read
  - shell
  - plan
  - todo
  - subagent
  - webfetch
  - ask
  - skills
  - superedit
  - misc
deferredTools: [browser, a2ui, agent-teams]
---

## prompt

# `!system` is the SHARED harness block: `# How this session works` (CC 2.1.258 standard) or

# `# Harness` (`system-lean.md`, CC's lean prompt). `@standard` gates a line

# to one profile — CC's lean prompt has no `# Approach to tasks` section at all.

!code_intro
!system
!code_doing_tasks @standard
!executing_with_care @standard
!code_using_your_tools
!tool_call_parallelism @standard
!code_tone_and_style
!pronouns
!executing_with_care @lean
!delivering_work
!autonomy
!code_autonomy
$skill_catalogs
$session_guidance
$environment
$memory

## begin

$skill_listing
