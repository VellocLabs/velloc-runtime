// The session / user / workspace shapes of `BrowserContextSnapshot`. They
// were once the results of a `context` capability (`session` / `userProfile`
// / `workspace`) that no host ever served; its type was removed under
// interface 1. `BrowserHostBridge` builds the session from the
// page (`buildFallbackSessionState`) plus `fs.systemInfo`, and leaves the
// user profile and workspace null.

export type BrowserSessionState = {
  sessionId?: string
  browserName?: string
  browserVersion?: string
  webviewId?: string
  locale?: string
  timezone?: string
  tabCount?: number
  activeTabId?: string
  // Host platform identifiers (`fs.systemInfo`), all optional: platform is
  // 'win32' | 'darwin' | 'linux'; osVersion human-readable; shell the interpreter
  // name only, no path; powershell the one the PowerShell tool launches
  // ("pwsh" | "powershell").
  platform?: 'win32' | 'darwin' | 'linux'
  osVersion?: string
  shell?: string
  powershell?: string
}

export type BrowserUserProfile = {
  id?: string
  displayName?: string
  email?: string
  organization?: string
}

export type BrowserWorkspaceMetadata = {
  workspaceId?: string
  workspaceName?: string
  projectName?: string
  source?: string
}
