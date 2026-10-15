export * as SessionNextSteps from "./next-steps.js"

import { LLMClient, LLMEvent, Message, SystemPart } from "@opencode/ai/effect"
import type { Agent } from "@opencode/schema/agent"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { llmClient } from "../effect/app-node-platform.js"
import { Form } from "../form.js"
import { Permission } from "../permission.js"
import { SessionContext } from "./context.js"
import { SessionEvent } from "./event.js"
import { SessionHistory } from "./history.js"
import { SessionInbox } from "./inbox.js"
import { SessionMessage } from "./message.js"
import type { SessionRunnerModel } from "./runner/model.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"
import { SessionUsage } from "./usage.js"

const MAX_TRANSCRIPT_LENGTH = 16_000
const MAX_LENGTH = 200
const MAX_COUNT = 3
const FORMAT = `Respond with only a JSON object of the form {"nextSteps": ["..."]}. Use an empty array when there is no useful next message. Each entry is one complete message of at most ${MAX_LENGTH} characters.`

export interface Target {
  readonly sessionID: SessionSchema.ID
  readonly messageID: SessionMessage.ID
  readonly idleID: SessionMessage.ID
}

export interface Interface {
  /** Suggests messages the user could send after the target reply; empty when the target is not eligible. */
  readonly generate: (target: Target) => Effect.Effect<ReadonlyArray<string>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionNextSteps") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const llm = yield* LLMClient.Service
    const context = yield* SessionContext.Service
    const store = yield* SessionStore.Service
    const forms = yield* Form.Service
    const permissions = yield* Permission.Service
    const db = (yield* Database.Service).db

    const eligible = Effect.fn("SessionNextSteps.eligible")(function* (target: Target) {
      const session = yield* store.get(target.sessionID)
      if (!session || session.time.archived || session.revert) return
      if ((yield* SessionInbox.list(db, session.id)).length > 0) return
      if ((yield* forms.list({ sessionID: session.id })).length > 0) return
      if ((yield* permissions.forSession(session.id)).length > 0) return
      const idle = (yield* store.messages({ sessionID: session.id, type: "idle", limit: 1 }))[0]
      if (idle?.type !== "idle" || idle.id !== target.idleID || idle.outcome !== "succeeded") return
      const later = yield* store.messages({
        sessionID: session.id,
        order: "asc",
        cursor: { id: target.idleID, direction: "next" },
      })
      // Switching agent or model while idle prepares the next request; it is not conversational work.
      if (later.some((message) => message.type !== "agent-switched" && message.type !== "model-switched")) return
      const reply = (yield* store.messages({ sessionID: session.id, type: "assistant", limit: 1 }))[0]
      if (reply?.type !== "assistant" || reply.id !== target.messageID) return
      if (reply.error || !reply.time.completed || !replyText(reply)) return
      const closing = yield* store.messages({
        sessionID: session.id,
        type: "idle",
        order: "asc",
        limit: 1,
        cursor: { id: target.messageID, direction: "next" },
      })
      if (closing[0]?.id !== target.idleID) return
      return session
    })

    const attempt = Effect.fn("SessionNextSteps.attempt")(function* (input: {
      readonly session: SessionSchema.Info
      readonly agent: Agent.Info
      readonly model: SessionRunnerModel.Resolved
      readonly transcript: string
    }) {
      const chunks: string[] = []
      let failed = false
      let usage: SessionUsage.Recorded | undefined
      const recordUsage = Effect.suspend(() =>
        usage
          ? bus.publish(SessionEvent.UsageRecorded, { sessionID: input.session.id, source: "next-steps", ...usage })
          : Effect.void,
      )
      const prepared = yield* context.request.generate({
        session: input.session,
        agent: input.agent.id,
        model: input.model,
        system: [...(input.agent.system ? [SystemPart.make(input.agent.system)] : []), SystemPart.make(FORMAT)],
        messages: [Message.user(input.transcript)],
      })
      const completed = yield* llm.stream(prepared.request, prepared.options).pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          if (LLMEvent.is.stepFinish(event)) {
            const step = SessionUsage.record(event.usage, input.model.cost)
            usage = usage ? SessionUsage.add(usage, step) : step
          }
          return Effect.void
        }),
        Effect.catchTag("AI.Error", () =>
          Effect.sync(() => {
            failed = true
          }),
        ),
        Effect.timeoutOption("30 seconds"),
        Effect.onInterrupt(() => recordUsage.pipe(Effect.asVoid)),
      )
      yield* recordUsage
      if (failed || Option.isNone(completed)) return
      return chunks.join("")
    })

    const generate = Effect.fn("SessionNextSteps.generate")(
      function* (target: Target) {
        const session = yield* eligible(target)
        if (!session) return []
        const selected = yield* context.selectNextSteps(session)
        if (!selected) return []
        const messages = yield* SessionHistory.load(db, session.id, "local")
        const text = yield* attempt({
          session,
          agent: selected.agent,
          model: selected.model,
          transcript: transcript(
            messages,
            target.messageID,
            Math.min(MAX_TRANSCRIPT_LENGTH, selected.model.limit.context * 2),
          ),
        })
        if (text === undefined) return []
        const nextSteps = parse(text)
        if (!(yield* eligible(target))) return []
        return nextSteps
      },
      Effect.catchCause(() => Effect.succeed<ReadonlyArray<string>>([])),
    )

    return Service.of({ generate })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, llmClient, SessionContext.node, SessionStore.node, Database.node, Form.node, Permission.node],
})

const Output = Schema.fromJsonString(Schema.Struct({ nextSteps: Schema.Array(Schema.String) }))
const decodeOutput = Schema.decodeUnknownOption(Output)

function parse(text: string) {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed)?.[1]
  const json = fenced ?? trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)
  return Option.match(decodeOutput(json), {
    onNone: () => [],
    onSome: (output) =>
      [
        ...new Set(
          output.nextSteps.map((item) => item.trim()).filter((item) => item.length > 0 && item.length <= MAX_LENGTH),
        ),
      ].slice(0, MAX_COUNT),
  })
}

function replyText(message: SessionMessage.Assistant) {
  return message.content.findLast((part) => part.type === "text")?.text.trim()
}

// The latest user request and the target reply are always kept; older history fills the remaining budget newest first.
function transcript(messages: ReadonlyArray<SessionMessage.Info>, messageID: SessionMessage.ID, budget: number) {
  const end = messages.findIndex((message) => message.id === messageID)
  const history = messages.slice(0, end)
  const request = history.findLastIndex((message) => message.type === "user")
  const user = request === -1 ? "" : line(history[request])
  const reply = line(messages[end])
  const userBudget = Math.max(Math.floor(budget / 2), budget - reply.length)
  const kept = user.slice(0, userBudget)
  const required = [kept, reply.slice(Math.max(0, reply.length - (budget - kept.length)))].filter(Boolean)
  const older = history
    .filter((_, index) => index !== request)
    .map(line)
    .filter(Boolean)
    .toReversed()
  const fitting = older.reduce(
    (state, entry) =>
      state.full || state.length + entry.length > budget
        ? { ...state, full: true }
        : { full: false, length: state.length + entry.length, entries: [entry, ...state.entries] },
    { full: false, length: required.reduce((sum, entry) => sum + entry.length, 0), entries: [] as string[] },
  )
  return [...fitting.entries, ...required].join("\n\n")
}

function line(message: SessionMessage.Info | undefined) {
  if (message?.type === "user") return `User: ${message.text}`
  if (message?.type === "assistant") {
    const text = message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim()
    return text ? `Assistant: ${text}` : ""
  }
  if (message?.type === "compaction" && message.status === "completed") return `Summary: ${message.summary}`
  return ""
}
