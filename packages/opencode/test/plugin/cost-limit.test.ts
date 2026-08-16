import { describe, expect, test } from "bun:test"
import costLimitModule, { createGate, findLimits, loadOptions, CostLimitPlugin } from "@/plugin/cost-limit"
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin"

function pluginInput() {
  return { directory: process.cwd() } as unknown as PluginInput
}

function gateInput(overrides?: {
  rootID?: string
  rootUserMessageID?: string
  model?: string
  root?: number
  descendants?: number
}) {
  const [providerID = "", ...rest] = (overrides?.model ?? "test/test-model").split("/")
  return {
    sessionID: overrides?.rootID ?? "ses_root",
    rootID: overrides?.rootID ?? "ses_root",
    agent: "build",
    step: 1,
    model: { providerID, modelID: rest.join("/") },
    rootModel: { providerID, modelID: rest.join("/") },
    rootUserMessageID: overrides?.rootUserMessageID ?? "msg_1",
    cost: { session: overrides?.root ?? 0, root: overrides?.root ?? 0, descendants: overrides?.descendants ?? 0 },
  }
}

describe("cost limit plugin", () => {
  test("exports a plugin module id for configured built-in loading", () => {
    expect(costLimitModule.id).toBe("cost-limit")
  })

  test("loads default and rule limits", () => {
    expect(
      loadOptions({
        default: { parent: 5, subagents: 10 },
        rules: [{ model: "github-copilot/claude-opus-*", parent: 8, subagents: 15 }],
      }),
    ).toEqual({
      default: { parent: 5, subagents: 10 },
      rules: [{ model: "github-copilot/claude-opus-*", parent: 8, subagents: 15 }],
    })
  })

  test("rejects malformed options", () => {
    expect(() => loadOptions(undefined)).toThrow("cost limit plugin options must be an object")
    expect(() => loadOptions([] as unknown as PluginOptions)).toThrow("cost limit plugin options must be an object")
    expect(() => loadOptions({ default: 5 })).toThrow("default must be an object")
    expect(() => loadOptions({ default: { parent: "5" } })).toThrow("default.parent must be a positive number")
    expect(() => loadOptions({ default: { subagents: 0 } })).toThrow("default.subagents must be a positive number")
    expect(() => loadOptions({ default: { parent: -1 } })).toThrow("default.parent must be a positive number")
    expect(() => loadOptions({ rules: "nope" })).toThrow("rules must be an array")
    expect(() => loadOptions({ rules: ["nope"] })).toThrow("rules[0] must be an object")
    expect(() => loadOptions({ rules: [{ parent: 1 }] })).toThrow("rules[0].model must be a string")
    expect(() => loadOptions({ rules: [{ model: "a/b", subagents: Infinity }] })).toThrow(
      "rules[0].subagents must be a positive number",
    )
  })

  test("resolves the last matching rule and falls back to default", () => {
    const options = loadOptions({
      default: { parent: 5, subagents: 10 },
      rules: [
        { model: "github-copilot/*", parent: 2, subagents: 3 },
        { model: "github-copilot/claude-opus-*", parent: 8, subagents: 15 },
      ],
    })
    expect(findLimits(options, "github-copilot/claude-opus-5")).toEqual({ parent: 8, subagents: 15 })
    expect(findLimits(options, "github-copilot/gpt-5.6-luna")).toEqual({ parent: 2, subagents: 3 })
    expect(findLimits(options, "anthropic/claude-sonnet-4-6")).toEqual({ parent: 5, subagents: 10 })
  })

  test("a matching rule replaces default rather than merging with it", () => {
    const options = loadOptions({ default: { parent: 5, subagents: 10 }, rules: [{ model: "anthropic/*", parent: 1 }] })
    expect(findLimits(options, "anthropic/claude-sonnet-4-6")).toEqual({ parent: 1, subagents: undefined })
  })

  test("no default and no matching rule means no limits", () => {
    expect(findLimits(loadOptions({ rules: [{ model: "anthropic/*", parent: 1 }] }), "openai/gpt-5")).toEqual({})
  })

  test("never blocks the first turn of a prompt", () => {
    const gate = createGate(loadOptions({ default: { parent: 1 } }))
    const output = { continue: true } as { continue: boolean; reason?: string }
    gate(gateInput({ root: 99 }), output)
    expect(output.continue).toBe(true)
  })

  test("stops on the parent bucket once spend reaches the limit", () => {
    const gate = createGate(loadOptions({ default: { parent: 5 } }))
    const first = { continue: true } as { continue: boolean; reason?: string }
    const second = { continue: true } as { continue: boolean; reason?: string }
    gate(gateInput({ root: 1 }), first)
    gate(gateInput({ root: 6 }), second)
    expect(first.continue).toBe(true)
    expect(second.continue).toBe(false)
    expect(second.reason).toContain("$5.00")
    expect(second.reason).toContain("this session")
  })

  test("stops on the subagent bucket independently of the parent bucket", () => {
    const gate = createGate(loadOptions({ default: { subagents: 4 } }))
    const first = { continue: true } as { continue: boolean; reason?: string }
    const second = { continue: true } as { continue: boolean; reason?: string }
    gate(gateInput({ root: 0, descendants: 0 }), first)
    gate(gateInput({ root: 100, descendants: 4 }), second)
    expect(first.continue).toBe(true)
    expect(second.continue).toBe(false)
    expect(second.reason).toContain("subagents")
  })

  test("an omitted limit disables that bucket", () => {
    const gate = createGate(loadOptions({ default: { subagents: 4 } }))
    const second = { continue: true } as { continue: boolean; reason?: string }
    gate(gateInput({ root: 0 }), { continue: true })
    gate(gateInput({ root: 1000 }), second)
    expect(second.continue).toBe(true)
  })

  test("a new root user message rebaselines the window", () => {
    const gate = createGate(loadOptions({ default: { parent: 5 } }))
    const blocked = { continue: true } as { continue: boolean; reason?: string }
    const resumed = { continue: true } as { continue: boolean; reason?: string }
    gate(gateInput({ rootUserMessageID: "msg_1", root: 0 }), { continue: true })
    gate(gateInput({ rootUserMessageID: "msg_1", root: 6 }), blocked)
    gate(gateInput({ rootUserMessageID: "msg_2", root: 6 }), resumed)
    expect(blocked.continue).toBe(false)
    expect(resumed.continue).toBe(true)
  })

  test("windows are keyed per root session", () => {
    const gate = createGate(loadOptions({ default: { parent: 5 } }))
    const other = { continue: true } as { continue: boolean; reason?: string }
    gate(gateInput({ rootID: "ses_a", root: 0 }), { continue: true })
    gate(gateInput({ rootID: "ses_b", root: 50 }), other)
    expect(other.continue).toBe(true)
  })

  test("the hook wires the gate through the plugin surface", async () => {
    const hooks = await CostLimitPlugin(pluginInput(), { default: { parent: 5 } })
    const first = { continue: true } as { continue: boolean; reason?: string }
    const second = { continue: true } as { continue: boolean; reason?: string }
    await hooks["experimental.session.turn.before"]?.(gateInput({ root: 0 }), first)
    await hooks["experimental.session.turn.before"]?.(gateInput({ root: 9 }), second)
    expect(first.continue).toBe(true)
    expect(second.continue).toBe(false)
  })
})
