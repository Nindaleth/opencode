import { describe, expect } from "bun:test"
import { DateTime, Duration, Effect, Layer, LayerMap } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { SessionPromptPreview } from "@opencode/core/session/prompt-preview"
import { testEffect } from "./lib/effect"
import { Instance } from "@opencode/core/instance"
import { tempGlobalLayer } from "./fixture/global"
import { Global } from "@opencode/util/global"
import { offlineModels } from "./fixture/models"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { LocationServiceMap } from "@opencode/core/location-services"
import { Provider } from "@opencode/core/provider"
import { Model } from "@opencode/core/model"
import { Agent } from "@opencode/core/agent"
import { Plugin } from "@opencode/core/plugin"
import { SessionContext } from "@opencode/core/session/context"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionSchema } from "@opencode/core/session/schema"
import { Instructions } from "../src/instructions/index"
import { Money } from "@opencode/schema/money"
import { fromPromise } from "@opencode/plugin/promise/adapter"

const instances = Layer.effect(
  LocationServiceMap.Service,
  Effect.gen(function* () {
    const map = yield* LayerMap.make(
      (ref: Location.Ref) => Instance.layer(ref, { discovery: false, replacements: bindings }),
      { idleTimeToLive: Duration.infinity },
    )
    const bindings: LayerNode.Replacements = [
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      LocationServiceMap.node.replace(Layer.succeed(LocationServiceMap.Service, map)),
      Instance.node.replace(
        Layer.succeed(Instance.Service, { provide: (session) => Effect.provide(map.get(session.location)) }),
      ),
    ]
    return map
  }),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, LocationServiceMap.node]), [
    Global.node.replace(tempGlobalLayer),
    offlineModels,
    LocationServiceMap.node.replace(instances),
  ]),
)

describe("SessionPromptPreview", () => {
  it.live("DCP's stored-session lookup no longer breaks previews", () =>
    Effect.gen(function* () {
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        yield* plugins.awaitActivation
        yield* plugins.activate([
          {
            ...fromPromise({
              id: "opencode-dcp",
              async setup(ctx) {
                await ctx.session.hook("context", async (event) => {
                  await ctx.session.get({ sessionID: event.sessionID })
                  event.system.push({ type: "text", text: "DCP instructions" })
                })
                await ctx.tool.transform((editor) =>
                  editor.add({
                    name: "compress",
                    description: "Compress conversation history",
                    input: { type: "object", properties: {} },
                    options: { codemode: false },
                    execute: async () => ({ content: [] }),
                  }),
                )
              },
            }),
            revision: "1",
          },
          {
            id: "preview-overrides",
            revision: "1",
            effect: (ctx) =>
              Effect.gen(function* () {
                yield* ctx.session.hook("context", (event) =>
                  Effect.sync(() => event.system.push({ type: "text", text: "Preview instructions" })),
                )
                yield* ctx.tool.hook("definition", (event) =>
                  Effect.sync(() => {
                    if (event.toolID === "compress") event.description = "Overridden compression description"
                  }),
                )
              }),
          },
        ])
        const agents = yield* Agent.Service
        yield* agents.transform((editor) => editor.update(Agent.ID.make("build"), (agent) => (agent.mode = "primary")))
        const providers = yield* Provider.Service
        const providerID = Provider.ID.make("test")
        yield* providers.transform((editor) =>
          editor.add({
            info: {
              ...Provider.Info.empty(providerID),
              activation: "enabled",
              package: "@opencode/ai/providers/openai-compatible",
              settings: { baseURL: "https://example.test/v1" },
            },
            models: [Model.Info.default(providerID, Model.ID.make("gpt-5"))],
          }),
        )
        const preview = yield* SessionPromptPreview.Service
        const result = yield* preview.prepare({ provider: "test", model: "gpt-5" })
        expect(result.system).toContain("Preview instructions")
        expect(result.system).not.toContain("DCP instructions")
        expect(result.tools).toContainEqual({ name: "compress", description: "Overridden compression description" })
      }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make("/tmp") }))))
    }),
  )
  it.effect("uses the default agent and model and returns the same prepared initial request", () =>
    Effect.gen(function* () {
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const providers = yield* Provider.Service
        const providerID = Provider.ID.make("test")
        yield* providers.transform((editor) =>
          editor.add({
            info: {
              ...Provider.Info.empty(providerID),
              activation: "enabled",
              package: "@opencode/ai/providers/openai-compatible",
              settings: { baseURL: "https://example.test/v1" },
            },
            models: [Model.Info.default(providerID, Model.ID.make("gpt-5"))],
          }),
        )
        const preview = yield* SessionPromptPreview.Service
        const plugins = yield* Plugin.Service
        yield* plugins.awaitActivation
        const result = yield* preview.prepare({})
        expect(result.selection.agent).toBe("build")
        expect(result.selection.provider).toBeTruthy()
        expect(result.selection.model).toBeTruthy()
        expect(result.system[0]).toBeTruthy()
        expect(result.tools.some((tool) => tool.name === "read" && tool.description.length > 0)).toBeTrue()
        const context = yield* SessionContext.Service
        const location = yield* Location.Service
        const session = SessionSchema.Info.make({
          id: SessionSchema.ID.create(),
          projectID: location.project.id,
          location: Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }),
          agent: Agent.ID.make("build"),
          cost: Money.USD.zero,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        })
        const selected = yield* context.selectTransient(session)
        const resolved = yield* context.resolveModel(session)
        const observed = yield* Instructions.read(selected.instructions)
        const values = Object.fromEntries(
          observed.flatMap(({ key, value }) =>
            value === Instructions.unavailable || value === Instructions.removed ? [] : [[key, value]],
          ),
        )
        const transcript = SessionModelRequest.baseTranscript({
          agent: selected.agent.info,
          model: resolved,
          tools: selected.tools,
          initial: Instructions.renderInitial(selected.instructions, values),
          messages: [],
        })
        const prepared = yield* context.request.primary({
          session,
          agent: selected.agent.id,
          model: resolved,
          tools: selected.tools,
          system: transcript.system,
          messages: transcript.messages,
          preview: true,
        })
        expect(result.system[0]).toEqual(prepared.request.system[0]?.text)
        expect(result.system.slice(1).map((part) => part.replace(/ses_[a-zA-Z0-9]+/g, "SESSION"))).toEqual(
          prepared.request.system.slice(1).map((part) => part.text.replace(/ses_[a-zA-Z0-9]+/g, "SESSION")),
        )
        expect(result.tools).toEqual(
          prepared.request.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "" })),
        )
        expect(
          (yield* preview
            .prepare({ agent: "missing", provider: result.selection.provider, model: result.selection.model })
            .pipe(Effect.flip)).message,
        ).toContain("Agent not found")
        expect((yield* preview.prepare({ provider: "missing", model: "missing" }).pipe(Effect.flip)).message).toContain(
          "Model unavailable",
        )
      }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make("/tmp") }))))
    }),
  )
  it.effect("rejects partial selections without creating a session", () =>
    Effect.gen(function* () {
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const preview = yield* SessionPromptPreview.Service
        const result = yield* Effect.flip(preview.prepare({ provider: "test" }))
        expect(result.message).toContain("--provider and --model")
      }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make("/tmp") }))))
    }),
  )
})
