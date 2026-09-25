import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionMessage } from "../src/session-message.js"
import { SessionEvent } from "../src/session-event.js"
import { Session } from "../src/session.js"

const artifact = { key: "blob_test", name: "report.zip", mime: "application/zip", size: 3 }

test("Artifact references were lost from successful tool events", () => {
  const data = {
    sessionID: Session.ID.create(),
    assistantMessageID: SessionMessage.ID.create(),
    id: "call",
    content: [{ type: "text", text: "download available" }],
    executed: true,
    artifacts: [artifact],
  }
  expect(
    Schema.encodeSync(SessionEvent.Tool.Success.data)(Schema.decodeUnknownSync(SessionEvent.Tool.Success.data)(data)),
  ).toMatchObject({ artifacts: [artifact] })
})

test("Artifact entries were not independently representable in assistant messages", () => {
  expect(Schema.encodeSync(SessionMessage.AssistantContent)({ type: "artifact", ...artifact })).toEqual({
    type: "artifact",
    ...artifact,
  })
})

test("Optional artifact lists do not emit undefined fields", () => {
  const data = {
    sessionID: Session.ID.create(),
    assistantMessageID: SessionMessage.ID.create(),
    id: "call",
    content: [{ type: "text", text: "ok" }],
    executed: true,
  }
  expect(
    Schema.encodeSync(SessionEvent.Tool.Success.data)(Schema.decodeUnknownSync(SessionEvent.Tool.Success.data)(data)),
  ).not.toHaveProperty("artifacts")
})
