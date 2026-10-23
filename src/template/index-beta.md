---
# Launcher catalog on the BETA channel — beta.velloc.app, or a dev server
# opened with `?channel=beta`.
#
# This file REPLACES `index.md` there; it is not merged with it. So it is the
# complete list, in launcher order, with the same per-entry keys (documented at
# the top of `index.md` and in README.md). To try a launcher change on beta
# first, change it here; to ship it, make `index.md` match.
#
# Differences from `index.md` today:
#   team   listed here only — still soaking, so stable's catalog has no entry
#          for it (a team session opened on stable shows the Agent icon and
#          title; `?templateType=team` still works there).
#   cli-claude, cli-codex
#          CLI session types (F-34), beta only. `kind: terminal` = the session
#          is a terminal running the host CLI named by `cli`; no `<type>/`
#          folder. Hidden until the CLI session view lands.
types:
  - type: code
    title: Code
    title-i18n: launcher.code
    icon_lucide: code
  - type: agent
    title: Agent
    title-i18n: launcher.agent
    icon_lucide: bot
  - type: chat
    title: Chat
    title-i18n: launcher.chat
    icon_lucide: message-circle
  - type: team
    title: Team
    title-i18n: launcher.team
    icon_lucide: users
  - type: safe_code
    title: SafeCode
    title-i18n: launcher.safeCode
    icon_lucide: shield-check
    launcherHidden: both
  - type: cli-claude
    title: Claude Code CLI
    kind: terminal
    cli: claude
    icon_lucide: square-terminal
    launcherHidden: both
  - type: cli-codex
    title: Codex CLI
    kind: terminal
    cli: codex
    icon_lucide: square-terminal
    launcherHidden: both
---

# Template catalog — beta

The beta channel's launcher catalog. See `index.md` and `README.md`.
