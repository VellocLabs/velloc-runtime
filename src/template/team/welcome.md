---
# Welcome page for the `team` type — shown on a new (empty) team session.
#
# Both chips load a SLASH COMMAND into the composer, trailing space included,
# so the user types the task straight after it. The commands are bundled
# team-only skills (`skills/bundled/safeTeam.ts`, `arenaTeam.ts`) whose body
# is generated at click time from the user's actual provider settings — which
# is why the guidance is not baked into the system prompt: it has to name the
# providers this user really has.
greeting: What kind of team do you want to run?
suggestions:
  - title: Safe Team
    description: Untrusted AI teammates do the development; a trusted lead coordinates, checks security, and controls execution and integration.
    prompt: "/safe-team "
  - title: Model Arena
    description: Give several trusted models the same task, then adopt or combine the best result.
    prompt: "/arena-team "
---
