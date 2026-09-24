export * as SubagentRouterPlugin from "./subagent-router.js"

import type { Plugin } from "@opencode/plugin/effect/plugin"
import { Effect, Predicate, Schema } from "effect"
import { Model } from "../model.js"

const Rule = Schema.Struct({
  subagent: Schema.String,
  parentModel: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  model: Schema.String,
  variant: Schema.optionalKey(Schema.String),
})
const Options = Schema.Struct({ rules: Schema.Array(Rule) })
const escapePattern = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export function loadOptions(options: Record<string, unknown>) {
  const rules = Schema.decodeUnknownSync(Options)(options).rules
  return rules.map((rule, index) => {
    if (
      !rule.subagent ||
      (Array.isArray(rule.parentModel)
        ? rule.parentModel.length === 0 || rule.parentModel.some((value) => !value)
        : !rule.parentModel)
    )
      throw new Error(`Invalid subagent-router rule ${index}: subagent and parentModel must be nonempty`)
    if (rule.variant === "") throw new Error(`Invalid subagent-router rule ${index}: variant must be nonempty`)
    let model: Model.Ref
    try {
      model = Model.Ref.parse(rule.model)
    } catch {
      throw new Error(`Invalid subagent-router rule ${index}: model must be provider/model`)
    }
    return {
      subagent: rule.subagent,
      parentModel: (typeof rule.parentModel === "string" ? [rule.parentModel] : rule.parentModel).map(
        (pattern) => new RegExp(`^${pattern.split("*").map(escapePattern).join(".*")}$`),
      ),
      model,
      variant: rule.variant,
    }
  })
}

export function findRoute(rules: ReturnType<typeof loadOptions>, input: { agent: string; parentModel: string }) {
  return rules.find(
    (rule) =>
      (rule.subagent === "*" || rule.subagent === input.agent) &&
      rule.parentModel.some((pattern) => pattern.test(input.parentModel)),
  )
}

export function configured(options: Record<string, unknown>): Plugin {
  return {
    id: "subagent-router",
    effect: (ctx) => {
      const rules = loadOptions(options)
      return ctx.tool
        .hook("execute.before", (event) =>
          Effect.gen(function* () {
            if (event.tool !== "subagent" || !Predicate.isObject(event.input)) return
            if (event.input.model || event.input.sessionID || typeof event.input.agent !== "string") return
            const session = yield* ctx.session.get({ sessionID: event.sessionID }).pipe(Effect.orDie)
            if (!session.model) return
            const route = findRoute(rules, {
              agent: event.input.agent,
              parentModel: `${session.model.providerID}/${session.model.id}`,
            })
            if (!route) return
            const model = (yield* ctx.model.list().pipe(Effect.orDie)).data.find(
              (model) => model.providerID === route.model.providerID && model.id === route.model.id,
            )
            const variant = model?.variants.some((variant) => variant.id === route.variant) ? route.variant : undefined
            event.input = {
              ...event.input,
              model: `${route.model.providerID}/${route.model.id}${variant ? `#${variant}` : ""}`,
            }
          }),
        )
        .pipe(Effect.asVoid)
    },
  }
}
