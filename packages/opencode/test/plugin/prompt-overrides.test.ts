import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import {
  BUILTIN_TOOL_IDS,
  findReplacement,
  loadOptions,
  modelCandidates,
  PromptOverridesPlugin,
  toolCandidates,
} from "@/plugin/prompt-overrides"
import type { PluginInput } from "@opencode-ai/plugin"

const model = {
  id: "configured-model",
  providerID: "test-provider",
  api: { id: "api-model", url: "", npm: "@ai-sdk/openai-compatible" },
  name: "Test Model",
  capabilities: {
    temperature: false,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 100000, output: 10000 },
  status: "active" as const,
  options: {},
  headers: {},
  release_date: "2026-01-01",
  variants: {},
}

function pluginInput(directory: string) {
  return { directory } as unknown as PluginInput
}

describe("prompt override plugin", () => {
  test("declares expected built-in tool ids", () => {
    expect(BUILTIN_TOOL_IDS.has("bash")).toBe(true)
    expect(BUILTIN_TOOL_IDS.has("read")).toBe(true)
    expect(BUILTIN_TOOL_IDS.has("apply_patch")).toBe(true)
    expect(BUILTIN_TOOL_IDS.has("execute")).toBe(true)
    expect(BUILTIN_TOOL_IDS.has("made_up_tool")).toBe(false)
  })

  test("builds model and tool match candidates", () => {
    expect(modelCandidates(model)).toEqual(["test-provider/configured-model", "test-provider/api-model", "api-model"])
    expect(
      toolCandidates({ providerID: "test-provider", modelID: "configured-model", apiModelID: "api-model" }),
    ).toEqual(["test-provider/configured-model", "test-provider/api-model", "api-model"])
  })

  test("uses first exact or glob match", () => {
    const entries = [
      { match: "test-provider/nope", content: "nope" },
      { match: "test-provider/api-*", content: "glob" },
      { match: "test-provider/api-model", content: "exact later" },
    ]
    expect(findReplacement(entries, ["test-provider/api-model"])?.content).toBe("glob")
    expect(findReplacement([{ match: "*", content: "default" }], [])?.content).toBe("default")
  })

  test("loads inline and file replacements", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "read.txt"), "read replacement")
      },
    })

    const options = await loadOptions(
      {
        model: [{ match: "test-provider/api-*", text: "model replacement" }],
        tool: { read: { file: "read.txt" } },
      },
      tmp.path,
    )

    expect(options.model).toEqual([{ match: "test-provider/api-*", content: "model replacement" }])
    expect(options.tool.read).toEqual([{ match: "*", content: "read replacement" }])
  })

  test("rejects malformed options", async () => {
    await using tmp = await tmpdir()

    await expect(loadOptions({ model: [{ text: "x", file: "x.txt" }] }, tmp.path)).rejects.toThrow(
      "model[0] must define exactly one of text or file",
    )
    await expect(loadOptions({ tool: { made_up_tool: { text: "x" } } }, tmp.path)).rejects.toThrow(
      "Unknown built-in tool id: made_up_tool",
    )
    await expect(loadOptions({ model: [{ file: "missing.txt" }] }, tmp.path)).rejects.toThrow(
      "Failed to read prompt override file",
    )
  })

  test("replaces model base prompt prefix when no agent prompt is active", async () => {
    await using tmp = await tmpdir()
    const hooks = await PromptOverridesPlugin(pluginInput(tmp.path), {
      model: [{ match: "test-provider/api-*", text: "model replacement" }],
    })
    const output = { system: ["base prompt\nenvironment block"] }

    await hooks["experimental.chat.system.transform"]?.(
      {
        sessionID: "ses_test",
        model,
        agent: "build",
        hasAgentPrompt: false,
        baseSystem: "base prompt",
      },
      output,
    )

    expect(output.system[0]).toBe("model replacement\nenvironment block")
  })

  test("does not replace model base prompt when agent prompt is active", async () => {
    await using tmp = await tmpdir()
    const hooks = await PromptOverridesPlugin(pluginInput(tmp.path), {
      model: [{ match: "test-provider/api-*", text: "model replacement" }],
    })
    const output = { system: ["agent prompt\nenvironment block"] }

    await hooks["experimental.chat.system.transform"]?.(
      {
        sessionID: "ses_test",
        model,
        agent: "build",
        hasAgentPrompt: true,
        baseSystem: "agent prompt",
      },
      output,
    )

    expect(output.system[0]).toBe("agent prompt\nenvironment block")
  })

  test("replaces built-in tool base description only when model matches", async () => {
    await using tmp = await tmpdir()
    const hooks = await PromptOverridesPlugin(pluginInput(tmp.path), {
      tool: {
        read: [
          { match: "test-provider/nope", text: "wrong" },
          { match: "test-provider/api-*", text: "read replacement" },
        ],
      },
    })
    const output = { description: "read original", parameters: {} }

    await hooks["tool.definition"]?.(
      {
        toolID: "read",
        providerID: "test-provider",
        modelID: "configured-model",
        apiModelID: "api-model",
        agent: "build",
      },
      output,
    )

    expect(output.description).toBe("read replacement")
  })
})
