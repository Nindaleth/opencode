import { describe, expect } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Layer, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Instruction } from "@/session/instruction"
import { SystemPrompt } from "@/session/system"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { debugPrompt } from "@/cli/cmd/debug/prompt.handler"
import type { CliError } from "@/cli/effect-cmd"
import { Session } from "@/session/session"
import { cliIt } from "../../../lib/cli-process"
import { testEffect } from "../../../lib/effect"

const model = {
  id: ModelV2.ID.make("test-model"),
  providerID: ProviderV2.ID.make("test-provider"),
  api: { id: "test-model", url: "", npm: "@ai-sdk/openai-compatible" },
  name: "Test model",
  capabilities: {
    temperature: false,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 100_000, output: 10_000 },
  status: "active" as const,
  options: {},
  headers: {},
  release_date: "2026-01-01",
  variants: { fast: { variantFlag: true } },
} satisfies Provider.Model

const agent = { name: "build", mode: "primary" as const, permission: [], options: {} } satisfies Agent.Info
const configuredAgent = {
  ...agent,
  model: { providerID: ProviderV2.ID.make("agent-provider"), modelID: ModelV2.ID.make("agent-model") },
  variant: "fast",
  permission: [{ permission: "shell", pattern: "*", action: "deny" as const }],
} satisfies Agent.Info
let sessionCreateCalls = 0
let registryToolIDs: string[] = []

const it = testEffect(
  Layer.mergeAll(
    Layer.mock(Agent.Service, {
      get: ((name: string) =>
        Effect.succeed(
          name === "missing"
            ? undefined
            : name === "configured"
              ? { ...configuredAgent, name }
              : { ...agent, name, permission: [{ permission: "shell", pattern: "*", action: "deny" as const }] },
        )) as never,
      list: () =>
        Effect.succeed([
          { ...agent, name: "build" },
          { ...agent, name: "hidden", hidden: true },
        ]),
      defaultInfo: () => Effect.succeed(configuredAgent),
    }),
    Layer.mock(Provider.Service, {
      getModel: (providerID, modelID) => Effect.succeed({ ...model, providerID, id: modelID }),
      defaultModel: () => Effect.succeed({ providerID: model.providerID, modelID: model.id }),
      getProvider: (id) =>
        Effect.succeed({ id, name: id, source: "config" as const, env: [], options: {}, models: {} }),
    }),
    Layer.mock(SystemPrompt.Service, {
      environment: () => Effect.succeed(["environment"]),
      skills: () => Effect.succeed("skills"),
      mcp: () => Effect.succeed("mcp"),
    }),
    Layer.mock(Instruction.Service, { system: () => Effect.succeed(["instructions"]) }),
    Layer.mock(Plugin.Service, {
      trigger: <Name extends string, Input, Output>(_name: Name, _input: Input, output: Output) =>
        Effect.succeed(output),
    }),
    Layer.mock(Auth.Service, { get: () => Effect.succeed(undefined) }),
    RuntimeFlags.layer({ outputTokenMax: 32_000, client: "test" }),
    Layer.mock(Permission.Service, {}),
    Layer.mock(MCP.Service, { clients: () => Effect.succeed({}), tools: () => Effect.succeed({}) }),
    Layer.mock(Truncate.Service, {}),
    Layer.mock(ToolRegistry.Service, {
      tools: () =>
        Effect.sync(() => {
          const candidates = [
            {
              id: "read",
              description: "Read a file",
              parameters: Schema.Struct({}),
              execute: () => Effect.die("tool execution is not available in debug prompt"),
            },
            {
              id: "shell",
              description: "Run a shell command",
              parameters: Schema.Struct({}),
              execute: () => Effect.die("tool execution is not available in debug prompt"),
            },
          ]
          registryToolIDs = candidates.map((tool) => tool.id)
          return candidates
        }),
    }),
    Layer.mock(Session.Service, {
      create: () =>
        Effect.sync(() => {
          sessionCreateCalls++
          return undefined as never
        }),
    }),
  ),
)

function capture(effect: Effect.Effect<void, CliError>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const output: string[] = []
      const write = process.stdout.write
      process.stdout.write = ((chunk: string | Uint8Array) => {
        output.push(chunk.toString())
        return true
      }) as typeof process.stdout.write
      return { output, write }
    }),
    ({ output }) => effect.pipe(Effect.as(output)),
    ({ write }) =>
      Effect.sync(() => {
        process.stdout.write = write
      }),
  )
}

describe("debug prompt", () => {
  cliIt.live("prints the initial request through the CLI", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["debug", "prompt", "--provider", "test", "--model", "test-model"])
      opencode.expectExit(result, 0, "debug prompt")
      const output = JSON.parse(result.stdout)
      expect(output.selection).toEqual({ provider: "test", model: "test-model", agent: expect.any(String) })
      expect(output.messages.some((message: { role: string }) => message.role === "user")).toBe(false)
    }),
  )

  it.effect("prints an ephemeral initial request and resolved defaults", () =>
    Effect.gen(function* () {
      const output = yield* capture(debugPrompt({}) as never)
      const parsed = JSON.parse(output.join(""))
      expect(parsed.selection).toEqual({ provider: "agent-provider", model: "agent-model", agent: "build" })
      expect(parsed.messages).toEqual([{ role: "system", content: expect.stringContaining("environment") }])
      expect(parsed.tools.read).toMatchObject({ description: "Read a file" })
      expect(parsed.tools.read.execute).toBeUndefined()
      expect(registryToolIDs).toContain("shell")
      expect(parsed.tools.shell).toBeUndefined()
      expect(parsed.messages[0].content).toContain("environment\ninstructions\nmcp\nskills")
    }),
  )

  it.effect("uses explicit provider, model, and agent without storing a session", () =>
    Effect.gen(function* () {
      sessionCreateCalls = 0
      const output = yield* capture(
        debugPrompt({
          provider: "other-provider",
          model: "other-model",
          agent: "review",
        }) as never,
      )
      expect(JSON.parse(output.join("")).selection).toEqual({
        provider: "other-provider",
        model: "other-model",
        agent: "review",
      })
      expect(sessionCreateCalls).toBe(0)
    }),
  )

  it.effect("uses an explicit agent's configured model when provider and model are omitted", () =>
    Effect.gen(function* () {
      const output = yield* capture(debugPrompt({ agent: "configured" }) as never)
      expect(JSON.parse(output.join("")).selection).toEqual({
        provider: "agent-provider",
        model: "agent-model",
        agent: "configured",
      })
    }),
  )

  it.effect("retains an explicit configured agent model variant", () =>
    Effect.gen(function* () {
      const output = yield* capture(
        debugPrompt({ provider: "agent-provider", model: "agent-model", agent: "configured" }) as never,
      )
      expect(JSON.parse(output.join("")).params.options).toMatchObject({ variantFlag: true })
    }),
  )

  it.effect("does not apply a configured agent variant to a different explicit model", () =>
    Effect.gen(function* () {
      const output = yield* capture(
        debugPrompt({ provider: "other-provider", model: "other-model", agent: "configured" }) as never,
      )
      expect(JSON.parse(output.join("")).params.options).not.toHaveProperty("variantFlag")
    }),
  )

  it.effect("rejects a provider without a model", () =>
    Effect.gen(function* () {
      const error = yield* (debugPrompt({ provider: "test-provider" }) as Effect.Effect<void, CliError>).pipe(
        Effect.flip,
      )
      expect(error.message).toBe("--provider and --model must be used together")
    }),
  )

  it.effect("rejects a model without a provider", () =>
    Effect.gen(function* () {
      const error = yield* (debugPrompt({ model: "test-model" }) as Effect.Effect<void, CliError>).pipe(Effect.flip)
      expect(error.message).toBe("--provider and --model must be used together")
    }),
  )

  it.effect("reports available non-hidden agents when an explicit agent is missing", () =>
    Effect.gen(function* () {
      const error = yield* (debugPrompt({ agent: "missing" }) as Effect.Effect<void, CliError>).pipe(Effect.flip)
      expect(error.message).toBe('Agent not found: "missing". Available agents: build')
    }),
  )
})
