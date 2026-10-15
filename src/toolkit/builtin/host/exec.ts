// The host tools of the `exec` family as the model sees them: name,
// description, schema, flags — and the host action behind each one (F-21).
import type { HostToolDefinition } from './types'

export const EXEC_HOST_TOOLS: readonly HostToolDefinition[] = [
  {
    "type": "function",
    "name": "Bash",
    "description": "Runs one bash command line through the host shell and returns what it printed.\n\nWhat persists and what does not:\n- The working directory carries over from call to call, including a `cd` you issue; nothing else does. Variables, functions and aliases vanish with the process, which starts from the user's shell profile each time.\n- stdout and stderr come back merged. Empty output is reported as `(no output)`. Output beyond 30,000 characters keeps only the tail and says so.\n- Exit code 1 is not treated as failure for `grep`, `rg`, `diff`, `test` and `find`, because they use it to report a condition: `grep` and `rg` found nothing, `diff` found differences, `test` was false, and `find` could not enter some directories (its results are then incomplete, so read its error lines). Any other non-zero exit is an error result that still carries the output.\n\nReach for the dedicated tools first. Read, Edit, Write, Glob and Grep show the user a reviewable, permission-scoped action; the same work done through `cat`, `sed`, `find` or `grep` is opaque to them. Keep this tool for what only a shell can do: builds, tests, package managers, git, scripts, process control. Talk to the user in your reply, not with `echo`.\n\nTiming:\n- `timeout` is in milliseconds, 120000 unless set, 600000 at most. A command still running when it elapses is not killed: it is moved to the background and you are told its shell id.\n- `run_in_background: true` returns a shell id at once, and a notification arrives when the command finishes. Do not append `&`, and do not poll for the result.\n- A command line that opens with `sleep` of two seconds or more is refused. Wait with background execution or a single check command, never with a sleep loop. A sleep of one second or less for pacing is fine.\n\nComposing commands:\n- Put independent commands in separate tool calls within the same reply so they run together. Chain dependent commands in one call with `&&`; use `;` only when a failure earlier in the line should not stop the rest. Do not separate commands with newlines, except inside quoted strings.\n- Quote any path that contains spaces. Prefer absolute paths so you do not depend on the current directory; change directory only when the user asks for it.\n- Before creating files in a directory, make sure the directory exists and is the one you mean.\n\nGit:\n- Make a new commit rather than amending one.\n- Operations that discard work (`git reset --hard`, `git push --force`, `git checkout -- <file>`, `git clean`) need a reason that a safer command cannot satisfy.\n- Hooks and commit signing are not to be bypassed (`--no-verify`, `--no-gpg-sign`, `-c commit.gpgsign=false`) unless the user says so. A failing hook is a problem to fix, not to skip.",
    "parameters": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string",
          "description": "The bash command line to run."
        },
        "timeout": {
          "type": "integer",
          "description": "Milliseconds to wait before the command is moved to the background. 120000 unless set, 600000 at most."
        },
        "description": {
          "type": "string",
          "description": "A short, active-voice account of what the command does, written for the user, who may read it without seeing the command itself. Say what happens, not which flags do it.\n\nPlain git, npm or CLI calls need five to ten words:\n- git log --oneline -5 → \"Show the last five commits\"\n- npm test → \"Run the test suite\"\n- rm -r build → \"Delete the build directory\"\n\nA pipeline or an unusual flag needs enough context to be understood at a glance:\n- git diff --stat main | tail -1 → \"Summarise how much the branch differs from main\"\n- tar -xzf release.tgz -C out → \"Unpack the release archive into out\"\n- git rebase --onto main base topic → \"Replay the topic branch onto main\"\n"
        },
        "run_in_background": {
          "type": "boolean",
          "description": "Start the command and return its shell id immediately; a notification reports completion. Do not poll in the meantime."
        }
      },
      "required": [
        "command"
      ]
    },
    "concurrencySafe": false,
    "parametersStrict": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string",
          "description": "The bash command line to run."
        },
        "timeout": {
          "type": [
            "integer",
            "null"
          ],
          "description": "Milliseconds to wait before the command is moved to the background. 120000 unless set, 600000 at most."
        },
        "description": {
          "type": [
            "string",
            "null"
          ],
          "description": "A short, active-voice account of what the command does, written for the user, who may read it without seeing the command itself. Say what happens, not which flags do it.\n\nPlain git, npm or CLI calls need five to ten words:\n- git log --oneline -5 → \"Show the last five commits\"\n- npm test → \"Run the test suite\"\n- rm -r build → \"Delete the build directory\"\n\nA pipeline or an unusual flag needs enough context to be understood at a glance:\n- git diff --stat main | tail -1 → \"Summarise how much the branch differs from main\"\n- tar -xzf release.tgz -C out → \"Unpack the release archive into out\"\n- git rebase --onto main base topic → \"Replay the topic branch onto main\"\n"
        },
        "run_in_background": {
          "type": [
            "boolean",
            "null"
          ],
          "description": "Start the command and return its shell id immediately; a notification reports completion. Do not poll in the meantime."
        }
      },
      "required": [
        "command",
        "timeout",
        "description",
        "run_in_background"
      ],
      "additionalProperties": false
    },
    "host": {
      "capability": "exec",
      "action": "bash"
    }
  },
  {
    "type": "function",
    "name": "PowerShell",
    "description": "Runs one PowerShell command line and returns what it printed.\n\nEach call is a fresh `pwsh -NoProfile -NonInteractive` process (falling back to `powershell.exe` when pwsh is not installed), started in the session's working directory. Variables, functions and a `Set-Location` do not survive into the next call. stdout and stderr come back merged; empty output is `(no output)`; output beyond 30,000 characters keeps only the tail. Any non-zero exit is reported as an error together with the output, including tools such as `robocopy` that use non-zero codes informatively.\n\nUse Read, Edit, Write, Glob and Grep for files: they are reviewable and permission-scoped. Keep this tool for what needs a Windows shell: builds, installers, services, the registry, scheduled tasks, Windows-only command-line tools.\n\nWriting the command:\n- PowerShell syntax, not bash: `Get-ChildItem`, `Remove-Item`, `Select-String`, `Where-Object`, `ForEach-Object`. The pipeline carries objects, so `awk` and `sed` idioms do not apply.\n- Environment variables are `$env:NAME`; set one for a command with `$env:NAME = 'value'; <command>`.\n- Quote paths that contain spaces, with single or double quotes. Prefer absolute paths; change directory only when the user asks.\n- Independent commands go in separate tool calls within one reply; dependent ones are chained in a single call with `;`.\n\nTiming:\n- `timeout` is in milliseconds, 120000 unless set, 600000 at most. When it elapses the command is moved to the background rather than killed, and you are given its shell id.\n- `run_in_background: true` returns a shell id immediately; a notification arrives when the command finishes. Do not poll.\n- A command line that opens with `Start-Sleep` (or `sleep`) of two seconds or more is refused. Wait with background execution or one check command, not a sleep loop; use `-Milliseconds` for brief pacing.\n\nGit: new commits over amendments; commands that discard work (`git reset --hard`, `git push --force`) only when the user asks for them; hooks and signing are never bypassed unless the user says so.",
    "parameters": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string",
          "description": "The PowerShell command line to run."
        },
        "timeout": {
          "type": "integer",
          "description": "Milliseconds to wait before the command is moved to the background. 120000 unless set, 600000 at most."
        },
        "description": {
          "type": "string",
          "description": "A short, active-voice account of what the command does, written for the user, who may read it without seeing the command itself. Say what happens, not which cmdlets do it."
        },
        "run_in_background": {
          "type": "boolean",
          "description": "Start the command and return its shell id immediately; a notification reports completion. Do not poll in the meantime."
        }
      },
      "required": [
        "command"
      ]
    },
    "concurrencySafe": false,
    "parametersStrict": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string",
          "description": "The PowerShell command line to run."
        },
        "timeout": {
          "type": [
            "integer",
            "null"
          ],
          "description": "Milliseconds to wait before the command is moved to the background. 120000 unless set, 600000 at most."
        },
        "description": {
          "type": [
            "string",
            "null"
          ],
          "description": "A short, active-voice account of what the command does, written for the user, who may read it without seeing the command itself. Say what happens, not which cmdlets do it."
        },
        "run_in_background": {
          "type": [
            "boolean",
            "null"
          ],
          "description": "Start the command and return its shell id immediately; a notification reports completion. Do not poll in the meantime."
        }
      },
      "required": [
        "command",
        "timeout",
        "description",
        "run_in_background"
      ],
      "additionalProperties": false
    },
    "host": {
      "capability": "exec",
      "action": "powerShell"
    }
  }
]
