export * as CostLimitPlugin from "./cost-limit.js"

import type { Plugin } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"

const Budget = Schema.Struct({
  parent: Schema.optionalKey(Schema.Number),
  subagents: Schema.optionalKey(Schema.Number),
})
const Rule = Schema.Struct({ ...Budget.fields, model: Schema.String })
const Options = Schema.Struct({
  default: Schema.optionalKey(Budget),
  rules: Schema.optionalKey(Schema.Array(Rule)),
})
const escapePattern = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export function loadOptions(options: Record<string, unknown>) {
  const parsed = Schema.decodeUnknownSync(Options)(options)
  const validate = (budget: typeof Budget.Type, name: string) => {
    for (const field of ["parent", "subagents"] as const) {
      const value = budget[field]
      if (value !== undefined && (!Number.isFinite(value) || value <= 0))
        throw new Error(`Invalid cost-limit ${name}.${field}: expected positive finite dollars`)
    }
  }
  if (parsed.default) validate(parsed.default, "default")
  return {
    default: parsed.default,
    rules: (parsed.rules ?? []).map((rule, index) => {
      if (!rule.model) throw new Error(`Invalid cost-limit rule ${index}: model must be nonempty`)
      validate(rule, `rules[${index}]`)
      return {
        pattern: new RegExp(`^${rule.model.split("*").map(escapePattern).join(".*")}$`),
        parent: rule.parent,
        subagents: rule.subagents,
      }
    }),
  }
}

export function findLimits(options: ReturnType<typeof loadOptions>, model: string) {
  const rule = options.rules.findLast((item) => item.pattern.test(model))
  return rule
    ? {
        ...(rule.parent === undefined ? {} : { parent: rule.parent }),
        ...(rule.subagents === undefined ? {} : { subagents: rule.subagents }),
      }
    : (options.default ?? {})
}

export function configured(options: Record<string, unknown>): Plugin {
  return {
    id: "cost-limit",
    effect: (ctx) => {
      const limits = loadOptions(options)
      return ctx.session
        .hook("step.before", (event) =>
          Effect.sync(() => {
            if (event.first) return
            const match = findLimits(limits, `${event.rootModel.providerID}/${event.rootModel.id}`)
            if (match.parent !== undefined && event.cost.root >= match.parent) {
              event.continue = false
              event.reason = `Stopped: this prompt has spent $${event.cost.root.toFixed(2)} in this session, reaching the $${match.parent.toFixed(2)} limit. Send a new message to continue.`
              return
            }
            if (match.subagents !== undefined && event.cost.descendants >= match.subagents) {
              event.continue = false
              event.reason = `Stopped: this prompt has spent $${event.cost.descendants.toFixed(2)} on subagents, reaching the $${match.subagents.toFixed(2)} limit. Send a new message to continue.`
            }
          }),
        )
        .pipe(Effect.asVoid)
    },
  }
}
