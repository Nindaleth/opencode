import type { Plugin, PluginInput, PluginModule, PluginOptions } from "@opencode-ai/plugin"

type RawRule = {
  subagent?: unknown
  parentModel?: unknown
  model?: unknown
  variant?: unknown
}

export type ResolvedRoute = {
  subagent: string
  parentModel: string[]
  model: {
    providerID: string
    modelID: string
    variant?: string
  }
}

export type ResolvedOptions = {
  rules: ResolvedRoute[]
}

export type TaskInput = {
  subagentType: string
  parentModel: {
    providerID: string
    modelID: string
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function modelRef(input: string, label: string) {
  const index = input.indexOf("/")
  if (index <= 0 || index === input.length - 1) throw new Error(`${label} must be in provider/model form`)
  return {
    providerID: input.slice(0, index),
    modelID: input.slice(index + 1),
  }
}

function normalizeParentModel(input: unknown, label: string) {
  if (typeof input === "string") return [input]
  if (!Array.isArray(input)) throw new Error(`${label} must be a string or string array`)
  return input.map((item, index) => {
    if (typeof item !== "string") throw new Error(`${label}[${index}] must be a string`)
    return item
  })
}

function resolveRule(input: RawRule, index: number): ResolvedRoute {
  const label = `rules[${index}]`
  if (typeof input.subagent !== "string") throw new Error(`${label}.subagent must be a string`)
  if (typeof input.model !== "string") throw new Error(`${label}.model must be a string`)
  if (input.variant !== undefined && typeof input.variant !== "string")
    throw new Error(`${label}.variant must be a string`)

  return {
    subagent: input.subagent,
    parentModel: normalizeParentModel(input.parentModel, `${label}.parentModel`),
    model: {
      ...modelRef(input.model, `${label}.model`),
      variant: input.variant,
    },
  }
}

export function loadOptions(raw: PluginOptions | undefined): ResolvedOptions {
  if (!isRecord(raw)) throw new Error("subagent router plugin options must be an object")
  if (!Array.isArray(raw.rules)) throw new Error("rules must be an array")
  return {
    rules: raw.rules.map((item, index) => {
      if (!isRecord(item)) throw new Error(`rules[${index}] must be an object`)
      return resolveRule(item, index)
    }),
  }
}

function glob(pattern: string) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`)
}

function matches(pattern: string, candidate: string) {
  if (pattern === "*") return true
  if (!pattern.includes("*")) return pattern === candidate
  return glob(pattern).test(candidate)
}

export function findRoute(routes: ResolvedRoute[], input: TaskInput) {
  const parentModel = `${input.parentModel.providerID}/${input.parentModel.modelID}`
  return routes.find(
    (route) =>
      (route.subagent === "*" || route.subagent === input.subagentType) &&
      route.parentModel.some((pattern) => matches(pattern, parentModel)),
  )
}

export const SubagentRouterPlugin: Plugin = async (_input: PluginInput, options?: PluginOptions) => {
  const resolved = loadOptions(options)
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task" || !input.task) return
      const route = findRoute(resolved.rules, input.task)
      if (!route) return
      output.model = route.model
    },
  }
}

export default { id: "subagent-router", server: SubagentRouterPlugin } satisfies PluginModule
