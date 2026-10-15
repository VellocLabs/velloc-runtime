---
# Launcher catalog — the agent types shown in the sidebar.
#
# The web reads ONLY this file to render the type list (name + title + icon).
# Each type's heavy config (system prompt, tools) lives in `<type>/template.md`
# and is loaded when that type is used. See README.md for the full reference.
#
# Per entry:
#   type         the type id (= the `<type>/` folder)
#   title        launcher label (literal fallback)
#   title-i18n   i18n key (FIRST choice; key in browser/webview/i18n/messages/*)
#   icon_lucide  a lucide-react icon name (else `icon:` a path / https URL)
#   icon         an explicit image path / https URL → <img> (overrides icon_lucide)
#   launcherHidden  `both` = not offered in the sidebar OR the project menu
#                unless the UI unhides it; `sidebar` = sidebar only (the
#                project menu still offers it). Default offered on both.
#   launcherMenu  `false` = not offered in the project folder menu (sidebar
#                launcher unaffected). Default offered.
#
# Beta: `index-beta.md` next to this file is the WHOLE catalog on the beta
# channel (beta.velloc.app, or `?channel=beta` on a dev server) — this file is
# not read there. To change what beta offers, edit that file; keep the two in
# step for everything that should look the same on both. Likewise a type's
# `template-beta.md` replaces its `template.md` on beta. See README.md.
#
# Order here = the launcher order.
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
  # Capability-controlled coding agent: read tools to observe, `SuperEdit`
  # to mutate, `exec` for approved commands — no general shell or interpreter.
  # `launcherHidden: both` — never offered as a launcher; it exists for
  # derived sessions (an untrusted team child) and `?templateType=` only.
  # Kept LAST so it trails the stable types. UI display: SafeCode; serialized
  # id: safe_code.
  - type: safe_code
    title: SafeCode
    title-i18n: launcher.safeCode
    icon_lucide: shield-check
    launcherHidden: both
---

# Template catalog

The `types` list above is the sidebar launcher catalog (name + title + icon) —
the only file the web needs to show the available session types. Each type's
prompt + tool configuration lives in `<type>/template.md`; see `README.md`.
