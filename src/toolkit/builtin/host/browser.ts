// The host tools of the `browser` family as the model sees them: name,
// description, schema, flags — and the host action behind each one. Moved
// verbatim from the host's tool declarations; the text is model-facing
// and is rewritten in phase 1 of the copyright plan, not here.
import type { HostToolDefinition } from './types'

export const BROWSER_HOST_TOOLS: readonly HostToolDefinition[] = [
  {
    "type": "function",
    "name": "BrowserActivateTab",
    "description": "Foreground (activate) a specific tab so subsequent observations and actions target it. Use to switch focus across the tabs you can see in the latest observation.",
    "parameters": {
      "type": "object",
      "properties": {
        "evaluation_previous_goal": {
          "type": "string",
          "description": "Required one-sentence judgement of whether the previous turn's `next_goal` was achieved, partially achieved, or failed, citing concrete evidence from the latest observation (e.g. \"Login form submitted; landing page now shows the user's name\"). On the first turn, state that there is no prior goal yet."
        },
        "memory": {
          "type": "string",
          "description": "Required running scratchpad of facts and decisions worth carrying forward across turns (URLs visited, search terms tried, IDs found, dead ends ruled out, sub-results collected). Append to and prune what you wrote last turn; don't re-derive it from scratch."
        },
        "next_goal": {
          "type": "string",
          "description": "Required single concrete intent this call is meant to accomplish, phrased so the next turn's `evaluation_previous_goal` can check it. One sentence, action-shaped (e.g. \"Open the first organic result and read the article body\")."
        },
        "tab_id": {
          "type": "integer",
          "description": "Required tab id to bring to the foreground. Pick from the tab_ids visible in the most recent observation."
        }
      },
      "required": [
        "evaluation_previous_goal",
        "memory",
        "next_goal",
        "tab_id"
      ]
    },
    "skill": "browser",
    "concurrencySafe": false,
    "inputExamples": [
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Switch to the checkout tab to read the order total",
        "tab_id": 7
      }
    ],
    "host": {
      "capability": "browser",
      "action": "activateTab"
    }
  },
  {
    "type": "function",
    "name": "BrowserBack",
    "description": "Move the active tab one step backward in its history. Use after a navigation that didn't surface the content you wanted. Returns a fresh observation of the previous page.",
    "parameters": {
      "type": "object",
      "properties": {
        "evaluation_previous_goal": {
          "type": "string",
          "description": "Required one-sentence judgement of whether the previous turn's `next_goal` was achieved, partially achieved, or failed, citing concrete evidence from the latest observation (e.g. \"Login form submitted; landing page now shows the user's name\"). On the first turn, state that there is no prior goal yet."
        },
        "memory": {
          "type": "string",
          "description": "Required running scratchpad of facts and decisions worth carrying forward across turns (URLs visited, search terms tried, IDs found, dead ends ruled out, sub-results collected). Append to and prune what you wrote last turn; don't re-derive it from scratch."
        },
        "next_goal": {
          "type": "string",
          "description": "Required single concrete intent this call is meant to accomplish, phrased so the next turn's `evaluation_previous_goal` can check it. One sentence, action-shaped (e.g. \"Open the first organic result and read the article body\")."
        }
      },
      "required": [
        "evaluation_previous_goal",
        "memory",
        "next_goal"
      ]
    },
    "skill": "browser",
    "concurrencySafe": false,
    "inputExamples": [
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Return to the search results and pick another result"
      }
    ],
    "host": {
      "capability": "browser",
      "action": "back"
    }
  },
  {
    "type": "function",
    "name": "BrowserClick",
    "description": "Click an element on the active tab by its observation index. The index must come from the most recent observation's `elements[]` (or via `BrowserFindText` / `BrowserReadElement`). Always left-button single-click; for context menus or other button semantics use dedicated tools when available.",
    "parameters": {
      "type": "object",
      "properties": {
        "evaluation_previous_goal": {
          "type": "string",
          "description": "Required one-sentence judgement of whether the previous turn's `next_goal` was achieved, partially achieved, or failed, citing concrete evidence from the latest observation (e.g. \"Login form submitted; landing page now shows the user's name\"). On the first turn, state that there is no prior goal yet."
        },
        "memory": {
          "type": "string",
          "description": "Required running scratchpad of facts and decisions worth carrying forward across turns (URLs visited, search terms tried, IDs found, dead ends ruled out, sub-results collected). Append to and prune what you wrote last turn; don't re-derive it from scratch."
        },
        "next_goal": {
          "type": "string",
          "description": "Required single concrete intent this call is meant to accomplish, phrased so the next turn's `evaluation_previous_goal` can check it. One sentence, action-shaped (e.g. \"Open the first organic result and read the article body\")."
        },
        "index": {
          "type": "integer",
          "description": "Required element index from the latest observation's elements[] list."
        }
      },
      "required": [
        "evaluation_previous_goal",
        "memory",
        "next_goal",
        "index"
      ]
    },
    "skill": "browser",
    "concurrencySafe": false,
    "inputExamples": [
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Open the first organic result",
        "index": 12
      }
    ],
    "host": {
      "capability": "browser",
      "action": "click"
    }
  },
  {
    "type": "function",
    "name": "BrowserCloseTab",
    "description": "Close a browser tab. Defaults to the currently active tab when tab_id is omitted. Use when a popup, modal-style overlay, or a side-tab is no longer relevant to the task.",
    "parameters": {
      "type": "object",
      "properties": {
        "evaluation_previous_goal": {
          "type": "string",
          "description": "Required one-sentence judgement of whether the previous turn's `next_goal` was achieved, partially achieved, or failed, citing concrete evidence from the latest observation (e.g. \"Login form submitted; landing page now shows the user's name\"). On the first turn, state that there is no prior goal yet."
        },
        "memory": {
          "type": "string",
          "description": "Required running scratchpad of facts and decisions worth carrying forward across turns (URLs visited, search terms tried, IDs found, dead ends ruled out, sub-results collected). Append to and prune what you wrote last turn; don't re-derive it from scratch."
        },
        "next_goal": {
          "type": "string",
          "description": "Required single concrete intent this call is meant to accomplish, phrased so the next turn's `evaluation_previous_goal` can check it. One sentence, action-shaped (e.g. \"Open the first organic result and read the article body\")."
        },
        "tab_id": {
          "type": "integer",
          "description": "Optional tab id; defaults to the currently active tab. Pass an explicit tab_id when closing a background tab (e.g. dismissing a popup that opened without focus stealing)."
        }
      },
      "required": [
        "evaluation_previous_goal",
        "memory",
        "next_goal"
      ]
    },
    "skill": "browser",
    "concurrencySafe": false,
    "inputExamples": [
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Close the finished article tab"
      },
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Close the stale login tab",
        "tab_id": 7
      }
    ],
    "host": {
      "capability": "browser",
      "action": "closeTab"
    }
  },
  {
    "type": "function",
    "name": "Done",
    "description": "Finish the task and return a summary to the user. Setting `success: true` marks the task as completed; `false` marks it as aborted (e.g. blocked by a paywall, login wall, or unrecoverable error). The text is shown verbatim to the user — keep it one sentence and concrete (the answer, not 'I clicked some things').",
    "parameters": {
      "type": "object",
      "properties": {
        "evaluation_previous_goal": {
          "type": "string",
          "description": "Required one-sentence judgement of whether the previous turn's `next_goal` was achieved, partially achieved, or failed, citing concrete evidence from the latest observation (e.g. \"Login form submitted; landing page now shows the user's name\"). On the first turn, state that there is no prior goal yet."
        },
        "memory": {
          "type": "string",
          "description": "Required running scratchpad of facts and decisions worth carrying forward across turns (URLs visited, search terms tried, IDs found, dead ends ruled out, sub-results collected). Append to and prune what you wrote last turn; don't re-derive it from scratch."
        },
        "next_goal": {
          "type": "string",
          "description": "Required single concrete intent this call is meant to accomplish, phrased so the next turn's `evaluation_previous_goal` can check it. One sentence, action-shaped (e.g. \"Open the first organic result and read the article body\")."
        },
        "success": {
          "type": "boolean",
          "description": "True if the task completed successfully; false if it had to be abandoned."
        },
        "text": {
          "type": "string",
          "description": "Required one-sentence answer or status. Shown verbatim to the user."
        }
      },
      "required": [
        "evaluation_previous_goal",
        "memory",
        "next_goal",
        "success",
        "text"
      ]
    },
    "skill": "browser",
    "concurrencySafe": false,
    "inputExamples": [
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Report the answer to the user",
        "success": true,
        "text": "Found X: <one-sentence answer with the concrete result>."
      },
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Report why the task cannot be completed",
        "success": false,
        "text": "Couldn't sign in — login form requires a 2FA code I don't have access to."
      }
    ],
    "host": {
      "capability": "browser",
      "action": "done"
    }
  },
  {
    "type": "function",
    "name": "BrowserDownload",
    "description": "Download a file into the local workspace. Two modes — pass EXACTLY ONE of `index` or `url`:\n- `index`: click an element that triggers a download. Use this when you can't get a direct URL — e.g. a button/link whose download is JS-driven, a `blob:` URL, a form-POST download, or a `Content-Disposition: attachment` response. The host captures whatever download the click produces.\n- `url`: download a direct URL using the current page's session (cookies/auth apply), for when you already have a stable file URL.\nThe file is saved under the workspace `downloads/` folder and the returned `path` can be read with the file tools (Read/Glob). For very large files the call returns as soon as the transfer is underway with `status: \"downloading\"` plus byte progress — the file finishes streaming in the background, so re-check the path a bit later rather than re-issuing the download.",
    "parameters": {
      "type": "object",
      "properties": {
        "evaluation_previous_goal": {
          "type": "string",
          "description": "Required one-sentence judgement of whether the previous turn's `next_goal` was achieved, partially achieved, or failed, citing concrete evidence from the latest observation (e.g. \"Login form submitted; landing page now shows the user's name\"). On the first turn, state that there is no prior goal yet."
        },
        "memory": {
          "type": "string",
          "description": "Required running scratchpad of facts and decisions worth carrying forward across turns (URLs visited, search terms tried, IDs found, dead ends ruled out, sub-results collected). Append to and prune what you wrote last turn; don't re-derive it from scratch."
        },
        "next_goal": {
          "type": "string",
          "description": "Required single concrete intent this call is meant to accomplish, phrased so the next turn's `evaluation_previous_goal` can check it. One sentence, action-shaped (e.g. \"Open the first organic result and read the article body\")."
        },
        "index": {
          "type": "integer",
          "description": "Element index (from the latest observation's elements[]) to click in order to trigger a download. Use for downloads whose URL you can't obtain directly. Provide exactly one of index or url."
        },
        "url": {
          "type": "string",
          "description": "Absolute URL of a file to download directly (uses the current page's cookies/session). Provide exactly one of index or url."
        },
        "filename": {
          "type": "string",
          "description": "Optional filename to save as (basename only, no directories). Defaults to the server-suggested name or the URL's last path segment."
        }
      },
      "required": [
        "evaluation_previous_goal",
        "memory",
        "next_goal"
      ]
    },
    "skill": "browser",
    "concurrencySafe": false,
    "inputExamples": [
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Download the report linked on this page",
        "index": 42
      },
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Download the Q1 report PDF",
        "url": "https://example.com/reports/q1-2026.pdf"
      },
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Save the invoice as invoice.pdf",
        "index": 18,
        "filename": "invoice.pdf"
      }
    ],
    "host": {
      "capability": "browser",
      "action": "download"
    }
  },
  {
    "type": "function",
    "name": "BrowserDragAndDrop",
    "description": "Press the mouse on `from_index`, drag, and release on `to_index` on the active tab. Both elements must be on the same (active) tab. Use for reordering lists, drag-style sliders, kanban-board moves, or any UI that listens for drag events instead of clicks.",
    "parameters": {
      "type": "object",
      "properties": {
        "evaluation_previous_goal": {
          "type": "string",
          "description": "Required one-sentence judgement of whether the previous turn's `next_goal` was achieved, partially achieved, or failed, citing concrete evidence from the latest observation (e.g. \"Login form submitted; landing page now shows the user's name\"). On the first turn, state that there is no prior goal yet."
        },
        "memory": {
          "type": "string",
          "description": "Required running scratchpad of facts and decisions worth carrying forward across turns (URLs visited, search terms tried, IDs found, dead ends ruled out, sub-results collected). Append to and prune what you wrote last turn; don't re-derive it from scratch."
        },
        "next_goal": {
          "type": "string",
          "description": "Required single concrete intent this call is meant to accomplish, phrased so the next turn's `evaluation_previous_goal` can check it. One sentence, action-shaped (e.g. \"Open the first organic result and read the article body\")."
        },
        "from_index": {
          "type": "integer",
          "description": "Required source element index (where the drag starts)."
        },
        "to_index": {
          "type": "integer",
          "description": "Required destination element index (where the drag ends)."
        }
      },
      "required": [
        "evaluation_previous_goal",
        "memory",
        "next_goal",
        "from_index",
        "to_index"
      ]
    },
    "skill": "browser",
    "concurrencySafe": false,
    "inputExamples": [
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Move the card into the Done column",
        "from_index": 3,
        "to_index": 8
      }
    ],
    "host": {
      "capability": "browser",
      "action": "dragAndDrop"
    }
  },
  {
    "type": "function",
    "name": "BrowserEvaluate",
    "description": "Execute JavaScript in the active tab's main world via CDP Runtime.evaluate (awaitPromise=true, returnByValue=true). Returns the JSON-stringified return value, capped at ~20k chars. Disabled by default — the user must opt in via Settings · Tools because the surface has same-origin access (cookies, fetch, localStorage). Use for: ARIA-only widgets the structured observation didn't surface, inspecting page-side state (React/Redux/window globals), gestures (custom drag/hover events) the structured actions can't express. Best practice: wrap in an IIFE — `(() => { try { /* ... */ return value; } catch (e) { return { error: String(e) }; } })()` — and only call browser APIs (document, window, DOM). Async IIFEs are awaited.",
    "parameters": {
      "type": "object",
      "properties": {
        "evaluation_previous_goal": {
          "type": "string",
          "description": "Required one-sentence judgement of whether the previous turn's `next_goal` was achieved, partially achieved, or failed, citing concrete evidence from the latest observation (e.g. \"Login form submitted; landing page now shows the user's name\"). On the first turn, state that there is no prior goal yet."
        },
        "memory": {
          "type": "string",
          "description": "Required running scratchpad of facts and decisions worth carrying forward across turns (URLs visited, search terms tried, IDs found, dead ends ruled out, sub-results collected). Append to and prune what you wrote last turn; don't re-derive it from scratch."
        },
        "next_goal": {
          "type": "string",
          "description": "Required single concrete intent this call is meant to accomplish, phrased so the next turn's `evaluation_previous_goal` can check it. One sentence, action-shaped (e.g. \"Open the first organic result and read the article body\")."
        },
        "code": {
          "type": "string",
          "description": "JavaScript expression or statement to evaluate. The value of the last expression is returned. For multi-statement or async code, wrap in an IIFE that returns the value you want — e.g. `(async () => { const r = await fetch('/x'); return r.status; })()`. Errors thrown inside the IIFE are caught and returned as `{ error: '...' }`."
        }
      },
      "required": [
        "evaluation_previous_goal",
        "memory",
        "next_goal",
        "code"
      ]
    },
    "skill": "browser",
    "concurrencySafe": false,
    "inputExamples": [
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "List the dropdown options with their ids",
        "code": "(() => [...document.querySelectorAll('li[role=\"option\"]')].map(el => ({ id: el.id, text: el.textContent.trim() })))()"
      },
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Confirm the page has finished loading",
        "code": "(() => ({ url: location.href, title: document.title, ready: document.readyState }))()"
      },
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Check the status endpoint",
        "code": "(async () => { const r = await fetch('/api/status'); return { ok: r.ok, code: r.status }; })()"
      }
    ],
    "host": {
      "capability": "browser",
      "action": "evaluate"
    }
  },
  {
    "type": "function",
    "name": "BrowserFillForm",
    "description": "Fill multiple form fields in a single call on the active tab. Each entry in `fields` describes one field by its observation index and the action to take. Covers the four mechanics that handle ~95% of HTML forms: text input ('type'), dropdown selection ('select'), checkbox toggle ('check' / 'uncheck'), and radio click ('click'). Fields are applied in order. Optionally clicks a submit button at the end. The actor framework stops the batch at the first failing action; the result envelope's standard error string identifies which action failed and the post-batch observation shows the resulting page state — re-issue single-field tools (BrowserType / BrowserSelectOption / BrowserClick) for any field that didn't apply. All fields must be on the same tab. Cap: 50 fields per call.",
    "parameters": {
      "type": "object",
      "properties": {
        "evaluation_previous_goal": {
          "type": "string",
          "description": "Required one-sentence judgement of whether the previous turn's `next_goal` was achieved, partially achieved, or failed, citing concrete evidence from the latest observation (e.g. \"Login form submitted; landing page now shows the user's name\"). On the first turn, state that there is no prior goal yet."
        },
        "memory": {
          "type": "string",
          "description": "Required running scratchpad of facts and decisions worth carrying forward across turns (URLs visited, search terms tried, IDs found, dead ends ruled out, sub-results collected). Append to and prune what you wrote last turn; don't re-derive it from scratch."
        },
        "next_goal": {
          "type": "string",
          "description": "Required single concrete intent this call is meant to accomplish, phrased so the next turn's `evaluation_previous_goal` can check it. One sentence, action-shaped (e.g. \"Open the first organic result and read the article body\")."
        },
        "fields": {
          "type": "array",
          "description": "Ordered list of field operations. Each entry is an object with: `index` (integer, required) — element index from the latest observation; `action` (string, required) — one of 'type' | 'select' | 'check' | 'uncheck' | 'click'; `value` (string) — required for action='type' or 'select', ignored otherwise. For 'type', the existing field content is replaced. For 'select', value must match an <option>'s `value` attribute exactly. For 'check'/'uncheck', the action is a no-op if the checkbox is already in the desired state.",
          "items": {
            "type": "object"
          }
        },
        "submit_index": {
          "type": "integer",
          "description": "Optional element index of a submit/continue button to click after all fields are filled. If omitted, leaves the form open. If any field failed and stop_on_error=false, the submit is skipped (safer default — partial submits are usually wrong)."
        },
        "stop_on_error": {
          "type": "boolean",
          "description": "Reserved for forward compatibility. In v1 the actor framework always stops the batch at the first failing field — the flag is accepted but has no effect. Future versions may add a best-effort 'attempt every field, return per-field results' path."
        }
      },
      "required": [
        "evaluation_previous_goal",
        "memory",
        "next_goal",
        "fields"
      ]
    },
    "skill": "browser",
    "concurrencySafe": false,
    "inputExamples": [
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Fill in and submit the sign-up form",
        "fields": [
          {
            "index": 12,
            "action": "type",
            "value": "Ada Lovelace"
          },
          {
            "index": 13,
            "action": "type",
            "value": "ada@example.com"
          },
          {
            "index": 14,
            "action": "select",
            "value": "US"
          },
          {
            "index": 15,
            "action": "check"
          }
        ],
        "submit_index": 16
      },
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Enter the search term in the search box",
        "fields": [
          {
            "index": 22,
            "action": "type",
            "value": "machine learning"
          }
        ]
      }
    ],
    "host": {
      "capability": "browser",
      "action": "fillForm"
    }
  },
  {
    "type": "function",
    "name": "BrowserFindText",
    "description": "Search the active tab's visible page for text matching `query` (case-insensitive substring match). Returns each match's text plus the nearest clickable ancestor's index, so you can click the result directly without doing a separate observation pass. Number of results is capped server-side.",
    "parameters": {
      "type": "object",
      "properties": {
        "evaluation_previous_goal": {
          "type": "string",
          "description": "Required one-sentence judgement of whether the previous turn's `next_goal` was achieved, partially achieved, or failed, citing concrete evidence from the latest observation (e.g. \"Login form submitted; landing page now shows the user's name\"). On the first turn, state that there is no prior goal yet."
        },
        "memory": {
          "type": "string",
          "description": "Required running scratchpad of facts and decisions worth carrying forward across turns (URLs visited, search terms tried, IDs found, dead ends ruled out, sub-results collected). Append to and prune what you wrote last turn; don't re-derive it from scratch."
        },
        "next_goal": {
          "type": "string",
          "description": "Required single concrete intent this call is meant to accomplish, phrased so the next turn's `evaluation_previous_goal` can check it. One sentence, action-shaped (e.g. \"Open the first organic result and read the article body\")."
        },
        "query": {
          "type": "string",
          "description": "Required text to search for. Case-insensitive substring match."
        },
        "include_observation": {
          "type": "boolean",
          "description": "When true, include the full interactive elements[] in the observation. Default false: the result carries matches[] (each with clickable_ancestor_index, enough to click the result directly) plus basics-only tab metadata. Set true only if you need to act on a different element than the search hit."
        }
      },
      "required": [
        "evaluation_previous_goal",
        "memory",
        "next_goal",
        "query"
      ]
    },
    "skill": "browser",
    "concurrencySafe": false,
    "inputExamples": [
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Locate the sign-in link",
        "query": "sign in"
      },
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Locate the next-page link",
        "query": "next page"
      }
    ],
    "host": {
      "capability": "browser",
      "action": "findText"
    }
  },
  {
    "type": "function",
    "name": "BrowserHover",
    "description": "Move the cursor over an element on the active tab without clicking it. Use to reveal hover-only UI (nav dropdowns, CSS `:hover` menus, video controls, tooltips). The next observation will show whatever the hover surfaced.",
    "parameters": {
      "type": "object",
      "properties": {
        "evaluation_previous_goal": {
          "type": "string",
          "description": "Required one-sentence judgement of whether the previous turn's `next_goal` was achieved, partially achieved, or failed, citing concrete evidence from the latest observation (e.g. \"Login form submitted; landing page now shows the user's name\"). On the first turn, state that there is no prior goal yet."
        },
        "memory": {
          "type": "string",
          "description": "Required running scratchpad of facts and decisions worth carrying forward across turns (URLs visited, search terms tried, IDs found, dead ends ruled out, sub-results collected). Append to and prune what you wrote last turn; don't re-derive it from scratch."
        },
        "next_goal": {
          "type": "string",
          "description": "Required single concrete intent this call is meant to accomplish, phrased so the next turn's `evaluation_previous_goal` can check it. One sentence, action-shaped (e.g. \"Open the first organic result and read the article body\")."
        },
        "index": {
          "type": "integer",
          "description": "Required element index from the latest observation's elements[] list."
        }
      },
      "required": [
        "evaluation_previous_goal",
        "memory",
        "next_goal",
        "index"
      ]
    },
    "skill": "browser",
    "concurrencySafe": false,
    "inputExamples": [
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Reveal the account menu",
        "index": 4
      }
    ],
    "host": {
      "capability": "browser",
      "action": "hover"
    }
  },
  {
    "type": "function",
    "name": "BrowserType",
    "description": "Type text into a focusable input element on the active tab (text field, textarea, contenteditable). The index must come from the most recent observation's `elements[]`. Set `submit: true` to press Enter immediately after typing — useful for search boxes that submit on Enter. For filling multiple fields at once, prefer `BrowserFillForm`.",
    "parameters": {
      "type": "object",
      "properties": {
        "evaluation_previous_goal": {
          "type": "string",
          "description": "Required one-sentence judgement of whether the previous turn's `next_goal` was achieved, partially achieved, or failed, citing concrete evidence from the latest observation (e.g. \"Login form submitted; landing page now shows the user's name\"). On the first turn, state that there is no prior goal yet."
        },
        "memory": {
          "type": "string",
          "description": "Required running scratchpad of facts and decisions worth carrying forward across turns (URLs visited, search terms tried, IDs found, dead ends ruled out, sub-results collected). Append to and prune what you wrote last turn; don't re-derive it from scratch."
        },
        "next_goal": {
          "type": "string",
          "description": "Required single concrete intent this call is meant to accomplish, phrased so the next turn's `evaluation_previous_goal` can check it. One sentence, action-shaped (e.g. \"Open the first organic result and read the article body\")."
        },
        "index": {
          "type": "integer",
          "description": "Required element index from the latest observation's elements[] list."
        },
        "text": {
          "type": "string",
          "description": "Required text to type. The framework focuses the element first; existing content is replaced if the field is selected on focus."
        },
        "submit": {
          "type": "boolean",
          "description": "If true, press Enter after typing. Useful for search boxes."
        }
      },
      "required": [
        "evaluation_previous_goal",
        "memory",
        "next_goal",
        "index",
        "text"
      ]
    },
    "skill": "browser",
    "concurrencySafe": false,
    "inputExamples": [
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Type the greeting into the message box",
        "index": 5,
        "text": "hello world"
      },
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Search for the query",
        "index": 5,
        "text": "search query",
        "submit": true
      }
    ],
    "host": {
      "capability": "browser",
      "action": "input"
    }
  },
  {
    "type": "function",
    "name": "BrowserMediaControl",
    "description": "Control playback on the active tab's MediaSession. action='play' resumes, 'pause' halts, 'seek' jumps to seek_time_ms (an absolute position in milliseconds from the start of the media). Quietly no-ops on pages without an active MediaSession (most YouTube / Vimeo / Spotify-style players register one; static pages do not).",
    "parameters": {
      "type": "object",
      "properties": {
        "evaluation_previous_goal": {
          "type": "string",
          "description": "Required one-sentence judgement of whether the previous turn's `next_goal` was achieved, partially achieved, or failed, citing concrete evidence from the latest observation (e.g. \"Login form submitted; landing page now shows the user's name\"). On the first turn, state that there is no prior goal yet."
        },
        "memory": {
          "type": "string",
          "description": "Required running scratchpad of facts and decisions worth carrying forward across turns (URLs visited, search terms tried, IDs found, dead ends ruled out, sub-results collected). Append to and prune what you wrote last turn; don't re-derive it from scratch."
        },
        "next_goal": {
          "type": "string",
          "description": "Required single concrete intent this call is meant to accomplish, phrased so the next turn's `evaluation_previous_goal` can check it. One sentence, action-shaped (e.g. \"Open the first organic result and read the article body\")."
        },
        "action": {
          "type": "string",
          "description": "One of: 'play', 'pause', 'seek'. 'seek' additionally requires seek_time_ms."
        },
        "seek_time_ms": {
          "type": "integer",
          "description": "Required when action='seek'. Absolute target position in milliseconds from the start of the media (e.g. 90000 jumps to 1m30s in)."
        }
      },
      "required": [
        "evaluation_previous_goal",
        "memory",
        "next_goal",
        "action"
      ]
    },
    "skill": "browser",
    "concurrencySafe": false,
    "inputExamples": [
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Start the video",
        "action": "play"
      },
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Pause the video",
        "action": "pause"
      },
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Jump to the 1:30 mark",
        "action": "seek",
        "seek_time_ms": 90000
      }
    ],
    "host": {
      "capability": "browser",
      "action": "mediaControl"
    }
  },
  {
    "type": "function",
    "name": "BrowserMediaState",
    "description": "Read the active tab's MediaSession state — playback state (playing/paused), current position, duration, playback rate, and the title/artist/album supplied via navigator.mediaSession.metadata. Synchronous; does not go through the actor pipeline.",
    "parameters": {
      "type": "object",
      "properties": {
        "evaluation_previous_goal": {
          "type": "string",
          "description": "Required one-sentence judgement of whether the previous turn's `next_goal` was achieved, partially achieved, or failed, citing concrete evidence from the latest observation (e.g. \"Login form submitted; landing page now shows the user's name\"). On the first turn, state that there is no prior goal yet."
        },
        "memory": {
          "type": "string",
          "description": "Required running scratchpad of facts and decisions worth carrying forward across turns (URLs visited, search terms tried, IDs found, dead ends ruled out, sub-results collected). Append to and prune what you wrote last turn; don't re-derive it from scratch."
        },
        "next_goal": {
          "type": "string",
          "description": "Required single concrete intent this call is meant to accomplish, phrased so the next turn's `evaluation_previous_goal` can check it. One sentence, action-shaped (e.g. \"Open the first organic result and read the article body\")."
        }
      },
      "required": [
        "evaluation_previous_goal",
        "memory",
        "next_goal"
      ]
    },
    "skill": "browser",
    "concurrencySafe": false,
    "inputExamples": [
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Check whether the video is playing"
      }
    ],
    "host": {
      "capability": "browser",
      "action": "mediaState"
    }
  },
  {
    "type": "function",
    "name": "BrowserNavigate",
    "description": "Navigate to an absolute URL. Defaults to replacing the active tab's location. Set new_tab=true to open the URL in a fresh tab instead (use this when you need a side-by-side view or when navigating away would lose state). For search-style intent (\"find me X about Y\"), prefer the `BrowserSearch` tool — it picks an engine and crafts a query for you.",
    "parameters": {
      "type": "object",
      "properties": {
        "evaluation_previous_goal": {
          "type": "string",
          "description": "Required one-sentence judgement of whether the previous turn's `next_goal` was achieved, partially achieved, or failed, citing concrete evidence from the latest observation (e.g. \"Login form submitted; landing page now shows the user's name\"). On the first turn, state that there is no prior goal yet."
        },
        "memory": {
          "type": "string",
          "description": "Required running scratchpad of facts and decisions worth carrying forward across turns (URLs visited, search terms tried, IDs found, dead ends ruled out, sub-results collected). Append to and prune what you wrote last turn; don't re-derive it from scratch."
        },
        "next_goal": {
          "type": "string",
          "description": "Required single concrete intent this call is meant to accomplish, phrased so the next turn's `evaluation_previous_goal` can check it. One sentence, action-shaped (e.g. \"Open the first organic result and read the article body\")."
        },
        "url": {
          "type": "string",
          "description": "Absolute URL to navigate to (must include the scheme, e.g. https://example.com/page)."
        },
        "new_tab": {
          "type": "boolean",
          "description": "If true, open the URL in a new tab. Default false (replace the active tab's location)."
        }
      },
      "required": [
        "evaluation_previous_goal",
        "memory",
        "next_goal",
        "url"
      ]
    },
    "skill": "browser",
    "concurrencySafe": false,
    "inputExamples": [
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Open example.com",
        "url": "https://example.com"
      },
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Open the Hacker News front page",
        "url": "https://news.ycombinator.com"
      },
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Open the article in a new tab",
        "url": "https://example.com/article",
        "new_tab": true
      }
    ],
    "host": {
      "capability": "browser",
      "action": "navigate"
    }
  },
  {
    "type": "function",
    "name": "BrowserReadElement",
    "description": "Get the visible text inside one element on the active tab. Use when the observation's element label is truncated, or when you need the full body of a paragraph/article block. For page-wide search use `BrowserFindText` instead. Response is capped server-side.",
    "parameters": {
      "type": "object",
      "properties": {
        "evaluation_previous_goal": {
          "type": "string",
          "description": "Required one-sentence judgement of whether the previous turn's `next_goal` was achieved, partially achieved, or failed, citing concrete evidence from the latest observation (e.g. \"Login form submitted; landing page now shows the user's name\"). On the first turn, state that there is no prior goal yet."
        },
        "memory": {
          "type": "string",
          "description": "Required running scratchpad of facts and decisions worth carrying forward across turns (URLs visited, search terms tried, IDs found, dead ends ruled out, sub-results collected). Append to and prune what you wrote last turn; don't re-derive it from scratch."
        },
        "next_goal": {
          "type": "string",
          "description": "Required single concrete intent this call is meant to accomplish, phrased so the next turn's `evaluation_previous_goal` can check it. One sentence, action-shaped (e.g. \"Open the first organic result and read the article body\")."
        },
        "index": {
          "type": "integer",
          "description": "Required element index from the latest observation's elements[] list."
        }
      },
      "required": [
        "evaluation_previous_goal",
        "memory",
        "next_goal",
        "index"
      ]
    },
    "skill": "browser",
    "concurrencySafe": false,
    "inputExamples": [
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Read the full text of the pricing table",
        "index": 12
      }
    ],
    "host": {
      "capability": "browser",
      "action": "readElement"
    }
  },
  {
    "type": "function",
    "name": "BrowserReadPage",
    "description": "Read the visible text content of the active tab. Useful when the indexed observation isn't enough — e.g. you need to read paragraph copy, search for content that isn't an interactive element, or grab article text. Returns page_text plus title/url metadata. Response is capped server-side; `truncated` flag is set when the cap is hit. By default the accompanying observation is basics-only (tab_id/url/title, no elements[]) to save tokens — pass `include_observation:true` if you intend to act on a page element right after reading.",
    "parameters": {
      "type": "object",
      "properties": {
        "evaluation_previous_goal": {
          "type": "string",
          "description": "Required one-sentence judgement of whether the previous turn's `next_goal` was achieved, partially achieved, or failed, citing concrete evidence from the latest observation (e.g. \"Login form submitted; landing page now shows the user's name\"). On the first turn, state that there is no prior goal yet."
        },
        "memory": {
          "type": "string",
          "description": "Required running scratchpad of facts and decisions worth carrying forward across turns (URLs visited, search terms tried, IDs found, dead ends ruled out, sub-results collected). Append to and prune what you wrote last turn; don't re-derive it from scratch."
        },
        "next_goal": {
          "type": "string",
          "description": "Required single concrete intent this call is meant to accomplish, phrased so the next turn's `evaluation_previous_goal` can check it. One sentence, action-shaped (e.g. \"Open the first organic result and read the article body\")."
        },
        "include_observation": {
          "type": "boolean",
          "description": "When true, include the full interactive elements[] in the observation (as other tools do) so you can click/type a page element right after reading. Default false: the result carries only page_text plus basics-only tab metadata, which is all you need to read content."
        }
      },
      "required": [
        "evaluation_previous_goal",
        "memory",
        "next_goal"
      ]
    },
    "skill": "browser",
    "concurrencySafe": false,
    "inputExamples": [
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Read the article body"
      }
    ],
    "host": {
      "capability": "browser",
      "action": "readPage"
    }
  },
  {
    "type": "function",
    "name": "BrowserScreenshot",
    "description": "Capture a screenshot of the active tab and return it alongside a fresh page observation. Use when visual context is needed; the default observation already lists every actionable element. Pass an element index to capture just that element (and a little of its surroundings) — far fewer image tokens than the whole viewport.",
    "parameters": {
      "type": "object",
      "properties": {
        "evaluation_previous_goal": {
          "type": "string",
          "description": "Required one-sentence judgement of whether the previous turn's `next_goal` was achieved, partially achieved, or failed, citing concrete evidence from the latest observation (e.g. \"Login form submitted; landing page now shows the user's name\"). On the first turn, state that there is no prior goal yet."
        },
        "memory": {
          "type": "string",
          "description": "Required running scratchpad of facts and decisions worth carrying forward across turns (URLs visited, search terms tried, IDs found, dead ends ruled out, sub-results collected). Append to and prune what you wrote last turn; don't re-derive it from scratch."
        },
        "next_goal": {
          "type": "string",
          "description": "Required single concrete intent this call is meant to accomplish, phrased so the next turn's `evaluation_previous_goal` can check it. One sentence, action-shaped (e.g. \"Open the first organic result and read the article body\")."
        },
        "index": {
          "type": "integer",
          "description": "Optional element index from the latest observation's elements[] to crop the screenshot to (e.g. a chart, an image, a canvas). The element must be in the current viewport. OMIT THIS FIELD ENTIRELY for a full-viewport screenshot — do NOT pass 0 or a placeholder."
        }
      },
      "required": [
        "evaluation_previous_goal",
        "memory",
        "next_goal"
      ]
    },
    "skill": "browser",
    "concurrencySafe": false,
    "inputExamples": [
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Capture the page to check the layout"
      },
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Capture the chart to read its values",
        "index": 12
      }
    ],
    "host": {
      "capability": "browser",
      "action": "screenshot"
    }
  },
  {
    "type": "function",
    "name": "BrowserScroll",
    "description": "Scroll the active tab's viewport in a direction by N viewport-units (1.0 = one full page). Pass an element index to scroll INSIDE that element instead of the viewport.",
    "parameters": {
      "type": "object",
      "properties": {
        "evaluation_previous_goal": {
          "type": "string",
          "description": "Required one-sentence judgement of whether the previous turn's `next_goal` was achieved, partially achieved, or failed, citing concrete evidence from the latest observation (e.g. \"Login form submitted; landing page now shows the user's name\"). On the first turn, state that there is no prior goal yet."
        },
        "memory": {
          "type": "string",
          "description": "Required running scratchpad of facts and decisions worth carrying forward across turns (URLs visited, search terms tried, IDs found, dead ends ruled out, sub-results collected). Append to and prune what you wrote last turn; don't re-derive it from scratch."
        },
        "next_goal": {
          "type": "string",
          "description": "Required single concrete intent this call is meant to accomplish, phrased so the next turn's `evaluation_previous_goal` can check it. One sentence, action-shaped (e.g. \"Open the first organic result and read the article body\")."
        },
        "direction": {
          "type": "string",
          "description": "Required scroll direction: 'up', 'down', 'left', or 'right'."
        },
        "amount": {
          "type": "number",
          "description": "How far to scroll, in viewport-units. Default 1.0 (one full page). Use 0.5 for half a page, 2.0 for two pages."
        },
        "index": {
          "type": "integer",
          "description": "Optional element index to scroll INSIDE (instead of scrolling the viewport). The element must be a scrollable container from the latest observation's elements[]. OMIT THIS FIELD ENTIRELY to scroll the page viewport — do NOT pass 0 or any placeholder, since 0 isn't a valid element index and will be rejected. Only set this when you specifically need to scroll inside a nested scrollable region (e.g. a modal's overflow list)."
        }
      },
      "required": [
        "evaluation_previous_goal",
        "memory",
        "next_goal",
        "direction"
      ]
    },
    "skill": "browser",
    "concurrencySafe": false,
    "inputExamples": [
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Scroll down to load more results",
        "direction": "down"
      },
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Scroll back up to the filters",
        "direction": "up",
        "amount": 0.5
      },
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Scroll the comments panel down",
        "direction": "down",
        "amount": 2.0,
        "index": 12
      }
    ],
    "host": {
      "capability": "browser",
      "action": "scroll"
    }
  },
  {
    "type": "function",
    "name": "BrowserScrollToElement",
    "description": "Scroll an element on the active tab into the viewport. Use when an element is in the observation but off-screen, or when an action needs the target visible (some click/keyboard actions skip elements that are not currently visible).",
    "parameters": {
      "type": "object",
      "properties": {
        "evaluation_previous_goal": {
          "type": "string",
          "description": "Required one-sentence judgement of whether the previous turn's `next_goal` was achieved, partially achieved, or failed, citing concrete evidence from the latest observation (e.g. \"Login form submitted; landing page now shows the user's name\"). On the first turn, state that there is no prior goal yet."
        },
        "memory": {
          "type": "string",
          "description": "Required running scratchpad of facts and decisions worth carrying forward across turns (URLs visited, search terms tried, IDs found, dead ends ruled out, sub-results collected). Append to and prune what you wrote last turn; don't re-derive it from scratch."
        },
        "next_goal": {
          "type": "string",
          "description": "Required single concrete intent this call is meant to accomplish, phrased so the next turn's `evaluation_previous_goal` can check it. One sentence, action-shaped (e.g. \"Open the first organic result and read the article body\")."
        },
        "index": {
          "type": "integer",
          "description": "Required element index from the latest observation's elements[] list."
        }
      },
      "required": [
        "evaluation_previous_goal",
        "memory",
        "next_goal",
        "index"
      ]
    },
    "skill": "browser",
    "concurrencySafe": false,
    "inputExamples": [
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Bring the submit button into view",
        "index": 27
      }
    ],
    "host": {
      "capability": "browser",
      "action": "scrollTo"
    }
  },
  {
    "type": "function",
    "name": "BrowserSearch",
    "description": "Preferred first step for any 'find / look up / search the web' intent. Opens a search engine results page for `query` in a new tab. Default engine is google; pick another via the optional `engine` field (e.g. baidu for Chinese-language searches, duckduckgo for privacy-sensitive ones).",
    "parameters": {
      "type": "object",
      "properties": {
        "evaluation_previous_goal": {
          "type": "string",
          "description": "Required one-sentence judgement of whether the previous turn's `next_goal` was achieved, partially achieved, or failed, citing concrete evidence from the latest observation (e.g. \"Login form submitted; landing page now shows the user's name\"). On the first turn, state that there is no prior goal yet."
        },
        "memory": {
          "type": "string",
          "description": "Required running scratchpad of facts and decisions worth carrying forward across turns (URLs visited, search terms tried, IDs found, dead ends ruled out, sub-results collected). Append to and prune what you wrote last turn; don't re-derive it from scratch."
        },
        "next_goal": {
          "type": "string",
          "description": "Required single concrete intent this call is meant to accomplish, phrased so the next turn's `evaluation_previous_goal` can check it. One sentence, action-shaped (e.g. \"Open the first organic result and read the article body\")."
        },
        "query": {
          "type": "string",
          "description": "Required search query. Phrase it naturally; the framework picks the URL shape for the chosen engine."
        },
        "engine": {
          "type": "string",
          "description": "Optional engine: 'google' (default), 'bing', 'baidu', or 'duckduckgo'."
        }
      },
      "required": [
        "evaluation_previous_goal",
        "memory",
        "next_goal",
        "query"
      ]
    },
    "skill": "browser",
    "concurrencySafe": false,
    "inputExamples": [
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Search for the Chromium release notes",
        "query": "chromium release notes"
      },
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Search for a fix to the redirect error",
        "query": "how to fix err_too_many_redirects",
        "engine": "duckduckgo"
      }
    ],
    "host": {
      "capability": "browser",
      "action": "search"
    }
  },
  {
    "type": "function",
    "name": "BrowserSelectOption",
    "description": "Pick an option from a native <select> element on the active tab. The `value` must match one of the <option>'s `value` attributes exactly (case-sensitive). For non-native combobox widgets (custom dropdown UI) use `BrowserClick` to expand the menu, then `BrowserClick` again on the desired option.",
    "parameters": {
      "type": "object",
      "properties": {
        "evaluation_previous_goal": {
          "type": "string",
          "description": "Required one-sentence judgement of whether the previous turn's `next_goal` was achieved, partially achieved, or failed, citing concrete evidence from the latest observation (e.g. \"Login form submitted; landing page now shows the user's name\"). On the first turn, state that there is no prior goal yet."
        },
        "memory": {
          "type": "string",
          "description": "Required running scratchpad of facts and decisions worth carrying forward across turns (URLs visited, search terms tried, IDs found, dead ends ruled out, sub-results collected). Append to and prune what you wrote last turn; don't re-derive it from scratch."
        },
        "next_goal": {
          "type": "string",
          "description": "Required single concrete intent this call is meant to accomplish, phrased so the next turn's `evaluation_previous_goal` can check it. One sentence, action-shaped (e.g. \"Open the first organic result and read the article body\")."
        },
        "index": {
          "type": "integer",
          "description": "Required element index of the <select>, from the latest observation's elements[] list."
        },
        "value": {
          "type": "string",
          "description": "Required option value (the <option>'s `value` attribute, not its visible text)."
        }
      },
      "required": [
        "evaluation_previous_goal",
        "memory",
        "next_goal",
        "index",
        "value"
      ]
    },
    "skill": "browser",
    "concurrencySafe": false,
    "inputExamples": [
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Choose United States as the country",
        "index": 18,
        "value": "us"
      }
    ],
    "host": {
      "capability": "browser",
      "action": "select"
    }
  },
  {
    "type": "function",
    "name": "BrowserUpload",
    "description": "Attach a local file to a file <input> on the page. Pass `index` of the file-input element (or the button/label that opens the file picker) and `file_path` of the file to attach (workspace-relative, or absolute). The host intercepts the file chooser the click opens and supplies your file — no native dialog appears. The file must already exist locally (e.g. one you downloaded with BrowserDownload or created with the file tools). After it runs, re-read the observation to confirm the input now shows the filename.",
    "parameters": {
      "type": "object",
      "properties": {
        "evaluation_previous_goal": {
          "type": "string",
          "description": "Required one-sentence judgement of whether the previous turn's `next_goal` was achieved, partially achieved, or failed, citing concrete evidence from the latest observation (e.g. \"Login form submitted; landing page now shows the user's name\"). On the first turn, state that there is no prior goal yet."
        },
        "memory": {
          "type": "string",
          "description": "Required running scratchpad of facts and decisions worth carrying forward across turns (URLs visited, search terms tried, IDs found, dead ends ruled out, sub-results collected). Append to and prune what you wrote last turn; don't re-derive it from scratch."
        },
        "next_goal": {
          "type": "string",
          "description": "Required single concrete intent this call is meant to accomplish, phrased so the next turn's `evaluation_previous_goal` can check it. One sentence, action-shaped (e.g. \"Open the first organic result and read the article body\")."
        },
        "index": {
          "type": "integer",
          "description": "Element index (from the latest observation's elements[]) of the file <input> — or the control that opens the file picker — to click."
        },
        "file_path": {
          "type": "string",
          "description": "Path to the local file to upload. Relative paths resolve against the session workspace; absolute paths are used as-is. The file must already exist."
        }
      },
      "required": [
        "evaluation_previous_goal",
        "memory",
        "next_goal",
        "index",
        "file_path"
      ]
    },
    "skill": "browser",
    "concurrencySafe": false,
    "inputExamples": [
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Attach the resume to the application",
        "index": 31,
        "file_path": "downloads/resume.pdf"
      },
      {
        "evaluation_previous_goal": "No prior goal yet; this is the first browser step.",
        "memory": "Task: complete the user's request in the browser. Nothing collected yet.",
        "next_goal": "Upload the new avatar image",
        "index": 12,
        "file_path": "C:\\Users\\me\\Pictures\\avatar.png"
      }
    ],
    "host": {
      "capability": "browser",
      "action": "upload"
    }
  }
]
