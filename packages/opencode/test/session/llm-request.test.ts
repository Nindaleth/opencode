import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LLMRequestPrep } from "@/session/llm/request"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import type { Plugin } from "@/plugin"

const sessionID = "ses_test"

const model = {
  id: ModelV2.ID.make("configured-model"),
  providerID: ProviderV2.ID.make("test-provider"),
  api: {
    id: "api-model",
    url: "",
    npm: "@ai-sdk/openai-compatible",
  },
  name: "Test Model",
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
  limit: { context: 100000, output: 10000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
  variants: {},
} satisfies Provider.Model

const user = {
  id: "msg_user-test",
  sessionID,
  role: "user" as const,
  time: { created: Date.now() },
  agent: "build",
  model: { providerID: model.providerID, modelID: model.id },
} as SessionV1.User

const baseAgent = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [],
} satisfies Agent.Info

function plugin(captured: unknown[]): Plugin.Interface {
  return {
    trigger: ((name: string, input: unknown, output: unknown) =>
      Effect.sync(() => {
        if (name === "experimental.chat.system.transform") captured.push(input)
        return output
      })) as Plugin.Interface["trigger"],
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  }
}

function prepare(agent: Agent.Info, captured: unknown[]) {
  return LLMRequestPrep.prepare({
    user,
    sessionID,
    model,
    agent,
    system: ["environment block"],
    messages: [{ role: "user", content: "hello" }],
    tools: {},
    provider: { id: model.providerID, options: {} } as Provider.Info,
    auth: undefined,
    plugin: plugin(captured),
    flags: { outputTokenMax: 32_000, client: "test" } as never,
    isWorkflow: false,
  })
}

describe("LLMRequestPrep.prepare", () => {
  test("system transform receives base system and agent context", async () => {
    const captured: unknown[] = []
    await Effect.runPromise(prepare(baseAgent, captured))

    const input = captured[0] as {
      sessionID?: string
      agent?: string
      hasAgentPrompt?: boolean
      baseSystem?: string
      model?: Provider.Model
    }

    expect(input.sessionID).toBe(sessionID)
    expect(input.agent).toBe("build")
    expect(input.hasAgentPrompt).toBe(false)
    expect(input.model).toBe(model)
    expect(input.baseSystem?.length).toBeGreaterThan(20)
    expect(input.baseSystem).not.toContain("environment block")
  })

  test("system transform reports agent prompt as the selected base system", async () => {
    const captured: unknown[] = []
    await Effect.runPromise(prepare({ ...baseAgent, prompt: "agent override prompt" }, captured))

    const input = captured[0] as { hasAgentPrompt?: boolean; baseSystem?: string }
    expect(input.hasAgentPrompt).toBe(true)
    expect(input.baseSystem).toBe("agent override prompt")
  })
})
