import { describe, expect } from "bun:test"
import { Event } from "@opencode/schema/config"
import { Deferred, Duration, Effect, Layer, LayerMap, Stream } from "effect"
import { TestClock } from "effect/testing"
import { define } from "@opencode/plugin/effect/plugin"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Command } from "@opencode/core/command"
import { ConfigPluginSource } from "@opencode/core/config/plugin/source"
import { Instance } from "@opencode/core/instance"
import { LocationServiceMap } from "@opencode/core/location-services"
import { Location } from "@opencode/core/location"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Model } from "@opencode/core/model"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { Agent } from "@opencode/core/agent"
import { Tool } from "@opencode/schema/tool"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { AbsolutePath } from "@opencode/core/schema"
import { Database } from "../../src/database/database"
import { Bus } from "../../src/bus"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { tmpdirScoped } from "../fixture/tmpdir"
import { advance } from "../lib/clock"
import { testEffect } from "../lib/effect"

const id = Plugin.ID.make("account-prompts")

// Host and instance plugins share one ID; each registers a distinct command so the winner is observable.
const greeter = (command: string, plugin: string = id) =>
  define({
    id: plugin,
    effect: (ctx) =>
      ctx.command.transform((editor) => editor.add({ name: command, execute: () => Effect.void })).pipe(Effect.asVoid),
  })

// Every supervisor activation scans the config plugin operations once, so counting scans counts activations.
const source: { activations: number; operations: ConfigPluginSource.Operation[] } = { activations: 0, operations: [] }
const sourceLayer = Layer.succeed(
  ConfigPluginSource.Service,
  ConfigPluginSource.Service.of({
    operations: () =>
      Effect.sync(() => {
        source.activations++
        return source.operations
      }),
    changes: () => Stream.never,
  }),
)

const instances = Layer.effect(
  LocationServiceMap.Service,
  Effect.gen(function* () {
    const map = yield* LayerMap.make(
      (ref: Location.Ref) =>
        Instance.layer(ref, { discovery: false, plugins: [greeter("instance-greet")], replacements: bindings }),
      { idleTimeToLive: Duration.infinity },
    )
    const bindings: LayerNode.Replacements = [
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      ConfigPluginSource.node.replace(sourceLayer),
      LocationServiceMap.node.replace(Layer.succeed(LocationServiceMap.Service, map)),
      Instance.node.replace(
        Layer.succeed(Instance.Service, {
          provide: (session) => Effect.provide(map.get(session.location)),
        }),
      ),
    ]
    return map
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SdkPlugins.node, Session.node, LocationServiceMap.node]),
    [Global.node.replace(tempGlobalLayer), offlineModels, LocationServiceMap.node.replace(instances)],
  ),
)

describe("PluginSupervisor", () => {
  it.live("activates and reloads the cost-limit builtin without npm resolution", () =>
    Effect.gen(function* () {
      source.operations = [{ type: "add", target: "cost-limit", options: { default: { parent: 5 } } }]
      const directory = yield* tmpdirScoped()
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const bus = yield* Bus.Service
        yield* plugins.awaitActivation
        expect(yield* plugins.list()).toContainEqual(
          expect.objectContaining({ id: "cost-limit", source: { type: "builtin" }, state: { status: "active" } }),
        )
        source.operations = [{ type: "add", target: "cost-limit", options: { default: { parent: 0 } } }]
        yield* bus.publish(Event.Updated, {})
        yield* Effect.sleep("150 millis")
        yield* plugins.awaitActivation
        expect(yield* plugins.list()).toContainEqual(
          expect.objectContaining({
            id: "cost-limit",
            source: { type: "builtin" },
            state: expect.objectContaining({ status: "failed" }),
          }),
        )
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
      source.operations = []
    }),
  )

  it.live("activates prompt overrides as a builtin and reports invalid sources", () =>
    Effect.gen(function* () {
      source.operations = [{ type: "add", target: "prompt-overrides", options: { model: { text: "replacement" } } }]
      const directory = yield* tmpdirScoped()
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const bus = yield* Bus.Service
        yield* plugins.awaitActivation
        expect(yield* plugins.list()).toContainEqual(
          expect.objectContaining({ id: "prompt-overrides", source: { type: "builtin" }, state: { status: "active" } }),
        )
        source.operations = [{ type: "add", target: "prompt-overrides", options: { model: { file: "missing" } } }]
        yield* bus.publish(Event.Updated, {})
        yield* Effect.sleep("150 millis")
        yield* plugins.awaitActivation
        expect(yield* plugins.list()).toContainEqual(
          expect.objectContaining({ id: "prompt-overrides", state: expect.objectContaining({ status: "failed" }) }),
        )
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
      source.operations = []
    }),
  )

  it.live("activates a configured router as a builtin without npm resolution", () =>
    Effect.gen(function* () {
      source.operations = [
        {
          type: "add",
          target: "subagent-router",
          options: { rules: [{ subagent: "explore", parentModel: "test/*", model: "test/child" }] },
        },
      ]
      const directory = yield* tmpdirScoped()
      const locations = yield* LocationServiceMap.Service
      const inventory = yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        yield* plugins.awaitActivation
        return yield* plugins.list()
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
      expect(inventory.filter((item) => item.id === "subagent-router")).toEqual([
        {
          id: Plugin.ID.make("subagent-router"),
          source: { type: "builtin" },
          state: { status: "active" },
          features: { server: true },
        },
      ])
      source.operations = []
    }),
  )

  it.live("orders router hooks with adjacent plugins and replaces or removes them on reload", () =>
    Effect.gen(function* () {
      const router = (model: string): ConfigPluginSource.Operation => ({
        type: "add",
        target: "subagent-router",
        options: { rules: [{ subagent: "explore", parentModel: "test/*", model }] },
      })
      source.operations = [router("test/first")]
      const sdk = yield* SdkPlugins.Service
      yield* sdk.register(
        define({
          id: "earlier-route",
          effect: (ctx) =>
            ctx.tool
              .hook("execute.before", (event) =>
                Effect.sync(() => {
                  if (event.tool === "subagent" && typeof event.input === "object" && event.input !== null)
                    event.input = { ...event.input, marker: "before-router" }
                }),
              )
              .pipe(Effect.asVoid),
        }),
      )
      const directory = yield* tmpdirScoped()
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const hooks = yield* PluginHooks.Service
        const bus = yield* Bus.Service
        const sessions = yield* Session.Service
        yield* plugins.awaitActivation
        const parent = yield* sessions.create({
          location: Location.Ref.make({ directory: AbsolutePath.make(directory.path) }),
          model: Model.Ref.parse("test/parent"),
        })
        const invoke = () =>
          hooks.trigger("tool", "execute.before", {
            tool: "subagent",
            input: { agent: "explore" },
            sessionID: parent.id,
            agent: Agent.ID.make("build"),
            messageID: SessionMessage.ID.make("msg_route"),
            id: Tool.CallID.make("call_route"),
          })
        expect((yield* invoke()).input).toEqual({ agent: "explore", marker: "before-router", model: "test/first" })
        expect(yield* plugins.list()).toContainEqual(
          expect.objectContaining({ id: "subagent-router", source: { type: "builtin" }, state: { status: "active" } }),
        )
        source.operations = [router("test/second")]
        yield* bus.publish(Event.Updated, {})
        yield* Effect.sleep("150 millis")
        yield* plugins.awaitActivation
        expect((yield* plugins.list()).filter((item) => item.id === "subagent-router")).toHaveLength(1)
        expect((yield* invoke()).input).toEqual({ agent: "explore", marker: "before-router", model: "test/second" })

        source.operations = []
        yield* bus.publish(Event.Updated, {})
        yield* Effect.sleep("150 millis")
        yield* plugins.awaitActivation
        expect((yield* plugins.list()).some((item) => item.id === "subagent-router")).toBeFalse()
        expect((yield* invoke()).input).toEqual({ agent: "explore", marker: "before-router" })
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
      source.operations = []
    }),
  )

  it.live("reports invalid router rules while continuing healthy plugin activation", () =>
    Effect.gen(function* () {
      source.operations = [{ type: "add", target: "subagent-router", options: { rules: [{ model: "bad" }] } }]
      const directory = yield* tmpdirScoped()
      const locations = yield* LocationServiceMap.Service
      const inventory = yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        yield* plugins.awaitActivation
        return yield* plugins.list()
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
      expect(inventory.find((item) => item.id === "subagent-router")).toMatchObject({
        source: { type: "builtin" },
        state: { status: "failed", error: expect.stringContaining("subagent") },
      })
      expect(
        inventory.some((item) => item.id === "opencode.tool.subagent" && item.state.status === "active"),
      ).toBeTrue()
      source.operations = []
    }),
  )

  it.live("uses the last configured router options when the target appears twice", () =>
    Effect.gen(function* () {
      source.operations = [
        {
          type: "add",
          target: "subagent-router",
          options: { rules: [{ subagent: "explore", parentModel: "test/*", model: "test/child" }] },
        },
        {
          type: "add",
          target: "subagent-router",
          options: { rules: [{ subagent: "explore", parentModel: "test/*", model: "bad" }] },
        },
      ]
      const directory = yield* tmpdirScoped()
      const locations = yield* LocationServiceMap.Service
      const inventory = yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        yield* plugins.awaitActivation
        return yield* plugins.list()
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
      expect(inventory.find((item) => item.id === "subagent-router")?.state.status).toBe("failed")
      source.operations = []
    }),
  )

  it.live("reports a duplicate plugin ID as a failure without dropping the generation", () =>
    Effect.gen(function* () {
      const sdk = yield* SdkPlugins.Service
      yield* sdk.register(greeter("host-greet"))
      const directory = yield* tmpdirScoped()
      const locations = yield* LocationServiceMap.Service
      const state = yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        yield* plugins.awaitActivation
        const commands = yield* Command.Service
        return {
          inventory: yield* plugins.list(),
          host: yield* commands.get("host-greet"),
          instance: yield* commands.get("instance-greet"),
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )

      // Earlier boot order wins: the host SDK plugin activates and the instance copy is reported.
      expect(state.inventory.filter((plugin) => plugin.id === id)).toEqual([
        { id, source: { type: "sdk" }, state: { status: "active" }, features: { server: true } },
        {
          id,
          source: { type: "sdk" },
          state: { status: "failed", error: `Duplicate plugin ID: ${id}` },
          features: { server: true },
        },
      ])
      expect(state.host).toBeDefined()
      expect(state.instance).toBeUndefined()
      // Builtins stay active: the duplicate is a plugin failure, not a generation defect.
      expect(
        state.inventory.some((plugin) => plugin.id?.startsWith("opencode.") && plugin.state.status === "active"),
      ).toBe(true)
    }),
  )

  it.effect("activates the initial generation without waiting for the reload debounce", () =>
    Effect.gen(function* () {
      source.activations = 0
      const directory = yield* tmpdirScoped()
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const commands = yield* Command.Service
        // The TestClock never advances here, so any timer between boot and the first activation would hang this.
        yield* plugins.awaitActivation
        expect(yield* commands.get("instance-greet")).toBeDefined()
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
      expect(source.activations).toBe(1)
    }),
  )

  it.effect("refreshes every 24 hours without adding an immediate reload", () =>
    Effect.gen(function* () {
      source.activations = 0
      const directory = yield* tmpdirScoped()
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        yield* plugins.awaitActivation
        yield* TestClock.adjust("23 hours")
        expect(source.activations).toBe(1)

        yield* TestClock.adjust("1 hour")
        yield* advance(() => source.activations === 2)
        yield* plugins.awaitActivation

        yield* TestClock.adjust("24 hours")
        yield* advance(() => source.activations === 3)
        yield* plugins.awaitActivation
        expect(source.activations).toBe(3)
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
    }),
  )

  it.effect("reloads for a trigger published while the initial generation is activating", () =>
    Effect.gen(function* () {
      source.activations = 0
      const sdk = yield* SdkPlugins.Service
      const entered = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      yield* sdk.register(
        define({
          id: "gated",
          effect: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate))),
        }),
      )
      let late = false
      const directory = yield* tmpdirScoped()
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const commands = yield* Command.Service
        yield* Deferred.await(entered)
        // Generation 0 is mid-setup: the reload feed must already be subscribed for this update to count.
        yield* sdk.register(
          define({
            id: "late",
            effect: (ctx) =>
              ctx.command
                .transform((editor) => editor.add({ name: "late-greet", execute: () => Effect.void }))
                .pipe(Effect.tap(() => Effect.sync(() => (late = true)))),
          }),
        )
        yield* Deferred.succeed(gate, undefined)
        yield* advance(() => late)
        yield* plugins.awaitActivation
        expect(yield* commands.get("late-greet")).toBeDefined()
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
      expect(source.activations).toBe(2)
    }),
  )

  for (const targets of [["opencode.config.policy", "opencode.provider.opencode", "opencode.config.agent"], ["*"]]) {
    it.effect(`keeps policy enforcement and the Console connection through plugin removals: ${targets}`, () =>
      Effect.gen(function* () {
        source.operations = targets.map((target) => ({ type: "remove", target }))
        const directory = yield* tmpdirScoped()
        const locations = yield* LocationServiceMap.Service
        const inventory = yield* Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.awaitActivation
          return yield* plugins.list()
        }).pipe(
          Effect.scoped,
          Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
        )
        const status = (id: string) => inventory.find((plugin) => plugin.id === id)?.state.status
        expect(status("opencode.config.policy")).toBe("active")
        expect(status("opencode.provider.opencode")).toBe("active")
        // Removals still apply to everything else, including instance and builtin plugins.
        expect(status("opencode.config.agent")).toBeUndefined()
        expect(inventory.some((plugin) => plugin.id === id)).toBe(targets[0] !== "*")
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            source.operations = []
          }),
        ),
      ),
    )
  }

  it.effect("coalesces a burst of reload triggers after the initial generation into one activation", () =>
    Effect.gen(function* () {
      source.activations = 0
      const sdk = yield* SdkPlugins.Service
      const directory = yield* tmpdirScoped()
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const commands = yield* Command.Service
        yield* plugins.awaitActivation
        expect(source.activations).toBe(1)

        yield* sdk.register(greeter("greet-a", "a"))
        yield* sdk.register(greeter("greet-b", "b"))
        yield* sdk.register(greeter("greet-c", "c"))
        yield* advance(() => source.activations > 1)
        yield* plugins.awaitActivation
        expect(yield* commands.get("greet-a")).toBeDefined()
        expect(yield* commands.get("greet-c")).toBeDefined()
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
      expect(source.activations).toBe(2)
    }),
  )
})
