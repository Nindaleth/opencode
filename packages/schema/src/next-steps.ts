export * as NextSteps from "./next-steps.js"

import { Schema } from "effect"
import { SessionMessage } from "./session-message.js"

export const Request = Schema.Struct({
  messageID: SessionMessage.ID,
  idleID: SessionMessage.ID,
}).annotate({ identifier: "NextSteps.Request" })
export type Request = typeof Request.Type

export const Result = Schema.Struct({
  messageID: SessionMessage.ID,
  idleID: SessionMessage.ID,
  nextSteps: Schema.Array(Schema.String),
}).annotate({ identifier: "NextSteps.Result" })
export type Result = typeof Result.Type
