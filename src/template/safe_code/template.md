---
type: safe_code
description: SafeCode (experimental) — inspect and modify code without executing it. Read-only tools to explore, SuperEdit to change files. No shell, no interpreter, no commands.
# Launcher name/title/icon for this type live in `src/template/index.md` (UI
# display name: SafeCode; serialized type id: safe_code).
#
# SafeCode is an EXPERIMENTAL, NON-EXECUTING coding session. Its whole
# definition is one boundary: it may READ the workspace and it may WRITE the
# workspace, and it may do nothing else. There is no third lane.
#
#   Inspect → model-visible read tools (Read/Glob/Grep) — observe and reason.
#   Modify  → `SuperEdit` — the ONLY filesystem mutation surface: a sandboxed
#             Worker whose `workspace` facade is permission-gated per path
#             (tools/SuperEditTool.ts).
#
# Everything that can RUN something is left out of the runtime tool set
# entirely, not hidden behind a gate:
#   - no `shell` (Bash/PowerShell) and no `exec`. Because neither group is
#     named here — not in `tools:`, not in `deferredTools:`, not in
#     `sealedTools:` — the template allowlist DROPS those tools while the
#     runtime is built, so they never enter `options.tools`. That is the point:
#     the boundary is STRUCTURAL, evaluated once at construction, with nothing
#     to un-hide and nothing to activate. A hidden-but-registered tool would
#     instead depend on the per-turn deferral gate
#     (`services/tools/deferredTools.ts`). That registry is now keyed
#     per-runtime (a sibling session can no longer replace it), but a gate is
#     still the weaker tier: a security boundary should not hinge on every
#     per-turn read passing the right key. Absence beats hiding.
#   - no `webfetch` (WebFetch) — SafeCode works on the workspace, not the network.
#   - no `skills` (Skill/ToolSearch) — ToolSearch exists to bring hidden tools
#     online; with nothing left to bring online it is only a way back in. The
#     user's `/name` slash surface reads the command list directly and is
#     unaffected.
#   - no `subagent` — a sub-agent carries its own template and would be a way
#     around this one.
#   - no MCP tools — see `noExecution` below.
# The `edit` group is intentionally NOT registered either: general file mutation
# belongs to SuperEdit's workspace facade, which gates through the same filesystem
# permission pipeline without needing the Write/Edit tools present.
tools:
  - read
  - plan
  - superedit
# MCP tools BYPASS the `tools:` allowlist — createAgentRuntime appends them to
# the tool set after the allowlist has been applied — and a native (stdio) MCP
# server spawns OS processes, so an allowlist alone cannot hold the "never
# execute" line. `noExecution` is the declared capability flag that closes it:
# createAgentRuntime registers no MCP server skills and adds no MCP tools, MCP
# resource tools, or `Skill('mcp__<server>')` commands for such a session. That
# is its ONLY effect — see constants/templateParsing.ts (the flag) and
# constants/templateRegistry.ts (`templateAllowsMcp`).
#
# It deliberately does NOT restrict `SuperEdit`. Both of its inputs stay available
# here: `code` and `path` are two ways to supply the same script, and the script
# runs in the same hardened worker realm either way — no network, no process,
# no nested worker, and the permission-gated `workspace` facade as its only I/O.
# `path` chooses where the bytes come from; it is not an execution capability.
noExecution: true
# SafeCode has no shell and therefore no git — so the platform records the
# safety net itself: per-turn before/after snapshots of every file the session
# mutates, stored inside the session's own directory (deleted with it). This
# flag builds the session's FileSnapshotRecorder (fed by SuperEdit's workspace
# facade) and appends the read-only `WorkspaceDiff` tool — the model's
# "git diff" replacement for reviewing its own changes. See
# services/fileSnapshots/ and `templateWantsFileSnapshots`
# (constants/templateRegistry.ts) — the tool is appended there, not listed in
# `tools:`, so no other type carries a dead tool.
fileSnapshots: true
# Per-type SKILL allowlist (`all` by default). SafeCode names the empty list:
# it may use NO skill. This is belt-and-braces on purpose — the type also omits
# the `skills` group, so the Skill tool never enters its runtime set and the
# model has no way to invoke one. The declaration is what makes the boundary
# READABLE (and what a future `tools:` edit cannot silently widen): a skill body
# may carry `!`cmd`` shell expansion, which is exactly the execution this type
# exists to exclude. Ids are `<source>:<name>`; see `src/template/README.md`.
skills: []
---

## prompt

!safe_code_intro
!safe_code_using_your_tools
!tool_call_parallelism
!delivering_work
!autonomy
$environment
$memory

## begin
