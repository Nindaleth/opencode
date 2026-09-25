import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer, RcMap, Scope } from "effect"
import { Money } from "@opencode/schema/money"
import { Agent } from "@opencode/core/agent"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Instance } from "@opencode/core/instance/service"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionArtifact } from "@opencode/core/session/artifact"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { SessionEnvironment } from "@opencode/core/session/environment"
import { LocationServiceMap } from "@opencode/core/location-services"
import { Global } from "@opencode/util/global"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"

const closed: Session.ID[] = []
const transportScopes = new Set<Scope.Scope>()
const transport = Layer.effect(
  SessionModelTransport.Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    transportScopes.add(scope)
    yield* Effect.addFinalizer(() => Effect.sync(() => transportScopes.delete(scope)))
    return SessionModelTransport.Service.of({
      bind: () => ({ execute: () => Effect.die("Unexpected WebSocket execution") }),
      close: (sessionID) => Effect.sync(() => closed.push(sessionID)),
      closeAll: Effect.void,
    })
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      SessionEnvironment.node,
      Session.node,
      Instance.node,
      LocationServiceMap.node,
    ]),
    [
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
      SessionModelTransport.node.replace(transport),
      offlineModels,
    ],
  ),
)
const artifactIt = testEffect(Layer.empty)

describe("Session.remove", () => {
  artifactIt.live(
    "Deleting a parent left its artifact directory behind while its fork needed an independent copy",
    () =>
      Effect.gen(function* () {
        const temporary = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const sessions = yield* Session.Service
          const artifacts = yield* SessionArtifact.Service
          const bus = yield* Bus.Service
          const parent = yield* sessions.create({
            location: Location.Ref.make({ directory: AbsolutePath.make(temporary.path) }),
          })
          const ref = yield* artifacts.write(parent.id, {
            name: "report.zip",
            mime: "application/zip",
            bytes: Uint8Array.of(42),
          })
          const assistantMessageID = SessionMessage.ID.create()
          yield* bus.publish(SessionEvent.Step.Started, {
            sessionID: parent.id,
            assistantMessageID,
            agent: Agent.defaultID,
            model: { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") },
            started: 0,
          })
          yield* bus.publish(SessionEvent.Tool.Input.Started, {
            sessionID: parent.id,
            assistantMessageID,
            id: "call_artifact",
            name: "tool",
          })
          yield* bus.publish(SessionEvent.Tool.Called, {
            sessionID: parent.id,
            assistantMessageID,
            id: "call_artifact",
            input: {},
            executed: false,
          })
          yield* bus.publish(SessionEvent.Tool.Success, {
            sessionID: parent.id,
            assistantMessageID,
            id: "call_artifact",
            content: [{ type: "text", text: "download" }],
            artifacts: [ref],
            executed: false,
          })
          yield* bus.publish(SessionEvent.Step.Ended, {
            sessionID: parent.id,
            assistantMessageID,
            finish: "stop",
            cost: Money.USD.make(0),
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
          const fork = yield* sessions.fork({ sessionID: parent.id })
          yield* sessions.remove(parent.id)
          expect(
            yield* Effect.promise(() => Bun.file(path.join(temporary.path, "blob", parent.id, ref.key)).exists()),
          ).toBe(false)
          expect(yield* artifacts.read(fork.id, ref.key)).toEqual(Uint8Array.of(42))
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([
                Database.node,
                Bus.node,
                SessionProjector.node,
                SessionStore.node,
                SessionArtifact.node,
                Session.node,
              ]),
              [
                Global.node.replace(Global.layerWith({ data: temporary.path })),
                Bus.node.replace(Bus.configured({ persist: true })),
                Project.node.replace(globalProjectNode),
                SessionExecution.node.replace(SessionExecution.noopLayer),
                SessionModelTransport.node.replace(transport),
                offlineModels,
              ],
            ),
          ),
        )
      }),
  )
  it.effect("removes a session and its children", () =>
    Effect.gen(function* () {
      const temporary = yield* tmpdirScoped()
      const location = Location.Ref.make({ directory: AbsolutePath.make(temporary.path) })
      const session = yield* Session.Service
      const parent = yield* session.create({ location })
      const child = yield* session.create({ parentID: parent.id })
      yield* session.environment({ sessionID: parent.id, variables: { SESSION_ENV: "parent" } })
      yield* session.environment({ sessionID: child.id, variables: { SESSION_ENV: "child" } })
      const locations = yield* LocationServiceMap.Service
      yield* Effect.acquireRelease(locations.contextEffect(location), () => locations.invalidate(location))
      closed.length = 0

      yield* session.remove(parent.id)

      expect((yield* session.list()).data).toEqual([])
      expect(closed).toEqual([parent.id, child.id])
      const environments = yield* SessionEnvironment.Service
      expect(yield* environments.get(parent.id)).toBeUndefined()
      expect(yield* environments.get(child.id)).toBeUndefined()
      expect(yield* Effect.result(session.get(parent.id))).toMatchObject({ _tag: "Failure" })
      expect(yield* Effect.result(session.get(child.id))).toMatchObject({ _tag: "Failure" })
    }),
  )

  it.live("removes unloaded sessions and children without initializing an instance", () =>
    Effect.gen(function* () {
      const temporary = yield* tmpdirScoped()
      const sessions = yield* Session.Service
      const locations = yield* LocationServiceMap.Service
      const parent = yield* sessions.create({
        location: Location.Ref.make({ directory: AbsolutePath.make(temporary.path) }),
      })
      const child = yield* sessions.create({ parentID: parent.id })
      closed.length = 0
      expect(Array.from(yield* RcMap.keys(locations.rcMap))).toEqual([])

      yield* sessions.remove(parent.id)

      expect(closed).toEqual([parent.id, child.id])
      expect(transportScopes.size).toBe(1)
      expect(Array.from(yield* RcMap.keys(locations.rcMap))).toEqual([])
      expect((yield* sessions.list()).data).toEqual([])
    }),
  )

  it.effect("fails when the session does not exist", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const sessionID = Session.ID.make("ses_missing")

      expect(yield* Effect.result(session.remove(sessionID))).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "Session.NotFoundError", sessionID },
      })
    }),
  )
})
