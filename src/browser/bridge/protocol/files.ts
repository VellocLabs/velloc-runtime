// `files` capability — the host actions behind the file tools (C++
// `NexusFilesBridgeAdapter`, declarations under api/declarations/files/).
// Each action takes the tool's own arguments and answers with the tool
// result envelope (`{ data, agent_meta? }`); the runtime's host tool
// definitions (`toolkit/builtin/host`) own the model-facing schema, so the
// payloads are typed loosely here on purpose.
export type HostToolCallPayload = Record<string, unknown>

export type HostToolCallResult = unknown

export type FilesBridgeActionMap = {
  read: { payload: HostToolCallPayload; result: HostToolCallResult }
  write: { payload: HostToolCallPayload; result: HostToolCallResult }
  edit: { payload: HostToolCallPayload; result: HostToolCallResult }
  glob: { payload: HostToolCallPayload; result: HostToolCallResult }
  grep: { payload: HostToolCallPayload; result: HostToolCallResult }
}
