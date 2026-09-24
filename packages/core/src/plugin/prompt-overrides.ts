export * as PromptOverridesPlugin from "./prompt-overrides.js"

import type { Plugin } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect, Schema } from "effect"
import path from "path"
import { Model } from "../model.js"
import { SessionSystemPrompt } from "../session/system-prompt.js"

const Source = Schema.Struct({
  match: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  file: Schema.optionalKey(Schema.String),
})
const Sources = Schema.Union([Source, Schema.Array(Source)])
const Options = Schema.Struct({
  model: Schema.optionalKey(Sources),
  tool: Schema.optionalKey(Schema.Record(Schema.String, Sources)),
})
const builtins = new Set([
  "edit",
  "glob",
  "grep",
  "patch",
  "question",
  "read",
  "shell",
  "skill",
  "subagent",
  "webfetch",
  "websearch",
  "write",
])

type Replacement = { readonly match: string; readonly content: string }
export interface ResolvedOptions {
  readonly model: readonly Replacement[]
  readonly tool: Readonly<Record<string, readonly Replacement[]>>
}

export const loadOptions = Effect.fn("PromptOverridesPlugin.loadOptions")(function* (
  options: Record<string, unknown>,
  directory: string,
) {
  const parsed = yield* Schema.decodeUnknownEffect(Options)(options)
  if (Object.keys(options).some((key) => key !== "model" && key !== "tool"))
    return yield* Effect.fail(new Error("Invalid prompt-overrides option"))
  const tools = parsed.tool ?? {}
  if (Object.keys(tools).some((name) => !builtins.has(name)))
    return yield* Effect.fail(new Error("Invalid prompt-overrides tool ID"))
  const validEntry = (source: unknown) => {
    if (typeof source !== "object" || source === null || Array.isArray(source)) return false
    return Object.keys(source).every((key) => key === "match" || key === "text" || key === "file")
  }
  const validEntries = (sources: unknown) => (Array.isArray(sources) ? sources : [sources]).every(validEntry)
  const rawTool = options.tool
  if (
    (options.model !== undefined && !validEntries(options.model)) ||
    (rawTool !== undefined &&
      typeof rawTool === "object" &&
      rawTool !== null &&
      !Array.isArray(rawTool) &&
      !Object.values(rawTool).every(validEntries))
  )
    return yield* Effect.fail(new Error("Invalid prompt override entry"))
  const resolve = (sources: typeof Sources.Type | undefined) =>
    Effect.forEach(sources === undefined ? [] : Array.isArray(sources) ? sources : [sources], (source) =>
      Effect.gen(function* () {
        if (source.text !== undefined && source.file !== undefined)
          return yield* Effect.fail(new Error("Prompt override requires exactly one of text or file"))
        if (source.match === "" || source.file === "")
          return yield* Effect.fail(new Error("Prompt override match and file must be nonempty"))
        if (source.text === undefined && source.file === undefined)
          return yield* Effect.fail(new Error("Prompt override requires text or file"))
        const content =
          source.file === undefined
            ? source.text
            : yield* Effect.tryPromise({
                try: () => Bun.file(path.resolve(directory, source.file)).text(),
                catch: () => new Error(`Cannot read prompt override file: ${source.file}`),
              })
        return { match: source.match ?? "*", content }
      }),
    )
  return {
    model: yield* resolve(parsed.model),
    tool: Object.fromEntries(
      yield* Effect.forEach(Object.entries(tools), ([name, sources]) =>
        resolve(sources).pipe(Effect.map((values) => [name, values] as const)),
      ),
    ),
  }
})

export function findReplacement(entries: readonly Replacement[], candidates: readonly string[]) {
  return entries.find((entry) =>
    candidates.some((candidate) =>
      new RegExp(
        `^${entry.match
          .split("*")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      ).test(candidate),
    ),
  )
}

function candidates(ref: Model.Ref, modelID?: string) {
  return [`${ref.providerID}/${ref.id}`, `${ref.providerID}/${modelID ?? ref.id}`, modelID ?? ref.id]
}

export function configured(options: ResolvedOptions): Plugin {
  return {
    id: "prompt-overrides",
    effect: Effect.fn("PromptOverridesPlugin.configured")(function* (ctx) {
      const prompt = (event: SessionHooks["context"]) =>
        Effect.gen(function* () {
          const agent = (yield* ctx.agent.get({ agentID: event.agent }).pipe(Effect.orDie)).data
          if (agent.system || !event.system[0]) return
          const model = (yield* ctx.model.list().pipe(Effect.orDie)).data.find(
            (item) => item.providerID === event.model.providerID && item.id === event.model.id,
          )
          const replacement = findReplacement(options.model, candidates(event.model, model?.modelID))
          if (!replacement) return
          event.system[0] = {
            ...event.system[0],
            text: SessionSystemPrompt.render(replacement.content, Object.keys(event.tools)),
          }
        })
      yield* ctx.session.hook("context", prompt)
      yield* ctx.session.hook("compaction", prompt)
      yield* ctx.session.hook("generate", prompt)
      yield* ctx.tool.hook("definition", (event) =>
        Effect.gen(function* () {
          if (!event.builtin) return
          const model = (yield* ctx.model.list().pipe(Effect.orDie)).data.find(
            (item) => item.providerID === event.model.providerID && item.id === event.model.id,
          )
          const replacement = findReplacement(options.tool[event.toolID] ?? [], candidates(event.model, model?.modelID))
          if (replacement) event.description = replacement.content
        }),
      )
    }),
  }
}
