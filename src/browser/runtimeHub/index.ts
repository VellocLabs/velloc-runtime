/**
 * UI ⇄ Runtime protocol — the server side.
 *
 * `RuntimeHub` is what the SharedWorker manager constructs; the pieces are
 * exported for tests and for the later phases that add capabilities and
 * topic providers of their own.
 */
export { CapabilityRegistry, scopeAllows, type ActionEntry } from './CapabilityRegistry'
export {
  ConnectionHub,
  type AttachOptions,
  type ConnectionHandle,
  type ConnectionHubOptions,
} from './ConnectionHub'
export { legacyBridgeErrorToWire, toWireError } from './errors'
export {
  DEFAULT_PANEL_ID,
  SHELL_ACTIONS,
  ShellStateTable,
  registerShellCapability,
  shellTopicProvider,
  type ShellState,
} from './shellCapability'
export { BlobInbox, DEFAULT_BLOB_INBOX_LIMITS, type BlobInboxLimits } from './BlobInbox'
export {
  FSX_TREE_SKIPPED_DIRS,
  registerFsxCapability,
  sanitizeUploadFileName,
  sanitizeUploadPathSegment,
  type FsxHost,
  type FsxSessionRoots,
} from './fsxCapability'
export { callHostFs, hostOf, resolveHostHome } from './hostFs'
export {
  knownProjectRootOrRefuse,
  knownProjectRoots,
  matchKnownProjectRoot,
  type KnownProjectSources,
  type SessionProjectRoot,
} from './knownProjects'
export {
  PRESENCE_CAPABILITY,
  PresenceTable,
  registerPresenceCapability,
  type PresenceChange,
  type SetViewingPayload,
} from './presence'
export {
  TERMINALS_STATE_EVENT,
  registerTerminalCapability,
  terminalTopicProvider,
  terminalsTopicProvider,
} from './terminalCapability'
export {
  WORKSPACE_STATE_FILE,
  WORKSPACE_STATE_FILE_VERSION,
  WorkspaceStateStore,
  registerWorkspaceCapability,
  workspaceStateWithin,
  type WorkspaceStateStoreOptions,
} from './workspaceCapability'
export {
  HOST_PROXY_TABLE,
  hostProxyRouteCount,
  hostProxySpecs,
} from './hostProxyTable'
export {
  LEGACY_WEBUI_CAPABILITIES,
  bindImportedProjectRoot,
  isLegacyWebUiCapability,
  legacyWebUiCapabilityDefinitions,
  registerLegacyWebUiCapabilities,
  type LegacyWebUiCapability,
  type LegacyWebUiDeps,
} from './legacyWebUiCapabilities'
export { RuntimeHub, notificationsTopicProvider, settingsTopicScope, type RuntimeHubHost } from './RuntimeHub'
export {
  SESSION_MANAGER_ACTION_SCOPES,
  SESSION_OPEN_FULL_FIELDS,
  hostEnvironmentOf,
  TASK_ACTION_SCOPES,
  WORKER_ACTION_SCOPES,
  classifyManagerMessage,
  createRuntimeTopicPort,
  installSessionSurface,
  managerMessage,
  sessionsEventFor,
  tasksEventFor,
  type ClassifiedMessage,
  type SessionSurface,
  type HostEnvironment,
  type SessionOpenPayload,
  type SessionSurfaceHost,
} from './sessionSurface'
export {
  computeRestartReadiness,
  isOtherClient,
  UNREADABLE_WORK_INPUTS,
  type RestartBlocker,
  type RestartReadiness,
  type RestartReadinessInputs,
  type RestartSessionInput,
  type RestartWorkInputs,
} from './restartReadiness'
export {
  TopicBroker,
  type TopicAuthorization,
  type TopicBrokerOptions,
  type TopicSubscriber,
} from './TopicBroker'
export type {
  ActionSpec,
  BlobOffers,
  CapabilityDefinition,
  CapabilityHandler,
  ConnectionInfo,
  HandlerRequest,
  HostBridge,
  HostProxySpec,
  PublishOptions,
  RuntimeContext,
  SnapshotPage,
  TopicProvider,
} from './types'
