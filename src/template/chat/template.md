---
type: chat
description: Conversation — web + chat + skills + memory; no access to the user's local files or shell; browser/UI deferred (activate on demand); no planning or scheduling.
# Launcher name/title/icon for this type live in `src/template/index.md`.
# A light conversational type. EAGER groups (tools:): read = Read/Glob/Grep,
# edit = Write/Edit/NotebookEdit, webfetch = WebFetch, ask = AskUserQuestion,
# codehandoff = ContinueInCode, skills = Skill/ToolSearch, misc = Sleep.
# EXCLUDED by omission: subagent, plan, todo, schedule, shell.
# Security: in a chat session the file tools are confined by the chat
# local-access gate — read and write inside the memory dir, read-only inside
# loaded skill roots and the session's uploads dir, denied everywhere else.
tools:
  - read
  - edit
  - webfetch
  - ask
  - codehandoff
  - skills
  - misc
# DEFERRED (deferredTools:) — loaded but hidden until Skill()/ToolSearch: the
# browser / a2ui SKILLS. A GROUP or a SKILL can be deferred here.
deferredTools: [browser, a2ui]
---

## prompt

# legend: !holder | $dynamic | literal. `$environment`/`$memory` are

# appended downstream in v1.

# CHAT diverges from the shared browser-agent voice into a warm, conversational

# assistant (gpt5-style). Type-specific holders carry a `chat_` prefix → a

# globally-UNIQUE registry name, so they can't collide with (or shadow) the

# shared `intro`/`tone_and_style` in the type-blind C++ PromptHolderRegistry:

# !chat_intro          = conversational identity + data-not-instructions

# !system              = the SHARED harness block — `# How this session works` under the

# standard profile, `# Harness` under lean

# !chat_answering_well = the `# Answering well` rules


# !chat_tone_and_style = conversational tone + output efficiency

# `final_reminder` is dropped (browser-navigation-flavored; the data-not-

# instructions security note lives in chat_intro). `chat_using_your_tools` is

# this type's own tool-usage block (no longer host-rendered): file tools +

# skills + parallelism. No TodoWrite (the `todo` group is omitted) and no

# browser catalog (browser DEFERS here — the skill carries its own

# instructions when it activates).

!chat_intro
!system
!chat_answering_well
!chat_using_your_tools
!tool_call_parallelism @standard
$skill_catalogs
$session_guidance
!chat_tone_and_style
$environment
$memory

## begin

$skill_listing
