/** Priority of a queued `worker.submitMessage` turn — LOWER runs first:
 *  user input outranks team messages outrank
 *  sub-agent result deliveries. */
export const SUBMIT_PRIORITY = { user: 0, mailbox: 1, delivery: 2 } as const
