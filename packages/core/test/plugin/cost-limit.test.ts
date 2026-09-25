import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { CostLimitPlugin } from "@opencode/core/plugin/cost-limit"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { it, testEffect } from "../lib/effect"
import { host } from "./host"

describe("cost-limit configured plugin", () => {
  it.effect("rejects malformed budgets and model patterns at activation", () =>
    Effect.sync(() => {
      const invalid = [
        [{ default: 1 }, "default"],
        [{ default: { parent: 0 } }, "parent"],
        [{ default: { subagents: -1 } }, "subagents"],
        [{ default: { parent: Infinity } }, "parent"],
        [{ default: { parent: "5" } }, "parent"],
        [{ rules: "bad" }, "rules"],
        [{ rules: [{}] }, "model"],
        [{ rules: [{ model: 2 }] }, "model"],
      ] as const
      for (const [options, field] of invalid) {
        expect(() => CostLimitPlugin.loadOptions(options)).toThrow(field)
        expect(() => CostLimitPlugin.configured(options).effect(host())).toThrow(field)
      }
    }),
  )

  it.effect("uses the last anchored wildcard match as a complete replacement for defaults", () =>
    Effect.sync(() => {
      const loaded = CostLimitPlugin.loadOptions({
        default: { parent: 5, subagents: 10 },
        rules: [
          { model: "test/*", parent: 8, subagents: 12 },
          { model: "test/large-*", subagents: 15 },
        ],
      })
      expect(CostLimitPlugin.findLimits(loaded, "test/large-opus")).toEqual({ subagents: 15 })
      expect(CostLimitPlugin.findLimits(loaded, "test/small")).toEqual({ parent: 8, subagents: 12 })
      expect(CostLimitPlugin.findLimits(loaded, "other/test/large-opus")).toEqual({ parent: 5, subagents: 10 })
      expect(CostLimitPlugin.findLimits(CostLimitPlugin.loadOptions({}), "other/model")).toEqual({})
      const literal = CostLimitPlugin.loadOptions({ rules: [{ model: "test/model+v2", parent: 3 }] })
      expect(CostLimitPlugin.findLimits(literal, "test/model+v2")).toEqual({ parent: 3 })
      expect(CostLimitPlugin.findLimits(literal, "test/modellv2")).toEqual({})
    }),
  )

  testEffect(AppNodeBuilder.build(LayerNode.group([PluginHooks.node]))).effect(
    "vetoes only after the first root Step at the matching limit",
    () =>
      Effect.gen(function* () {
        const hooks = yield* PluginHooks.Service
        yield* CostLimitPlugin.configured({ default: { parent: 5, subagents: 10 } }).effect(
          host({
            session: { hook: (name, callback) => hooks.register("session", name, callback) },
          }),
        )
        const base = {
          sessionID: Session.ID.make("ses_cost_policy"),
          rootID: Session.ID.make("ses_cost_policy"),
          agent: Agent.ID.make("build"),
          model: Model.Ref.parse("test/child"),
          rootModel: Model.Ref.parse("test/parent"),
          rootUserMessageID: SessionMessage.ID.make("msg_cost_policy"),
          step: 2,
          first: false,
        }
        const decide = (root: number, descendants: number, first = false) =>
          hooks.trigger("session", "step.before", {
            ...base,
            first,
            cost: { root, descendants, session: root },
            continue: true,
          })
        expect((yield* decide(5, 10, true)).continue).toBe(true)
        expect((yield* decide(4.99, 9.99)).continue).toBe(true)
        const parent = yield* decide(5, 10)
        expect(parent.continue).toBe(false)
        expect(parent.reason).toContain("$5.00")
        expect(parent.reason).toContain("this session")
        const child = yield* decide(1, 10.5)
        expect(child.continue).toBe(false)
        expect(child.reason).toContain("$10.50")
        expect(child.reason).toContain("subagents")
      }),
  )
})
