import { describe, expect, test } from "bun:test"
import subagentRouterModule, { findRoute, loadOptions, SubagentRouterPlugin } from "@/plugin/subagent-router"
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin"

function pluginInput() {
  return { directory: process.cwd() } as unknown as PluginInput
}

describe("subagent router plugin", () => {
  test("exports a plugin module id for configured built-in loading", () => {
    expect(subagentRouterModule.id).toBe("subagent-router")
  })

  test("loads valid rules and parses model refs on the first slash", () => {
    const options = loadOptions({
      rules: [
        {
          subagent: "explore",
          parentModel: ["anthropic/*", "github-copilot/*"],
          model: "openrouter/moonshotai/kimi-k2",
          variant: "high",
        },
      ],
    })

    expect(options.rules).toEqual([
      {
        subagent: "explore",
        parentModel: ["anthropic/*", "github-copilot/*"],
        model: {
          providerID: "openrouter",
          modelID: "moonshotai/kimi-k2",
          variant: "high",
        },
      },
    ])
  })

  test("rejects malformed options", () => {
    expect(() => loadOptions(undefined)).toThrow("subagent router plugin options must be an object")
    expect(() => loadOptions([] as unknown as PluginOptions)).toThrow(
      "subagent router plugin options must be an object",
    )
    expect(() => loadOptions({})).toThrow("rules must be an array")
    expect(() => loadOptions({ rules: "explore" })).toThrow("rules must be an array")
    expect(() => loadOptions({ rules: ["explore"] })).toThrow("rules[0] must be an object")
    expect(() => loadOptions({ rules: [{ parentModel: "anthropic/*", model: "openai/gpt-5-mini" }] })).toThrow(
      "rules[0].subagent must be a string",
    )
    expect(() => loadOptions({ rules: [{ subagent: "explore", model: "openai/gpt-5-mini" }] })).toThrow(
      "rules[0].parentModel must be a string or string array",
    )
    expect(() =>
      loadOptions({ rules: [{ subagent: "explore", parentModel: ["anthropic/*", 1], model: "openai/gpt-5-mini" }] }),
    ).toThrow("rules[0].parentModel[1] must be a string")
    expect(() => loadOptions({ rules: [{ subagent: "explore", parentModel: "anthropic/*" }] })).toThrow(
      "rules[0].model must be a string",
    )
    expect(() =>
      loadOptions({ rules: [{ subagent: "explore", parentModel: "anthropic/*", model: "openai" }] }),
    ).toThrow("rules[0].model must be in provider/model form")
    expect(() =>
      loadOptions({
        rules: [{ subagent: "explore", parentModel: "anthropic/*", model: "openai/gpt-5-mini", variant: 1 }],
      }),
    ).toThrow("rules[0].variant must be a string")
  })

  test("finds the first matching rule by subagent and parent model", () => {
    const options = loadOptions({
      rules: [
        { subagent: "explore", parentModel: "anthropic/nope", model: "openai/wrong" },
        { subagent: "explore", parentModel: "anthropic/*", model: "openai/first" },
        { subagent: "explore", parentModel: "anthropic/claude-sonnet-4-6", model: "openai/second" },
      ],
    })

    expect(
      findRoute(options.rules, {
        subagentType: "explore",
        parentModel: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      })?.model,
    ).toEqual({ providerID: "openai", modelID: "first", variant: undefined })
  })

  test("supports wildcard subagent and multiple parent model patterns", () => {
    const options = loadOptions({
      rules: [
        {
          subagent: "*",
          parentModel: ["openai/gpt-5*", "github-copilot/*"],
          model: "anthropic/claude-sonnet-4-6",
        },
      ],
    })

    expect(
      findRoute(options.rules, {
        subagentType: "general",
        parentModel: { providerID: "github-copilot", modelID: "gpt-5.1" },
      })?.model,
    ).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4-6", variant: undefined })
  })

  test("returns no route for unrelated subagent or parent model", () => {
    const options = loadOptions({
      rules: [{ subagent: "explore", parentModel: "anthropic/*", model: "openai/gpt-5-mini" }],
    })

    expect(
      findRoute(options.rules, {
        subagentType: "general",
        parentModel: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      }),
    ).toBeUndefined()
    expect(
      findRoute(options.rules, {
        subagentType: "explore",
        parentModel: { providerID: "openai", modelID: "gpt-5" },
      }),
    ).toBeUndefined()
  })

  test("mutates tool.execute.before output for matching task input", async () => {
    const hooks = await SubagentRouterPlugin(pluginInput(), {
      rules: [
        {
          subagent: "explore",
          parentModel: "anthropic/*",
          model: "openai/gpt-5-mini",
          variant: "high",
        },
      ],
    })
    const output: {
      args: Record<string, unknown>
      model?: { providerID: string; modelID: string; variant?: string }
    } = { args: {} }

    await hooks["tool.execute.before"]?.(
      {
        tool: "task",
        sessionID: "ses_test",
        callID: "call_test",
        task: {
          subagentType: "explore",
          parentModel: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
        },
      },
      output,
    )

    expect(output.model).toEqual({ providerID: "openai", modelID: "gpt-5-mini", variant: "high" })
  })

  test("ignores non-task inputs and task inputs without task context", async () => {
    const hooks = await SubagentRouterPlugin(pluginInput(), {
      rules: [{ subagent: "explore", parentModel: "anthropic/*", model: "openai/gpt-5-mini" }],
    })
    const nonTaskOutput: { args: Record<string, unknown>; model?: { providerID: string; modelID: string } } = {
      args: {},
    }
    const missingTaskOutput: { args: Record<string, unknown>; model?: { providerID: string; modelID: string } } = {
      args: {},
    }

    await hooks["tool.execute.before"]?.({ tool: "read", sessionID: "ses_test", callID: "call_read" }, nonTaskOutput)
    await hooks["tool.execute.before"]?.(
      { tool: "task", sessionID: "ses_test", callID: "call_task" },
      missingTaskOutput,
    )

    expect(nonTaskOutput.model).toBeUndefined()
    expect(missingTaskOutput.model).toBeUndefined()
  })
})
