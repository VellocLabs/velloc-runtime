// The host tools of the `files` family as the model sees them: name,
// description, schema, flags — and the host action behind each one (F-21).
import type { HostToolDefinition } from './types'

export const FILES_HOST_TOOLS: readonly HostToolDefinition[] = [
  {
    "type": "function",
    "name": "Edit",
    "description": "Replaces one exact piece of text in a file with another.\n\nFor an existing file, each of these is checked and a failure is reported as an error:\n- The file must have been read with Read earlier in this conversation (any range will do) and must not have changed on disk since.\n- `old_string` must occur exactly once, unless `replace_all` is true, in which case every occurrence is replaced. If it occurs several times, widen it with surrounding lines until it is unique, or set `replace_all`.\n- `new_string` must differ from `old_string`.\n\nMatching is literal. Copy the text as it appears after the line-number prefix in Read output: the number and the tab are not part of the file. Whitespace and indentation must match exactly. Straight quotes in `old_string` also match curly quotes in the file, and the replacement then keeps the file's quote style. The file's encoding and line endings are preserved.\n\nOne exception: when the file does not exist and `old_string` is empty, the call creates the file with `new_string`; no prior Read is needed for that.\n\nConventions: change existing files rather than adding new ones unless a new file is required; `replace_all` is the right way to rename a symbol throughout a file; add emojis to a file only when the user asks for them.",
    "parameters": {
      "type": "object",
      "properties": {
        "file_path": {
          "type": "string",
          "description": "Absolute path of the file to change."
        },
        "old_string": {
          "type": "string",
          "description": "The exact text to find."
        },
        "new_string": {
          "type": "string",
          "description": "The text that replaces it; must not equal old_string."
        },
        "replace_all": {
          "type": "boolean",
          "description": "Replace every occurrence instead of requiring a single one. Default false."
        }
      },
      "required": [
        "file_path",
        "old_string",
        "new_string"
      ]
    },
    "concurrencySafe": false,
    "parametersStrict": {
      "type": "object",
      "properties": {
        "file_path": {
          "type": "string",
          "description": "Absolute path of the file to change."
        },
        "old_string": {
          "type": "string",
          "description": "The exact text to find."
        },
        "new_string": {
          "type": "string",
          "description": "The text that replaces it; must not equal old_string."
        },
        "replace_all": {
          "type": [
            "boolean",
            "null"
          ],
          "description": "Replace every occurrence instead of requiring a single one. Default false."
        }
      },
      "required": [
        "file_path",
        "old_string",
        "new_string",
        "replace_all"
      ],
      "additionalProperties": false
    },
    "host": {
      "capability": "files",
      "action": "edit"
    }
  },
  {
    "type": "function",
    "name": "Glob",
    "description": "Finds files by name pattern and returns their paths, most recently modified first. Works on repositories of any size.\n\n- `pattern` uses glob syntax: `**/*.ts`, `src/**/*.test.js`, `docs/*.md`.\n- `path` is the directory to search; leave it out to search the working directory. Never pass the strings \"null\" or \"undefined\" for it.\n- At most `limit` paths are returned, 100 unless set.\n\nWhen one pattern will not answer the question and several rounds of globbing and grepping lie ahead, hand the search to an Agent instead.",
    "parameters": {
      "type": "object",
      "properties": {
        "pattern": {
          "type": "string",
          "description": "Glob pattern to match file paths against."
        },
        "path": {
          "type": "string",
          "description": "Directory to search. Omit it for the working directory; if given, it must exist."
        },
        "limit": {
          "type": "integer",
          "description": "Maximum number of paths to return. Default 100."
        }
      },
      "required": [
        "pattern"
      ]
    },
    "concurrencySafe": true,
    "host": {
      "capability": "files",
      "action": "glob"
    }
  },
  {
    "type": "function",
    "name": "Grep",
    "description": "Searches file contents with ripgrep. Use it rather than running `grep` or `rg` in the shell: it carries the right permissions and its output is shaped for you.\n\n- `pattern` is a ripgrep regular expression (`fn\\s+\\w+`, `TODO|FIXME`). Ripgrep syntax differs from grep's: literal braces must be escaped, so `interface\\{\\}` finds `interface{}`.\n- Scope with `path` (a file or directory; the working directory by default), `glob` (`*.rs`, `*.{ts,tsx}`; several may be separated by commas or spaces) or `type` (a ripgrep file type: js, py, go, rust).\n- `output_mode` is `files_with_matches` (paths only, the default), `content` (the matching lines) or `count` (matches per file). Context (`-A`, `-B`, `-C`, `context`) and line numbers (`-n`, on by default) apply only in `content` mode.\n- Patterns match within one line unless `multiline` is true, which lets `.` cross newlines.\n- Results are capped at `head_limit` entries (250 by default; 0 removes the cap) after skipping `offset`; the result says when it was cut. File lists are newest first; paths are relative to the working directory.\n- Hidden files are searched; version-control directories are not.\n- When `path` is a single file and you set neither `output_mode` nor context, the defaults become `content` with five lines of context around each match, since the next step is nearly always reading that file. Anything you set explicitly is respected.\n\nFor an open-ended search that needs several passes, use an Agent.",
    "parameters": {
      "type": "object",
      "properties": {
        "pattern": {
          "type": "string",
          "description": "Regular expression, ripgrep syntax."
        },
        "path": {
          "type": "string",
          "description": "File or directory to search. The working directory unless set."
        },
        "glob": {
          "type": "string",
          "description": "Restrict to files matching this glob, such as \"*.ts\" or \"*.{ts,tsx}\"; several may be separated by commas or spaces. No filter unless set."
        },
        "output_mode": {
          "type": "string",
          "description": "\"files_with_matches\": paths only. \"content\": matching lines, with context and line numbers available. \"count\": matches per file. Unset (null counts as unset) means files_with_matches, except that a single-file path makes it content."
        },
        "-B": {
          "type": "integer",
          "description": "Lines of context before each match. content mode only."
        },
        "-A": {
          "type": "integer",
          "description": "Lines of context after each match. content mode only."
        },
        "-C": {
          "type": "integer",
          "description": "Lines of context on both sides of each match. content mode only."
        },
        "context": {
          "type": "integer",
          "description": "Same as -C and takes precedence over it."
        },
        "-n": {
          "type": "boolean",
          "description": "Prefix matching lines with their line numbers. content mode only; default true."
        },
        "-i": {
          "type": "boolean",
          "description": "Ignore case. Default false."
        },
        "type": {
          "type": "string",
          "description": "Restrict to a ripgrep file type such as js, py, rust or go. Cheaper than a glob for standard types. No filter unless set."
        },
        "head_limit": {
          "type": "integer",
          "description": "Return at most this many entries (lines, paths or count rows). Default 250; 0 means no cap, which can flood the context."
        },
        "offset": {
          "type": "integer",
          "description": "Skip this many entries before applying head_limit. Default 0."
        },
        "multiline": {
          "type": "boolean",
          "description": "Let patterns span lines and `.` match newlines. Default false."
        }
      },
      "required": [
        "pattern"
      ]
    },
    "concurrencySafe": true,
    "parametersStrict": {
      "type": "object",
      "properties": {
        "pattern": {
          "type": "string",
          "description": "Regular expression, ripgrep syntax."
        },
        "path": {
          "type": [
            "string",
            "null"
          ],
          "description": "File or directory to search. The working directory unless set. Use null to select the default."
        },
        "glob": {
          "type": [
            "string",
            "null"
          ],
          "description": "Restrict to files matching this glob, such as \"*.ts\" or \"*.{ts,tsx}\"; several may be separated by commas or spaces. No filter unless set. Use null when no glob filter is needed."
        },
        "output_mode": {
          "type": [
            "string",
            "null"
          ],
          "enum": [
            null,
            "files_with_matches",
            "content",
            "count"
          ],
          "description": "\"files_with_matches\": paths only. \"content\": matching lines, with context and line numbers available. \"count\": matches per file. Unset (null counts as unset) means files_with_matches, except that a single-file path makes it content. Use null to select the default."
        },
        "-B": {
          "type": [
            "integer",
            "null"
          ],
          "description": "Lines of context before each match. content mode only. Use null when not needed."
        },
        "-A": {
          "type": [
            "integer",
            "null"
          ],
          "description": "Lines of context after each match. content mode only. Use null when not needed."
        },
        "-C": {
          "type": [
            "integer",
            "null"
          ],
          "description": "Lines of context on both sides of each match. content mode only. Use null when not needed."
        },
        "context": {
          "type": [
            "integer",
            "null"
          ],
          "description": "Same as -C and takes precedence over it. Use null when not needed."
        },
        "-n": {
          "type": [
            "boolean",
            "null"
          ],
          "description": "Prefix matching lines with their line numbers. content mode only; default true. Use null to select the default."
        },
        "-i": {
          "type": [
            "boolean",
            "null"
          ],
          "description": "Ignore case. Default false. Use null to select the default."
        },
        "type": {
          "type": [
            "string",
            "null"
          ],
          "description": "Restrict to a ripgrep file type such as js, py, rust or go. Cheaper than a glob for standard types. No filter unless set. Use null when no type filter is needed."
        },
        "head_limit": {
          "type": [
            "integer",
            "null"
          ],
          "description": "Return at most this many entries (lines, paths or count rows). Default 250; 0 means no cap, which can flood the context. Use null to select the default."
        },
        "offset": {
          "type": [
            "integer",
            "null"
          ],
          "description": "Skip this many entries before applying head_limit. Default 0. Use null to select the default."
        },
        "multiline": {
          "type": [
            "boolean",
            "null"
          ],
          "description": "Let patterns span lines and `.` match newlines. Default false. Use null to select the default."
        }
      },
      "required": [
        "pattern",
        "path",
        "glob",
        "output_mode",
        "-B",
        "-A",
        "-C",
        "context",
        "-n",
        "-i",
        "type",
        "head_limit",
        "offset",
        "multiline"
      ],
      "additionalProperties": false
    },
    "host": {
      "capability": "files",
      "action": "grep"
    }
  },
  {
    "type": "function",
    "name": "Read",
    "description": "Returns the contents of one file on the user's machine.\n\n- `file_path` should be absolute; a relative path is resolved against the working directory. Pass a path the user gives you, a screenshot or a temporary file included, without checking that it exists: a missing file simply returns an error.\n- Text comes back one line per row as `<line number><TAB><text>`, numbered from 1. Small and medium files are best read whole. Oversized reads are rejected rather than cut short: a file over 256 KiB, or a result over roughly 25,000 tokens, fails unless you narrow it with `offset` (the first line, counting from 1) and `limit` (how many lines).\n- Images (png, jpg, gif, webp) are shown to you as images. PDFs need `pages` once they exceed 10 pages, and at most 20 pages come back per call. Jupyter notebooks (.ipynb) return every cell with its outputs.\n- Directories are not readable here; list them with the shell tool.\n- An empty file returns a reminder saying so instead of content. Reading the same range of a file again while the file is unchanged returns a short note pointing at the earlier result instead of the content; a different range or different pages is read normally.",
    "parameters": {
      "type": "object",
      "properties": {
        "file_path": {
          "type": "string",
          "description": "Path of the file. Prefer an absolute path; a relative path resolves against the working directory."
        },
        "offset": {
          "type": "integer",
          "description": "First line to return, counting from 1. Only for files too large to read whole."
        },
        "limit": {
          "type": "integer",
          "description": "How many lines to return, starting at offset. Only for files too large to read whole."
        },
        "pages": {
          "type": "string",
          "description": "PDF only: the pages to return, such as \"3\" or \"1-5\". Required above 10 pages; at most 20 pages per call."
        }
      },
      "required": [
        "file_path"
      ]
    },
    "concurrencySafe": true,
    "parametersStrict": {
      "type": "object",
      "properties": {
        "file_path": {
          "type": "string",
          "description": "Path of the file. Prefer an absolute path; a relative path resolves against the working directory."
        },
        "offset": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 0,
          "description": "First line to return, counting from 1. Only for files too large to read whole."
        },
        "limit": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 1,
          "description": "How many lines to return, starting at offset. Only for files too large to read whole."
        },
        "pages": {
          "type": [
            "string",
            "null"
          ],
          "description": "PDF only: the pages to return, such as \"3\" or \"1-5\". Required above 10 pages; at most 20 pages per call."
        }
      },
      "required": [
        "file_path",
        "offset",
        "limit",
        "pages"
      ],
      "additionalProperties": false
    },
    "host": {
      "capability": "files",
      "action": "read"
    }
  },
  {
    "type": "function",
    "name": "Write",
    "description": "Creates a file or replaces its whole contents.\n\n- `file_path` must be absolute; network (UNC) paths are refused. Missing parent directories are created.\n- A file that already exists must have been read with Read in this conversation and must be unchanged on disk since, or the call fails. A new file needs no prior Read.\n- Line endings are written as LF. The result names the path and the number of bytes written; treat that as confirmation and do not write again.\n\nUse Edit for changes to an existing file; this tool is for new files and complete rewrites. Do not create documentation or README files unless the user asked for them, and add emojis only on request.",
    "parameters": {
      "type": "object",
      "properties": {
        "file_path": {
          "type": "string",
          "description": "Absolute path of the file to create or overwrite."
        },
        "content": {
          "type": "string",
          "description": "The complete new contents."
        }
      },
      "required": [
        "file_path",
        "content"
      ]
    },
    "concurrencySafe": false,
    "parametersStrict": {
      "type": "object",
      "properties": {
        "file_path": {
          "type": "string",
          "description": "Absolute path of the file to create or overwrite."
        },
        "content": {
          "type": "string",
          "description": "The complete new contents."
        }
      },
      "required": [
        "file_path",
        "content"
      ],
      "additionalProperties": false
    },
    "host": {
      "capability": "files",
      "action": "write"
    }
  }
]
