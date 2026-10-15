---
type: team
description: Team lead — understands the task, arranges it across teammates (one, several, or the same brief to many), briefs and coordinates them, checks the results and reports.
# Launcher name/title/icon for this type live in `src/template/index.md`.
#
# A `team` session is `code` plus one capability: it can spawn REAL child
# sessions (their own transcript, model and UI) and talk to them. The lead is
# the team's manager and communication hub; it keeps the full coding tool set
# so it can prepare each teammate's environment (a worktree), review, test,
# merge — or do a step itself when delegating is not worth it. The prompt is
# generic: how a particular arrangement works (an untrusted provider, a
# parallel split) is loaded per task by the `/team-*` skills, not baked in.
#
# `agent-teams` is listed in `tools:` rather than `deferredTools:` so the team
# tools are EAGER. A deferred group only materialises after the model asks for
# it, and a lead needs them in its very first turn; a skill named in `tools:`
# loads eagerly (createAgentRuntime's third class).
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
  - agent-teams
deferredTools: [browser, a2ui]
---

## prompt

# `code`'s skeleton with the lead's own intro, tool block and voice. The

# leading contract (`!team_leading`) sits after the tool block: it is a

# statement about how to USE the team tools introduced there.

!team_intro
!system
!executing_with_care @standard
!team_using_your_tools
!team_leading
!tool_call_parallelism @standard
!pronouns
!executing_with_care @lean
!delivering_work
!autonomy
$skill_catalogs
$session_guidance
$environment
$memory

## begin

$skill_listing
