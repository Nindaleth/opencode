import { expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Session } from "@opencode/core/session"
import { SessionArtifact } from "@opencode/core/session/artifact"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { Agent } from "@opencode/core/agent"
import { AbsolutePath } from "@opencode/core/schema"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Context, Effect, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/unstable/http"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { createEmbeddedRoutes } from "../src/routes"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"

it.live("Artifact downloads were accessible from unrelated sessions and messages", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-artifact-http-")))
    const context = yield* Layer.build(
      createEmbeddedRoutes(
        {
          app: { version: "test" },
          database: { path: ":memory:" },
          fs: { filewatcher: false },
          models: { fetch: false },
        },
        [Global.node.replace(Global.layerWith({ data: tmp.path }))],
      ).pipe(Layer.provide(HttpServer.layerServices)),
    )
    const handler = Context.get(context, HttpRouter.HttpRouter)
      .asHttpEffect()
      .pipe(HttpEffect.toWebHandlerWith(context))
    const sessions = Context.get(context, Session.Service)
    const artifacts = Context.get(context, SessionArtifact.Service)
    const bus = Context.get(context, Bus.Service)
    const first = yield* sessions.create({ location: { directory: AbsolutePath.make(tmp.path) } })
    const second = yield* sessions.create({ location: { directory: AbsolutePath.make(tmp.path) } })
    const messageID = SessionMessage.ID.create()
    const ref = yield* artifacts.write({
      name: "annual report.zip",
      mime: "application/zip",
      bytes: Uint8Array.of(0, 42, 255),
    })
    yield* bus.publish(SessionEvent.Step.Started, {
      sessionID: first.id,
      assistantMessageID: messageID,
      agent: Agent.defaultID,
      model: { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") },
      started: 0,
    })
    yield* bus.publish(SessionEvent.Tool.Input.Started, {
      sessionID: first.id,
      assistantMessageID: messageID,
      id: "call-1",
      name: "server_tool",
    })
    yield* bus.publish(SessionEvent.Tool.Called, {
      sessionID: first.id,
      assistantMessageID: messageID,
      id: "call-1",
      input: {},
      executed: false,
    })
    yield* bus.publish(SessionEvent.Tool.Success, {
      sessionID: first.id,
      assistantMessageID: messageID,
      id: "call-1",
      content: [{ type: "text", text: "download" }],
      artifacts: [ref],
      executed: false,
    })
    const fetch = (sessionID: string, id: string, key: string) =>
      Effect.promise(() =>
        handler(new Request(`http://opencode.local/api/session/${sessionID}/message/${id}/artifact/${key}`)),
      )
    const owned = yield* fetch(first.id, messageID, ref.key)
    const projected = yield* sessions.message({ sessionID: first.id, messageID })
    expect(projected?.type).toBe("assistant")
    if (projected?.type !== "assistant") throw new Error("Expected assistant message")
    expect(projected.content).toContainEqual({
      type: "artifact",
      ...ref,
    })
    expect(owned.status).toBe(200)
    expect(owned.headers.get("content-type")).toContain("application/zip")
    expect(owned.headers.get("content-disposition")).toContain("attachment;")
    expect(owned.headers.get("content-disposition")).toContain("annual%20report.zip")
    expect(new Uint8Array(yield* Effect.promise(() => owned.arrayBuffer()))).toEqual(Uint8Array.of(0, 42, 255))
    expect((yield* fetch(second.id, messageID, ref.key)).status).toBe(404)
    expect((yield* fetch(first.id, SessionMessage.ID.create(), ref.key)).status).toBe(404)
    expect((yield* fetch(first.id, messageID, "blob_unknown")).status).toBe(404)
    expect((yield* fetch(Session.ID.create(), messageID, ref.key)).status).toBe(404)
    yield* Effect.promise(() => Bun.file(`${tmp.path}/blob/${ref.key}`).delete())
    expect((yield* fetch(first.id, messageID, ref.key)).status).toBe(404)
  }).pipe(Effect.scoped),
)
