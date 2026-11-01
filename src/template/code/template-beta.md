---
type: code
# The BETA channel's manifest for `code` — it REPLACES `template.md` there
# (beta.velloc.app, or a dev server opened with `?channel=beta`). Same
# manifest as `template.md` plus child sessions (F-36): the `sessions`
# tool group eager in `tools:`, and the `!child_sessions` holder after the
# tools block. To ship, make `template.md` match.
description: Coding agent — read/edit/shell + planning + sub-agents + web docs; browser, UI and scheduling deferred.
# Launcher name/title/icon for this type live in `src/template/index.md`.
# Full file/shell + plan + tasks + sub-agents + web (docs). Browser deferred
# (test web apps on demand); `schedule` deferred (routines, for `/loop`);
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
  - sessions
deferredTools: [browser, schedule, a2ui, agent-teams]
---

## prompt

# `!system` is the SHARED harness block: `# How this session works` (standard profile) or

# `# Harness` (`system-lean.md`, lean profile). `@standard` gates a line

# to one profile — the lean profile has no `# Approach to tasks` section at all.

!code_intro
!system
!code_doing_tasks @standard
!executing_with_care @standard
!code_using_your_tools
!child_sessions
!tool_call_parallelism @standard
!code_tone_and_style
!pronouns
!executing_with_care @lean
!delivering_work
!autonomy
!code_autonomy
$skill_catalogs
$mcp_servers
$session_guidance
$environment
$memory

## begin

$skill_listing
