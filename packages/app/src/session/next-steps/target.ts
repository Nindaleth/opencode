import type { SessionMessageInfo } from "@opencode/client/promise"

export type NextStepsTarget = { readonly sessionID: string; readonly messageID: string; readonly idleID: string }

/** Returns the reply that may get next steps: the final reply of the latest successful execution of a ready session. */
export function nextStepsTarget(input: {
  sessionID: string
  messages: readonly SessionMessageInfo[]
  running: boolean
  pending: number
  blocked: boolean
}): NextStepsTarget | undefined {
  if (input.running || input.pending > 0 || input.blocked) return
  const idle = input.messages.at(-1)
  if (idle?.type !== "idle" || idle.outcome !== "succeeded") return
  const reply = input.messages.findLast(
    (message, index) => index < input.messages.length - 1 && (message.type === "assistant" || message.type === "idle"),
  )
  if (reply?.type !== "assistant" || reply.error || reply.time.completed === undefined) return
  const text = reply.content.findLast((part) => part.type === "text")
  if (!text?.text.trim()) return
  return { sessionID: input.sessionID, messageID: reply.id, idleID: idle.id }
}
