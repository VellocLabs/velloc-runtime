/**
 * Contract: the request log's id of one model call (F-27), shared by every
 * send the call makes (its retries, a router's targets, the blocking
 * fallback) and by every file row of a tool call its reply asked for. The id
 * lives beside the request payload, never in it, so no provider sees it; a
 * copy of a payload joins the call with `shareModelCallId`. A reply row is
 * known by its `uuid` for as long as the latest `REPLY_CALL_IDS_MAX` replies.
 */

import { newRequestLogCallId } from './requestLogStore'

type ModelCall = { id: number; sends: number }

const byPayload = new WeakMap<object, ModelCall>()

function callOf(payload: object): ModelCall {
  let call = byPayload.get(payload)
  if (!call) byPayload.set(payload, (call = { id: newRequestLogCallId(), sends: 0 }))
  return call
}

/** The call id of the request `payload`, minted the first time it is asked for. */
export function modelCallIdOf(payload: object): number {
  return callOf(payload).id
}

/** Counts one more send of the call `payload` belongs to; answers its number, 1 for the first. */
export function nextModelCallSend(payload: object): number {
  const call = callOf(payload)
  call.sends += 1
  return call.sends
}

/** A copy of a payload belongs to the same call. */
export function shareModelCallId(copy: object, original: object): void {
  const call = byPayload.get(original)
  if (call) byPayload.set(copy, call)
}

/** Reply rows remembered at once; past it the oldest is forgotten. */
export const REPLY_CALL_IDS_MAX = 4096

const byReply = new Map<string, number>()

/** The reply row `replyUuid` came from the call `callId`. */
export function noteReplyCallId(replyUuid: string, callId: number): void {
  byReply.delete(replyUuid)
  byReply.set(replyUuid, callId)
  if (byReply.size > REPLY_CALL_IDS_MAX) byReply.delete(byReply.keys().next().value as string)
}

/** The call id of the model call a reply row came from; undefined for a row this runtime did not receive. */
export function replyCallIdOf(reply: unknown): number | undefined {
  const uuid = reply && typeof reply === 'object' ? (reply as { uuid?: unknown }).uuid : undefined
  return typeof uuid === 'string' ? byReply.get(uuid) : undefined
}
