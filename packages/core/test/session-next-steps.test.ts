import { beforeEach, expect } from "bun:test"
import { AIError, LLMClient, LLMEvent, LanguageModel, TransportError, type LLMRequest } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { SessionContext } from "@opencode/core/session/context"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionNextSteps } from "@opencode/core/session/next-steps"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Form } from "@opencode/core/form"
import { Permission } from "@opencode/core/permission"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Location } from "@opencode/core/location"
import { Session } from "@opencode/core/session"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Money } from "@opencode/schema/money"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "./lib/effect"

const provider = Provider.ID.make("test")
const catalog = [
  Model.Info.make({
    ...Model.Info.default(provider, Model.ID.make("session-model")),
    variants: [{ id: Model.VariantID.make("high") }, { id: Model.VariantID.make("low") }],
  }),
  Model.Info.make({
    ...Model.Info.default(provider, Model.ID.make("plain-model")),
    variants: [{ id: Model.VariantID.make("high") }, { id: Model.VariantID.make("max") }],
  }),
  Model.Info.make({
    ...Model.Info.default(provider, Model.ID.make("override-model")),
    variants: [{ id: Model.VariantID.make("none") }, { id: Model.VariantID.make("fast") }],
  }),
]

const cost = [
  {
    input: Money.USDPerMillionTokens.make(1),
    output: Money.USDPerMillionTokens.make(2),
    cache: {
      read: Money.USDPerMillionTokens.make(0.1),
      write: Money.USDPerMillionTokens.make(0.5),
    },
  },
]
const stepFinish = LLMEvent.stepFinish({
  index: 0,
  reason: { normalized: "stop" },
  usage: {
    inputTokens: 15,
    outputTokens: 6,
    nonCachedInputTokens: 10,
    cacheReadInputTokens: 3,
    cacheWriteInputTokens: 2,
    reasoningTokens: 2,
  },
})
const reply = (text: string) =>
  Stream.make(
    LLMEvent.textDelta({ id: "next-steps", text }),
    stepFinish,
    LLMEvent.finish({ reason: { normalized: "stop" } }),
  )

let resolved: Array<Model.Ref | undefined> = []
let requests: LLMRequest[] = []
let pendingPermissions: Permission.Request[] = []
let nextStepsStream: () => Stream.Stream<LLMEvent, AIError> = () => reply("")
const client = Layer.mock(LLMClient.Service)({
  stream: (request: LLMRequest) => {
    requests.push(request)
    return nextStepsStream()
  },
  generate: () => Effect.die("unused"),
})
const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: (session) => {
    resolved.push(session.model)
    const ref = session.model
    if (!ref || !catalog.some((item) => item.id === ref.id))
      return Effect.fail(
        new SessionRunnerModel.ModelUnavailableError({
          providerID: provider,
          modelID: ref?.id ?? Model.ID.make("none"),
        }),
      )
    return Effect.succeed(
      SessionRunnerModel.resolved(LanguageModel.make({ id: ref.id, provider: "test", route: OpenAIChat.route }), {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost,
        limit: { context: 200_000, output: 32_000 },
        variant: ref.variant,
      }),
    )
  },
})
const modelCatalog = Layer.mock(Model.Service, {
  get: (providerID, id) => Effect.succeed(catalog.find((item) => item.providerID === providerID && item.id === id)),
  available: () => Effect.succeed(catalog),
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Agent.node,
      PluginHooks.node,
      SessionContext.node,
      Form.node,
      SessionNextSteps.node,
    ]),
    [
      llmClient.replace(client),
      Model.node.replace(modelCatalog),
      SessionRunnerModel.node.replace(models),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
      PluginSupervisor.node.replace(Layer.empty),
      Permission.node.replace(
        Layer.mock(Permission.Service, {
          forSession: (sessionID) => Effect.succeed(pendingPermissions.filter((item) => item.sessionID === sessionID)),
        }),
      ),
    ],
  ),
)

const ref = (id: string, variant?: string) =>
  Model.Ref.make({
    providerID: provider,
    id: Model.ID.make(id),
    ...(variant ? { variant: Model.VariantID.make(variant) } : {}),
  })

const insertSession = (id: Session.ID, model?: Model.Ref) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({ id, project_id: Project.ID.global, slug: id, directory: "/project", model, version: "test" })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const store = yield* SessionStore.Service
    const session = yield* store.get(id)
    if (!session) return yield* Effect.die(new Error("session not inserted"))
    return session
  })

const enableNextStepsAgent = (model?: Model.Ref) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* agents.transform((editor) => {
      editor.update(Agent.ID.make("next-steps"), (agent) => {
        agent.mode = "primary"
        agent.hidden = true
        agent.system = "Suggest next steps."
        if (model) agent.model = model
      })
    })
  })

const prompt = (sessionID: Session.ID, text: string) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const inboxID = SessionMessage.ID.create()
    yield* bus.publish(SessionEvent.InboxEnqueued, {
      sessionID,
      inboxID,
      item: { type: "user", payload: { text }, delivery: "steer" },
    })
    yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID })
  })

const zeroTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const step = (
  sessionID: Session.ID,
  content: { readonly text?: string; readonly tool?: boolean; readonly failed?: boolean },
) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const assistantMessageID = SessionMessage.ID.create()
    yield* bus.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      agent: Agent.ID.make("build"),
      model: ref("session-model"),
      started: 0,
    })
    if (content.text !== undefined) {
      yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
      yield* bus.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 0, text: content.text })
    }
    if (content.tool) {
      yield* bus.publish(SessionEvent.Tool.Input.Started, { sessionID, assistantMessageID, id: "call", name: "read" })
      yield* bus.publish(SessionEvent.Tool.Input.Ended, { sessionID, assistantMessageID, id: "call", text: "{}" })
      yield* bus.publish(SessionEvent.Tool.Called, {
        sessionID,
        assistantMessageID,
        id: "call",
        input: {},
        executed: false,
      })
    }
    if (content.failed)
      yield* bus.publish(SessionEvent.Step.Failed, {
        sessionID,
        assistantMessageID,
        error: { type: "provider.invalid-request", message: "Bad request" },
      })
    if (!content.failed)
      yield* bus.publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID,
        finish: "stop",
        cost: Money.USD.zero,
        tokens: zeroTokens,
      })
    return assistantMessageID
  })

const finishExecution = (sessionID: Session.ID, outcome: "succeeded" | "failed" | "interrupted" = "succeeded") =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    if (outcome === "succeeded") yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID })
    if (outcome === "failed")
      yield* bus.publish(SessionEvent.Execution.Failed, { sessionID, error: { type: "unknown", message: "Boom" } })
    if (outcome === "interrupted") yield* bus.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: "user" })
    const store = yield* SessionStore.Service
    const idle = (yield* store.messages({ sessionID, type: "idle", limit: 1 }))[0]
    if (!idle) return yield* Effect.die(new Error("idle message not projected"))
    return idle.id
  })

const conversation = (sessionID: Session.ID, text = "Fix the failing build", answer = "The build passes now.") =>
  Effect.gen(function* () {
    yield* enableNextStepsAgent()
    yield* insertSession(sessionID, ref("session-model", "high"))
    yield* prompt(sessionID, text)
    const messageID = yield* step(sessionID, { text: answer })
    const idleID = yield* finishExecution(sessionID)
    return { sessionID, messageID, idleID }
  })

const generate = (target: SessionNextSteps.Target) =>
  Effect.gen(function* () {
    const nextSteps = yield* SessionNextSteps.Service
    return yield* nextSteps.generate(target)
  })

const sessionInfo = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    return yield* store.get(sessionID)
  })

const requestText = (request: LLMRequest | undefined) => JSON.stringify(request?.messages ?? [])

beforeEach(() => {
  resolved = []
  requests = []
  pendingPermissions = []
  nextStepsStream = () => reply(JSON.stringify({ nextSteps: ["Run the tests", "Show me the diff"] }))
})

it.effect("selects the session model with a minimal reasoning variant", () =>
  Effect.gen(function* () {
    yield* enableNextStepsAgent()
    const session = yield* insertSession(Session.ID.make("ses_next_steps_minimal"), ref("session-model", "high"))
    const context = yield* SessionContext.Service

    const selected = yield* context.selectNextSteps(session)

    expect(selected?.agent.id).toBe(Agent.ID.make("next-steps"))
    expect(selected?.model.ref).toEqual(ref("session-model", "low"))
  }),
)

it.effect("keeps the session variant when no minimal variant exists", () =>
  Effect.gen(function* () {
    yield* enableNextStepsAgent()
    const session = yield* insertSession(Session.ID.make("ses_next_steps_plain"), ref("plain-model", "max"))
    const context = yield* SessionContext.Service

    const selected = yield* context.selectNextSteps(session)

    expect(selected?.model.ref).toEqual(ref("plain-model", "max"))
  }),
)

it.effect("uses the explicit next-steps model and variant", () =>
  Effect.gen(function* () {
    yield* enableNextStepsAgent(ref("override-model", "fast"))
    const session = yield* insertSession(Session.ID.make("ses_next_steps_override"), ref("session-model", "high"))
    const context = yield* SessionContext.Service

    const selected = yield* context.selectNextSteps(session)

    expect(selected?.model.ref).toEqual(ref("override-model", "fast"))
  }),
)

it.effect("returns nothing when the explicit model cannot be resolved", () =>
  Effect.gen(function* () {
    yield* enableNextStepsAgent(ref("missing-model"))
    const session = yield* insertSession(Session.ID.make("ses_next_steps_missing"), ref("session-model", "high"))
    const context = yield* SessionContext.Service

    const selected = yield* context.selectNextSteps(session)

    expect(selected).toBeUndefined()
    expect(resolved.map((item) => item?.id)).not.toContain(Model.ID.make("session-model"))
  }),
)

it.effect("returns nothing when the next-steps agent is disabled", () =>
  Effect.gen(function* () {
    yield* enableNextStepsAgent()
    const agents = yield* Agent.Service
    yield* agents.transform((editor) => editor.remove(Agent.ID.make("next-steps")))
    const session = yield* insertSession(Session.ID.make("ses_next_steps_disabled"), ref("session-model", "high"))
    const context = yield* SessionContext.Service

    const selected = yield* context.selectNextSteps(session)

    expect(selected).toBeUndefined()
  }),
)

it.effect("returns parsed next steps for the latest successful reply", () =>
  Effect.gen(function* () {
    const target = yield* conversation(Session.ID.make("ses_next_steps_success"))

    expect(yield* generate(target)).toEqual(["Run the tests", "Show me the diff"])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.tools).toEqual([])
    expect(requestText(requests[0])).toContain("The build passes now.")
    expect(requests[0]?.system.map((part) => part.text).join("\n")).toContain('{"nextSteps": ["..."]}')
  }),
)

it.effect("records next-steps usage on the session", () =>
  Effect.gen(function* () {
    const target = yield* conversation(Session.ID.make("ses_next_steps_usage"))

    yield* generate(target)

    const session = yield* sessionInfo(target.sessionID)
    expect(session?.tokens).toEqual({ input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } })
    expect(session?.cost).toBeCloseTo(0.0000233)
  }),
)

it.effect("records usage when generation is interrupted", () =>
  Effect.gen(function* () {
    const target = yield* conversation(Session.ID.make("ses_next_steps_interrupted"))
    const started = yield* Deferred.make<void>()
    nextStepsStream = () =>
      Stream.concat(
        Stream.make(stepFinish),
        Stream.unwrap(Deferred.succeed(started, undefined).pipe(Effect.as(Stream.never))),
      )

    const fiber = yield* generate(target).pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)

    const session = yield* sessionInfo(target.sessionID)
    expect(session?.tokens).toEqual({ input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } })
  }),
)

it.effect("returns nothing after the timeout", () =>
  Effect.gen(function* () {
    const target = yield* conversation(Session.ID.make("ses_next_steps_timeout"))
    const started = yield* Deferred.make<void>()
    nextStepsStream = () => Stream.unwrap(Deferred.succeed(started, undefined).pipe(Effect.as(Stream.never)))

    const fiber = yield* generate(target).pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    yield* TestClock.adjust("30 seconds")

    expect(yield* Fiber.join(fiber)).toEqual([])
  }),
)

it.effect("returns nothing when the provider fails", () =>
  Effect.gen(function* () {
    const target = yield* conversation(Session.ID.make("ses_next_steps_provider_failure"))
    nextStepsStream = () =>
      Stream.fail(
        new AIError({
          reason: new TransportError({ message: "Disconnected", transport: "http", operation: "request" }),
        }),
      )

    expect(yield* generate(target)).toEqual([])
  }),
)

const outputs: ReadonlyArray<readonly [string, string, ReadonlyArray<string>]> = [
  ["a plain object", '{"nextSteps":["Run the tests"]}', ["Run the tests"]],
  ["a json fence", '```json\n{"nextSteps":["Run the tests"]}\n```', ["Run the tests"]],
  ["a sentence before the object", 'Here you go: {"nextSteps":["Run the tests"]}', ["Run the tests"]],
  ["invalid JSON", '{"nextSteps":["Run the tests"', []],
  ["the wrong shape", '{"steps":["Run the tests"]}', []],
  [
    "duplicates and blanks",
    JSON.stringify({ nextSteps: [" Run the tests ", "", "Run the tests", "   ", "Show me the diff"] }),
    ["Run the tests", "Show me the diff"],
  ],
  [
    "more than three entries",
    JSON.stringify({ nextSteps: ["One", "Two", "Three", "Four", "Five"] }),
    ["One", "Two", "Three"],
  ],
  ["an overlong entry", JSON.stringify({ nextSteps: ["x".repeat(201), "Run the tests"] }), ["Run the tests"]],
]

outputs.forEach(([name, text, expected], index) =>
  it.effect(`parses model output with ${name}`, () =>
    Effect.gen(function* () {
      const target = yield* conversation(Session.ID.make(`ses_next_steps_output_${index}`))
      nextStepsStream = () => reply(text)

      expect(yield* generate(target)).toEqual(expected)
    }),
  ),
)

type Target = SessionNextSteps.Target
const ineligible: ReadonlyArray<
  readonly [
    string,
    (
      target: Target,
    ) => Effect.Effect<Target, unknown, Bus.Service | Database.Service | Form.Service | SessionStore.Service>,
  ]
> = [
  [
    "the session is archived",
    (target) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .update(SessionTable)
          .set({ time_archived: 1 })
          .where(eq(SessionTable.id, target.sessionID))
          .run()
          .pipe(Effect.orDie)
        return target
      }),
  ],
  [
    "a revert is staged",
    (target) =>
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        yield* bus.publish(SessionEvent.RevertEvent.Staged, {
          sessionID: target.sessionID,
          revert: { messageID: target.messageID, files: [] },
        })
        return target
      }),
  ],
  [
    "an inbox item is pending",
    (target) =>
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        yield* bus.publish(SessionEvent.InboxEnqueued, {
          sessionID: target.sessionID,
          inboxID: SessionMessage.ID.create(),
          item: { type: "user", payload: { text: "Also update docs" }, delivery: "queue" },
        })
        return target
      }),
  ],
  [
    "a form is pending",
    (target) =>
      Effect.gen(function* () {
        const forms = yield* Form.Service
        yield* forms.create({
          sessionID: target.sessionID,
          title: "Questions",
          fields: [{ key: "runtime", type: "string" }],
        })
        return target
      }),
  ],
  [
    "a permission is pending",
    (target) =>
      Effect.sync(() => {
        pendingPermissions = [
          { id: Permission.ID.create(), sessionID: target.sessionID, action: "edit", resources: ["src/index.ts"] },
        ]
        return target
      }),
  ],
  [
    "the target is no longer the latest idle",
    (target) =>
      Effect.gen(function* () {
        yield* prompt(target.sessionID, "Now update the changelog")
        yield* step(target.sessionID, { text: "Updated." })
        yield* finishExecution(target.sessionID)
        return target
      }),
  ],
  [
    "a message follows the idle",
    (target) => prompt(target.sessionID, "Now update the changelog").pipe(Effect.as(target)),
  ],
  [
    "the message is not the latest reply",
    (target) =>
      Effect.gen(function* () {
        const messageID = target.messageID
        yield* prompt(target.sessionID, "Now update the changelog")
        yield* step(target.sessionID, { text: "Updated." })
        const idleID = yield* finishExecution(target.sessionID)
        return { ...target, messageID, idleID }
      }),
  ],
]

ineligible.forEach(([name, change], index) =>
  it.effect(`returns nothing when ${name}`, () =>
    Effect.gen(function* () {
      const target = yield* change(yield* conversation(Session.ID.make(`ses_next_steps_ineligible_${index}`)))

      expect(yield* generate(target)).toEqual([])
      expect(requests).toHaveLength(0)
    }),
  ),
)

const executions: ReadonlyArray<
  readonly [
    string,
    { readonly text?: string; readonly tool?: boolean; readonly failed?: boolean },
    "succeeded" | "failed" | "interrupted",
  ]
> = [
  ["the execution failed", { text: "Partial answer" }, "failed"],
  ["the execution was interrupted", { text: "Partial answer" }, "interrupted"],
  ["the reply failed", { text: "Partial answer", failed: true }, "succeeded"],
  ["the reply has no text", { tool: true }, "succeeded"],
]

executions.forEach(([name, content, outcome], index) =>
  it.effect(`returns nothing when ${name}`, () =>
    Effect.gen(function* () {
      const sessionID = Session.ID.make(`ses_next_steps_execution_${index}`)
      yield* enableNextStepsAgent()
      yield* insertSession(sessionID, ref("session-model", "high"))
      yield* prompt(sessionID, "Fix the failing build")
      yield* step(sessionID, { text: "Let me look." })
      const messageID = yield* step(sessionID, content)
      const idleID = yield* finishExecution(sessionID, outcome)

      expect(yield* generate({ sessionID, messageID, idleID })).toEqual([])
      expect(requests).toHaveLength(0)
    }),
  ),
)

it.effect("returns nothing when the reply belongs to an earlier execution", () =>
  Effect.gen(function* () {
    const target = yield* conversation(Session.ID.make("ses_next_steps_earlier_execution"))
    yield* prompt(target.sessionID, "Rerun the checks")
    const idleID = yield* finishExecution(target.sessionID)

    expect(yield* generate({ ...target, idleID })).toEqual([])
    expect(requests).toHaveLength(0)
  }),
)

it.effect("returns nothing when the next-steps agent is removed", () =>
  Effect.gen(function* () {
    const target = yield* conversation(Session.ID.make("ses_next_steps_agent_removed"))
    const agents = yield* Agent.Service
    yield* agents.transform((editor) => editor.remove(Agent.ID.make("next-steps")))

    expect(yield* generate(target)).toEqual([])
    expect(requests).toHaveLength(0)
  }),
)

it.effect("returns nothing when the target becomes stale during generation", () =>
  Effect.gen(function* () {
    const target = yield* conversation(Session.ID.make("ses_next_steps_stale"))
    const bus = yield* Bus.Service
    nextStepsStream = () =>
      Stream.unwrap(
        prompt(target.sessionID, "Actually, deploy it").pipe(
          Effect.provideService(Bus.Service, bus),
          Effect.as(reply(JSON.stringify({ nextSteps: ["Run the tests"] }))),
        ),
      )

    expect(yield* generate(target)).toEqual([])
  }),
)

it.effect("keeps the target reply and its user request when history exceeds the budget", () =>
  Effect.gen(function* () {
    const sessionID = Session.ID.make("ses_next_steps_budget")
    yield* enableNextStepsAgent()
    yield* insertSession(sessionID, ref("session-model", "high"))
    yield* Effect.forEach(
      Array.from({ length: 10 }, (_, index) => index),
      (index) =>
        Effect.gen(function* () {
          yield* prompt(sessionID, `old-request-${index} ${"q".repeat(1_500)}`)
          yield* step(sessionID, { text: `old-reply-${index} ${"a".repeat(1_500)}` })
          yield* finishExecution(sessionID)
        }),
    )
    yield* prompt(sessionID, `FINAL-REQUEST ${"r".repeat(6_000)}`)
    const messageID = yield* step(sessionID, { text: `${"s".repeat(12_000)} FINAL-REPLY` })
    const idleID = yield* finishExecution(sessionID)

    yield* generate({ sessionID, messageID, idleID })

    const text = requestText(requests[0])
    expect(text).toContain("FINAL-REQUEST")
    expect(text).toContain("FINAL-REPLY")
    expect(text).not.toContain("old-request-0")
    expect(text.length).toBeLessThan(17_000)
  }),
)
