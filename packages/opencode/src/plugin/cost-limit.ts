import type { Plugin, PluginInput, PluginModule, PluginOptions } from "@opencode-ai/plugin"
import { Wildcard } from "@opencode-ai/core/util/wildcard"

export type Limits = {
  parent?: number
  subagents?: number
}

export type Rule = Limits & {
  model: string
}

export type ResolvedOptions = {
  default?: Limits
  rules: Rule[]
}

export type GateInput = {
  rootID: string
  rootModel: { providerID: string; modelID: string }
  rootUserMessageID: string
  cost: { session: number; root: number; descendants: number }
}

export type GateOutput = {
  continue: boolean
  reason?: string
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function amount(input: unknown, label: string) {
  if (input === undefined) return undefined
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0)
    throw new Error(`${label} must be a positive number`)
  return input
}

function limits(input: Record<string, unknown>, label: string): Limits {
  return {
    parent: amount(input.parent, `${label}.parent`),
    subagents: amount(input.subagents, `${label}.subagents`),
  }
}

export function loadOptions(raw: PluginOptions | undefined): ResolvedOptions {
  if (!isRecord(raw)) throw new Error("cost limit plugin options must be an object")
  if (raw.default !== undefined && !isRecord(raw.default)) throw new Error("default must be an object")
  if (raw.rules !== undefined && !Array.isArray(raw.rules)) throw new Error("rules must be an array")
  return {
    default: raw.default === undefined ? undefined : limits(raw.default, "default"),
    rules: (raw.rules ?? []).map((item, index) => {
      const label = `rules[${index}]`
      if (!isRecord(item)) throw new Error(`${label} must be an object`)
      if (typeof item.model !== "string") throw new Error(`${label}.model must be a string`)
      return { model: item.model, ...limits(item, label) }
    }),
  }
}

// Last match wins, and a matching rule replaces the default outright: omitting
// a number in the winning rule disables that bucket rather than inheriting it.
export function findLimits(options: ResolvedOptions, model: string): Limits {
  const rule = options.rules.findLast((item) => Wildcard.match(model, item.model))
  if (rule) return { parent: rule.parent, subagents: rule.subagents }
  return options.default ?? {}
}

function money(value: number) {
  return `$${value.toFixed(2)}`
}

export function createGate(options: ResolvedOptions) {
  const windows = new Map<string, { userMessageID: string; root: number; descendants: number }>()

  return (input: GateInput, output: GateOutput) => {
    const previous = windows.get(input.rootID)
    // Core reports cumulative session-lifetime totals. A new root user message
    // opens a fresh allowance, so rebaseline against the current totals.
    const window =
      previous && previous.userMessageID === input.rootUserMessageID
        ? previous
        : { userMessageID: input.rootUserMessageID, root: input.cost.root, descendants: input.cost.descendants }
    windows.set(input.rootID, window)

    const resolved = findLimits(options, `${input.rootModel.providerID}/${input.rootModel.modelID}`)
    const parent = input.cost.root - window.root
    const subagents = input.cost.descendants - window.descendants

    if (resolved.parent !== undefined && parent >= resolved.parent) {
      output.continue = false
      output.reason = `Stopped: this prompt has spent ${money(parent)} in this session, reaching the ${money(resolved.parent)} limit. Send a new message to continue.`
      return
    }

    if (resolved.subagents !== undefined && subagents >= resolved.subagents) {
      output.continue = false
      output.reason = `Stopped: this prompt has spent ${money(subagents)} on subagents, reaching the ${money(resolved.subagents)} limit. Send a new message to continue.`
    }
  }
}

export const CostLimitPlugin: Plugin = async (_input: PluginInput, options?: PluginOptions) => {
  const gate = createGate(loadOptions(options))
  return {
    "experimental.session.turn.before": async (input, output) => {
      gate(input, output)
    },
  }
}

export default { id: "cost-limit", server: CostLimitPlugin } satisfies PluginModule
