// `browser` capability — the host actions behind the browser tools (C++
// `NexusBrowserBridgeAdapter`, declarations under api/declarations/browser/).
// Each action drives the actor framework for the calling session and
// answers with the tool result envelope.
import type { HostToolCallPayload, HostToolCallResult } from './files'

/** The per-call context a runtime caller passes to `callTool`; the bridge sends its `sessionId` as the frame-level `context`. */
export type BrowserHostedToolExecutionContext = {
  sessionId?: string
  providerId?: string
  modelId?: string
}

type HostAction = { payload: HostToolCallPayload; result: HostToolCallResult }

export type BrowserBridgeActionMap = {
  activateTab: HostAction
  back: HostAction
  click: HostAction
  closeTab: HostAction
  done: HostAction
  download: HostAction
  dragAndDrop: HostAction
  evaluate: HostAction
  fillForm: HostAction
  findText: HostAction
  hover: HostAction
  input: HostAction
  mediaControl: HostAction
  mediaState: HostAction
  navigate: HostAction
  readElement: HostAction
  readPage: HostAction
  screenshot: HostAction
  scroll: HostAction
  scrollTo: HostAction
  search: HostAction
  select: HostAction
  upload: HostAction
}

export type BrowserCapabilityMap = {
  browser: BrowserBridgeActionMap
}
