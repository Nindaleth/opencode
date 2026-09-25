import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionCost } from "@opencode/core/session/cost"
import { SessionEvent } from "@opencode/core/session/event"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/core/session/message"
import { Agent } from "@opencode/core/agent"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Money } from "@opencode/schema/money"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionInbox.node]), [
    Bus.node.replace(Bus.configured({ persist: true })),
  ]),
)
const root = Session.ID.make("ses_cost_root")
const child = Session.ID.make("ses_cost_child")
const grandchild = Session.ID.make("ses_cost_grandchild")
const agent = Agent.ID.make("build")
const firstModel = Model.Ref.parse("test/first")
const secondModel = Model.Ref.parse("test/second")
const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }

const setup = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const bus = yield* Bus.Service
  const inbox = yield* SessionInbox.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
  for (const [id, parentID] of [
    [root, undefined],
    [child, root],
    [grandchild, child],
  ] as const) {
    yield* bus.publish(SessionEvent.Created, {
      sessionID: id,
      parentID,
      projectID: Project.ID.global,
      location: { directory: AbsolutePath.make("/project") },
      slug: id,
      title: "cost test",
      version: "test",
    })
  }
  const prompt = (id: SessionMessage.ID, text: string, delivery: "queue" | "steer" = "queue") =>
    Effect.gen(function* () {
      yield* inbox.admit({ id, sessionID: root, item: { type: "user", payload: { text }, delivery } })
      yield* bus.publish(SessionEvent.InboxDelivered, { sessionID: root, inboxID: id })
    })
  const spend = (id: Session.ID, cost: number) =>
    bus.publish(SessionEvent.UsageRecorded, { sessionID: id, source: "compaction", cost: Money.USD.make(cost), tokens })
  const step = (id: Session.ID, cost: number, selected = firstModel) =>
    Effect.gen(function* () {
      const messageID = SessionMessage.ID.create()
      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID: id,
        assistantMessageID: messageID,
        agent,
        model: selected,
        started: 0,
      })
      yield* bus.publish(SessionEvent.Step.Ended, {
        sessionID: id,
        assistantMessageID: messageID,
        finish: "stop",
        cost: Money.USD.make(cost),
        tokens,
      })
    })
  const snapshot = (id: Session.ID) => SessionCost.snapshot({ sessionID: id, agent, model: secondModel, step: 2 })
  return { bus, inbox, prompt, spend, step, snapshot }
})

describe("per-prompt settled cost", () => {
  it.effect("resets on a delivered root user prompt, preserving model and counting nested descendant spend", () =>
    Effect.gen(function* () {
      const s = yield* setup
      const first = SessionMessage.ID.make("msg_cost_first")
      yield* s.bus.publish(SessionEvent.ModelSelected, { sessionID: root, model: firstModel })
      yield* s.prompt(first, "first")
      expect(yield* s.snapshot(root)).toMatchObject({
        rootUserMessageID: first,
        rootModel: firstModel,
        first: true,
        cost: { root: 0, descendants: 0 },
      })
      yield* s.step(root, 3)
      yield* s.step(child, 4)
      const second = SessionMessage.ID.make("msg_cost_second")
      yield* TestClock.setTime(1000)
      yield* s.prompt(second, "second", "steer")
      yield* s.step(root, 1.25)
      yield* s.bus.publish(SessionEvent.ModelSelected, { sessionID: root, model: secondModel, previous: firstModel })
      yield* s.step(child, 2)
      yield* s.spend(grandchild, 0.5)
      expect(yield* s.snapshot(child)).toMatchObject({
        rootID: root,
        rootUserMessageID: second,
        rootModel: firstModel,
        first: false,
        cost: { session: 2, root: 1.25, descendants: 2.5 },
      })
    }),
  )

  it.effect("includes equal-time child usage and compaction but does not reset on a synthetic delivery", () =>
    Effect.gen(function* () {
      const s = yield* setup
      yield* s.bus.publish(SessionEvent.ModelSelected, { sessionID: root, model: firstModel })
      const userID = SessionMessage.ID.make("msg_cost_same_time")
      yield* TestClock.setTime(1000)
      yield* s.prompt(userID, "hello")
      yield* s.spend(child, 0.75)
      yield* s.spend(root, 0.25)
      const syntheticID = SessionMessage.ID.make("msg_cost_synthetic")
      yield* s.inbox.admit({
        id: syntheticID,
        sessionID: root,
        item: { type: "synthetic", payload: { text: "guidance" }, delivery: "steer" },
      })
      yield* s.bus.publish(SessionEvent.InboxDelivered, { sessionID: root, inboxID: syntheticID })
      expect(yield* s.snapshot(root)).toMatchObject({
        rootUserMessageID: userID,
        cost: { root: 0.25, descendants: 0.75 },
        first: true,
      })
    }),
  )

  it.effect("skips a missing root prompt or session", () =>
    Effect.gen(function* () {
      const s = yield* setup
      expect(yield* s.snapshot(root)).toBeUndefined()
      expect(yield* s.snapshot(Session.ID.make("ses_missing"))).toBeUndefined()
    }),
  )

  it.effect("counts priced failed Steps but ignores a failed Step without a price", () =>
    Effect.gen(function* () {
      const s = yield* setup
      yield* s.prompt(SessionMessage.ID.make("msg_failed_step_prompt"), "hello")
      const priced = SessionMessage.ID.create()
      yield* s.bus.publish(SessionEvent.Step.Failed, {
        sessionID: root,
        assistantMessageID: priced,
        error: { type: "unknown", message: "provider failed" },
        cost: Money.USD.make(0.5),
        tokens,
      })
      const unpriced = SessionMessage.ID.create()
      yield* s.bus.publish(SessionEvent.Step.Failed, {
        sessionID: root,
        assistantMessageID: unpriced,
        error: { type: "unknown", message: "provider failed" },
      })
      expect(yield* s.snapshot(root)).toMatchObject({ cost: { root: 0.5, descendants: 0 } })
    }),
  )
})
