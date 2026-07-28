import { Effect } from "effect"
import { effectCmd } from "../../effect-cmd"

export const PromptCommand = effectCmd({
  command: "prompt",
  describe: "show the initial model request without sending a prompt",
  builder: (yargs) =>
    yargs
      .option("provider", { type: "string", describe: "provider ID to use" })
      .option("model", { type: "string", describe: "model ID to use" })
      .option("agent", { type: "string", describe: "agent to use" }),
  handler: (args) =>
    Effect.gen(function* () {
      const { debugPrompt } = yield* Effect.promise(() => import("./prompt.handler"))
      return yield* debugPrompt(args)
    }),
})
