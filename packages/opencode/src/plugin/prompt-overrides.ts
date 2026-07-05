import path from "path"
import type { Plugin, PluginInput, PluginModule, PluginOptions } from "@opencode-ai/plugin"

type RawSource = {
  match?: unknown
  text?: unknown
  file?: unknown
}

export type ResolvedSource = {
  match: string
  content: string
}

export type ResolvedOptions = {
  model: ResolvedSource[]
  tool: Record<string, ResolvedSource[]>
}

export const BUILTIN_TOOL_IDS = new Set([
  "bash",
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "apply_patch",
  "task",
  "todowrite",
  "webfetch",
  "websearch",
  "skill",
  "question",
  "lsp",
  "plan_exit",
  "execute",
])

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function normalizeList(input: unknown, label: string): RawSource[] {
  const list = Array.isArray(input) ? input : [input]
  return list.map((item, index) => {
    if (!isRecord(item)) throw new Error(`${label}[${index}] must be an object`)
    return item
  })
}

async function resolveSource(input: RawSource, baseDir: string, label: string): Promise<ResolvedSource> {
  const hasText = typeof input.text === "string"
  const hasFile = typeof input.file === "string"
  if (hasText === hasFile) throw new Error(`${label} must define exactly one of text or file`)
  if (input.match !== undefined && typeof input.match !== "string") throw new Error(`${label}.match must be a string`)

  if (hasText) return { match: input.match ?? "*", content: input.text as string }

  const file = input.file as string
  const resolved = path.isAbsolute(file) ? file : path.resolve(baseDir, file)
  try {
    return { match: input.match ?? "*", content: await Bun.file(resolved).text() }
  } catch (cause) {
    throw new Error(`Failed to read prompt override file ${resolved}`, { cause })
  }
}

export async function loadOptions(raw: PluginOptions | undefined, baseDir: string): Promise<ResolvedOptions> {
  if (raw === undefined) return { model: [], tool: {} }
  if (!isRecord(raw)) throw new Error("prompt override plugin options must be an object")

  const model =
    raw.model === undefined
      ? []
      : await Promise.all(
          normalizeList(raw.model, "model").map((item, index) => resolveSource(item, baseDir, `model[${index}]`)),
        )
  const tool: Record<string, ResolvedSource[]> = {}

  if (raw.tool !== undefined) {
    if (!isRecord(raw.tool)) throw new Error("tool must be an object keyed by built-in tool id")
    for (const [toolID, value] of Object.entries(raw.tool)) {
      if (!BUILTIN_TOOL_IDS.has(toolID)) throw new Error(`Unknown built-in tool id: ${toolID}`)
      tool[toolID] = await Promise.all(
        normalizeList(value, `tool.${toolID}`).map((item, index) =>
          resolveSource(item, baseDir, `tool.${toolID}[${index}]`),
        ),
      )
    }
  }

  return { model, tool }
}

function glob(pattern: string) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`)
}

function matches(pattern: string, candidates: string[]) {
  if (pattern === "*") return true
  if (!pattern.includes("*")) return candidates.includes(pattern)
  const re = glob(pattern)
  return candidates.some((candidate) => re.test(candidate))
}

export function findReplacement(entries: ResolvedSource[], candidates: string[]) {
  return entries.find((entry) => matches(entry.match, candidates))
}

export function modelCandidates(model: { providerID: string; id: string; api: { id: string } }) {
  return [`${model.providerID}/${model.id}`, `${model.providerID}/${model.api.id}`, model.api.id]
}

export function toolCandidates(input: { providerID?: string; modelID?: string; apiModelID?: string }) {
  return [
    input.providerID && input.modelID ? `${input.providerID}/${input.modelID}` : undefined,
    input.providerID && input.apiModelID ? `${input.providerID}/${input.apiModelID}` : undefined,
    input.apiModelID,
  ].filter((item): item is string => item !== undefined)
}

export const PromptOverridesPlugin: Plugin = async (input: PluginInput, options?: PluginOptions) => {
  const resolved = await loadOptions(options, input.directory)
  return {
    "experimental.chat.system.transform": async (hookInput, output) => {
      if (!hookInput.agent || hookInput.hasAgentPrompt || !hookInput.baseSystem) return
      const replacement = findReplacement(resolved.model, modelCandidates(hookInput.model))
      if (!replacement) return
      if (!output.system[0]?.startsWith(hookInput.baseSystem)) return
      output.system[0] = replacement.content + output.system[0].slice(hookInput.baseSystem.length)
    },
    "tool.definition": async (hookInput, output) => {
      if (!BUILTIN_TOOL_IDS.has(hookInput.toolID)) return
      const entries = resolved.tool[hookInput.toolID]
      if (!entries) return
      const replacement = findReplacement(entries, toolCandidates(hookInput))
      if (!replacement) return
      output.description = replacement.content
    },
  }
}

export default { server: PromptOverridesPlugin } satisfies PluginModule
