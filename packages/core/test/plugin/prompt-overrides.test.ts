import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Agent } from "@opencode/schema/agent"
import { SystemPart } from "@opencode/ai"
import { Model } from "@opencode/core/model"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { SessionSystemPrompt } from "@opencode/core/session/system-prompt"
import { testEffect } from "../lib/effect"
import { host } from "./host"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
import path from "path"
import { PromptOverridesPlugin } from "@opencode/core/plugin/prompt-overrides"
import { tmpdir } from "../fixture/tmpdir"

describe("prompt overrides", () => {
  it.effect(
    "replaces the optimized base after family hooks without touching instructions or custom agent prompts",
    () =>
      Effect.gen(function* () {
        const plugin = PromptOverridesPlugin.configured({
          model: [{ match: "test/gpt-*", content: "replacement ${OPENCODE_TOOL_GUIDANCE}" }],
          tool: {},
        })
        const hooks = yield* PluginHooks.Service
        yield* hooks.register("session", "context", (event) =>
          Effect.sync(() => {
            event.system[0] = SystemPart.make("optimized")
          }),
        )
        const base = host()
        yield* plugin.effect(
          host({
            ...base,
            agent: {
              ...base.agent,
              get: (input) =>
                Effect.succeed({
                  location: base.location,
                  data: {
                    id: input.agentID,
                    system: input.agentID === "custom" ? "agent base" : undefined,
                  } as Agent.Info,
                }),
            },
            model: { ...base.model, list: () => Effect.succeed({ location: base.location, data: [] }) },
            session: { ...base.session, hook: (name, callback) => hooks.register("session", name, callback) },
            tool: { ...base.tool, hook: (name, callback) => hooks.register("tool", name, callback) },
          }),
        )
        const run = (agent: string, model: Model.Ref) =>
          hooks.trigger("session", "context", {
            sessionID: "ses_override" as never,
            agent: Agent.ID.make(agent),
            model,
            system: [SystemPart.make("base"), SystemPart.make("instructions")],
            messages: [],
            options: {},
            tools: { read: { description: "read", input: {} } },
          })
        expect((yield* run("build", Model.Ref.parse("test/gpt-5"))).system.map((part) => part.text)).toEqual([
          SessionSystemPrompt.render("replacement ${OPENCODE_TOOL_GUIDANCE}", ["read"]),
          "instructions",
        ])
        expect((yield* run("custom", Model.Ref.parse("test/gpt-5"))).system[0]?.text).toBe("optimized")
        expect((yield* run("build", Model.Ref.parse("test/other"))).system[0]?.text).toBe("optimized")
      }),
  )
  it.effect("matches tool overrides by the selected model's API alias", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const base = host()
      const plugin = PromptOverridesPlugin.configured({
        model: [],
        tool: { read: [{ match: "test/actual-api-id", content: "API description" }] },
      })
      yield* plugin.effect(
        host({
          ...base,
          model: {
            ...base.model,
            list: () =>
              Effect.succeed({
                location: base.location,
                data: [{ providerID: "test", id: "catalog-id", modelID: "actual-api-id" }] as never,
              }),
          },
          session: { ...base.session, hook: (name, callback) => hooks.register("session", name, callback) },
          tool: { ...base.tool, hook: (name, callback) => hooks.register("tool", name, callback) },
        }),
      )
      expect(
        (yield* hooks.trigger("tool", "definition", {
          model: Model.Ref.parse("test/catalog-id"),
          toolID: "read",
          builtin: true,
          description: "original",
        })).description,
      ).toBe("API description")
    }),
  )
  test("the first wildcard match wins across catalog and API aliases", async () => {
    const options = await Effect.runPromise(
      PromptOverridesPlugin.loadOptions(
        {
          model: [
            { match: "test/gpt-*", text: "first" },
            { match: "*", text: "last" },
          ],
        },
        "/tmp",
      ),
    )
    expect(PromptOverridesPlugin.findReplacement(options.model, ["test/gpt-5", "test/alias"])?.content).toBe("first")
    expect(
      PromptOverridesPlugin.findReplacement(options.model, ["other/catalog", "test/gpt-5", "gpt-5"])?.content,
    ).toBe("first")
    expect(PromptOverridesPlugin.findReplacement(options.model, ["gpt-5"])?.content).toBe("last")
  })

  test("loads a single text entry and file contents relative to the location", async () => {
    await using dir = await tmpdir()
    await Bun.write(path.join(dir.path, "prompt.txt"), "from disk")
    const options = await Effect.runPromise(
      PromptOverridesPlugin.loadOptions(
        { model: { text: "inline" }, tool: { read: { file: "prompt.txt" } } },
        dir.path,
      ),
    )
    expect(PromptOverridesPlugin.findReplacement(options.model, ["anything"])?.content).toBe("inline")
    expect(PromptOverridesPlugin.findReplacement(options.tool.read ?? [], ["anything"])?.content).toBe("from disk")
  })

  test("reloads file contents and rejects missing files and invalid tool keys", async () => {
    await using dir = await tmpdir()
    await Bun.write(path.join(dir.path, "prompt.txt"), "before")
    const config = { model: { file: "prompt.txt" } }
    expect((await Effect.runPromise(PromptOverridesPlugin.loadOptions(config, dir.path))).model[0]?.content).toBe(
      "before",
    )
    await Bun.write(path.join(dir.path, "prompt.txt"), "after")
    expect((await Effect.runPromise(PromptOverridesPlugin.loadOptions(config, dir.path))).model[0]?.content).toBe(
      "after",
    )
    expect(
      Effect.runPromise(PromptOverridesPlugin.loadOptions({ model: { file: "missing" } }, dir.path)),
    ).rejects.toThrow()
    expect(
      Effect.runPromise(PromptOverridesPlugin.loadOptions({ tool: { imaginary: { text: "bad" } } }, dir.path)),
    ).rejects.toThrow()
    expect(
      Effect.runPromise(PromptOverridesPlugin.loadOptions({ model: { text: "a", file: "b" } }, dir.path)),
    ).rejects.toThrow()
  })
  test("rejects extra fields in model and tool entries", async () => {
    expect(
      Effect.runPromise(PromptOverridesPlugin.loadOptions({ model: { text: "base", typo: "ignored" } }, "/tmp")),
    ).rejects.toThrow()
    expect(
      Effect.runPromise(
        PromptOverridesPlugin.loadOptions({ tool: { read: { text: "read", typo: "ignored" } } }, "/tmp"),
      ),
    ).rejects.toThrow()
  })
  test("preserves entry order when an API alias and catalog ID both match", async () => {
    const options = await Effect.runPromise(
      PromptOverridesPlugin.loadOptions(
        {
          model: [
            { match: "api-id", text: "first entry" },
            { match: "test/catalog-id", text: "second entry" },
          ],
        },
        "/tmp",
      ),
    )
    expect(
      PromptOverridesPlugin.findReplacement(options.model, ["test/catalog-id", "test/api-id", "api-id"])?.content,
    ).toBe("first entry")
  })
})
