import { expect, setDefaultTimeout } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Money } from "@opencode/schema/money"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Effect, Layer } from "effect"
import { LanguageModel, LLMClient } from "../../ai/src/effect"
import { OpenAIChat } from "../../ai/src/protocols/openai-chat"
import { TestLLM } from "../../ai/src/testing"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

setDefaultTimeout(30_000)

const model = SessionRunnerModel.resolved(
  LanguageModel.make({ id: "next-steps-model", provider: "test", route: OpenAIChat.route }),
  {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 8_192 },
  },
)

const setup = Effect.gen(function* () {
  const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-session-next-steps-")))
  const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()))
  const state = { active: false, inboxID: SessionMessage.ID.create() }
  // Completes each prompt with one text reply and a successful idle, the way the runner would.
  const execution = Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      return SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        isActive: () => Effect.succeed(state.active),
        resume: () => Effect.void,
        wake: (sessionID) =>
          Effect.gen(function* () {
            const assistantMessageID = SessionMessage.ID.create()
            yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID: state.inboxID })
            yield* bus.publish(SessionEvent.Step.Started, {
              sessionID,
              assistantMessageID,
              agent: Agent.defaultID,
              model: { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") },
              started: 0,
            })
            yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
            yield* bus.publish(SessionEvent.Text.Ended, {
              sessionID,
              assistantMessageID,
              ordinal: 0,
              text: "The build passes now.",
            })
            yield* bus.publish(SessionEvent.Step.Ended, {
              sessionID,
              assistantMessageID,
              finish: "stop",
              cost: Money.USD.zero,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            })
            yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID })
          }),
        interrupt: () => Effect.succeed(false),
        awaitIdle: () => Effect.void,
      })
    }),
  )
  const handler = yield* ServerFetch.make(
    {
      app: { version: "test-version" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
      models: { fetch: false },
    },
    {
      overrides: [
        SessionExecution.node.replace(
          makeGlobalNode({ service: SessionExecution.Service, layer: execution, deps: [Bus.node] }),
        ),
        llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
        SessionRunnerModel.node.replace(
          Layer.succeed(SessionRunnerModel.Service, { resolve: () => Effect.succeed(model) }),
        ),
      ],
    },
  )
  const request = (path: string, body?: unknown) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`http://opencode.local${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: body === undefined ? undefined : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      const text = await response.text()
      return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> }
    })
  const created = yield* request("/api/session", { location: { directory: tmp.path } })
  const sessionID = Session.ID.make((created.body.data as { id: string }).id)
  const reply = Effect.gen(function* () {
    state.inboxID = SessionMessage.ID.create()
    yield* request(`/api/session/${sessionID}/prompt`, { id: state.inboxID, text: "Fix the build" })
    const messages = yield* request(`/api/session/${sessionID}/context`)
    const list = messages.body.data as Array<{ id: string; type: string }>
    return {
      messageID: list.findLast((message) => message.type === "assistant")?.id,
      idleID: list.findLast((message) => message.type === "idle")?.id,
    }
  })
  return { llm, state, request, sessionID, reply }
})

it.live("returns next steps for the latest successful reply", () =>
  Effect.gen(function* () {
    const test = yield* setup
    const target = yield* test.reply
    yield* test.llm.push(TestLLM.text(JSON.stringify({ nextSteps: ["Run the tests"] }), "next-steps"))

    expect(yield* test.request(`/api/session/${test.sessionID}/next-steps`, target)).toEqual({
      status: 200,
      body: { data: { ...target, nextSteps: ["Run the tests"] } },
    })
  }),
)

it.live("returns an empty list for a stale target", () =>
  Effect.gen(function* () {
    const test = yield* setup
    const first = yield* test.reply
    const second = yield* test.reply
    yield* test.llm.push(TestLLM.text(JSON.stringify({ nextSteps: ["Run the tests"] }), "next-steps"))

    const target = { messageID: second.messageID, idleID: first.idleID }
    expect(yield* test.request(`/api/session/${test.sessionID}/next-steps`, target)).toEqual({
      status: 200,
      body: { data: { ...target, nextSteps: [] } },
    })
  }),
)

it.live("returns an empty list while the session is executing", () =>
  Effect.gen(function* () {
    const test = yield* setup
    const target = yield* test.reply
    yield* test.llm.push(TestLLM.text(JSON.stringify({ nextSteps: ["Run the tests"] }), "next-steps"))
    test.state.active = true

    expect(yield* test.request(`/api/session/${test.sessionID}/next-steps`, target)).toEqual({
      status: 200,
      body: { data: { ...target, nextSteps: [] } },
    })
  }),
)

it.live("returns not found for an unknown session", () =>
  Effect.gen(function* () {
    const test = yield* setup
    const response = yield* test.request(`/api/session/${Session.ID.create()}/next-steps`, {
      messageID: SessionMessage.ID.create(),
      idleID: SessionMessage.ID.create(),
    })

    expect(response.status).toBe(404)
  }),
)
